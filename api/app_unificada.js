// api/app_unificada.js
//
// Backend de la app unica: login por cedula (una sola vez, sin elegir
// rol de antemano), deteccion de todos los roles que esa cedula tenga
// en el club, y el menu armado a partir del catalogo de pantallas.
//
// Diseño clave: las tablas jugadores/representantes/entrenadores NO
// se tocan ni se fusionan -- se consultan las 3 por cedula en cada
// login, y los roles se resuelven en vivo (nunca se cachean en la
// sesion) para que un cambio de rol se refleje de inmediato.

const { obtenerEstadoReloj, obtenerJugadoresEnCancha, iniciarReloj, pausarReloj, avanzarPeriodo, ajustarReloj, toggleJugadorCancha, minutosJugadosPartido } = require('./_reloj_partido');
const bcrypt = require('bcryptjs');
const {
  listarRubros, crearRubro, editarRubro, toggleRubro,
  listarMovimientosClub, registrarMovimientoClub, eliminarMovimientoClub,
  verMensualidadJugadorAdmin, dashboardMorososMensualidad,
} = require('./_admin_finanzas_club');
const { getPool } = require('./_db');

const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

async function resolverSesion(pool, token) {
  const r = await pool.query(
    `SELECT s.cedula FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_app s ON s.token = $1 LIMIT 1`,
    [token || '']
  );
  return r.rows[0] && r.rows[0].cedula;
}

async function crearSesion(pool, cedula) {
  const r = await pool.query(
    `INSERT INTO sport_control.sesiones_app (cedula, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
    [cedula]
  );
  return r.rows[0].token;
}

// Busca la cedula en las 3 tablas de roles y arma el resumen de que
// roles tiene esa persona en el club. Esta es LA funcion central del
// login unificado -- todo lo demas se apoya en ella.
async function detectarRoles(pool, cedula) {
  const jugador = await pool.query(
    `SELECT id, nombres, apellidos, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.jugadores WHERE cedula = $1 AND estado = 'activo'`,
    [cedula]
  );
  const representante = await pool.query(
    `SELECT id, nombres, apellidos, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.representantes WHERE cedula = $1`,
    [cedula]
  );
  const entrenador = await pool.query(
    `SELECT id, nombres, apellidos, rol, alias, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.entrenadores WHERE cedula = $1 AND activo = true`,
    [cedula]
  );
  const planillero = await pool.query(
    `SELECT id, nombres, apellidos, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.planilleros WHERE cedula = $1 AND activo = true`,
    [cedula]
  );
  const financiero = await pool.query(
    `SELECT id, nombres, apellidos, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.financieros WHERE cedula = $1 AND activo = true`,
    [cedula]
  );

  const roles = [];
  if (jugador.rows[0]) roles.push('jugador');
  if (representante.rows[0]) roles.push('representante');
  if (entrenador.rows[0]) {
    roles.push('entrenador');
    if (entrenador.rows[0].rol === 'director') roles.push('director');
  }
  if (planillero.rows[0]) roles.push('planillero');
  if (financiero.rows[0]) roles.push('financiero');

  return {
    encontrado: roles.length > 0,
    roles,
    jugador: jugador.rows[0] || null,
    representante: representante.rows[0] || null,
    entrenador: entrenador.rows[0] || null,
    planillero: planillero.rows[0] || null,
    financiero: financiero.rows[0] || null,
    // nombre para el saludo: el primero que se encuentre disponible
    nombres: (jugador.rows[0] || representante.rows[0] || entrenador.rows[0] || planillero.rows[0] || financiero.rows[0] || {}).nombres,
  };
}

// La clave es UNA sola por persona, aunque tenga varios roles. Si ya
// existe un hash en cualquiera de las tablas, ese es "el oficial".
function encontrarClaveExistente(info) {
  for (const registro of [info.representante, info.entrenador, info.jugador, info.planillero, info.financiero]) {
    if (registro && registro.clave_hash) return registro;
  }
  return null;
}

async function loginUnificado(pool, body) {
  const cedula = String(body.cedula || '').trim();
  if (!cedula) return { success: false, error: 'Ingresa tu cédula.' };

  const info = await detectarRoles(pool, cedula);
  if (!info.encontrado) return { success: true, data: { registrado: false } };

  const claveExistente = encontrarClaveExistente(info);
  if (claveExistente && claveExistente.bloqueado_hasta && new Date(claveExistente.bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }

  return { success: true, data: { registrado: true, tieneClave: !!claveExistente, nombres: info.nombres, roles: info.roles } };
}

async function crearClaveUnificada(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();
  if (!/^\d{6}$/.test(clave)) return { success: false, error: 'La clave debe ser de exactamente 6 números.' };

  const info = await detectarRoles(pool, cedula);
  if (!info.encontrado) return { success: false, error: 'No se encontró esa cédula.' };
  if (encontrarClaveExistente(info)) return { success: false, error: 'Ya tienes una clave creada. Ingrésala para entrar.' };

  const hash = await bcrypt.hash(clave, 10);
  // Se replica el mismo hash a TODAS las tablas donde esta cedula
  // tenga un registro -- una sola clave sirve para todos sus roles.
  if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.jugador.id]);
  if (info.representante) await pool.query(`UPDATE sport_control.representantes SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.representante.id]);
  if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.entrenador.id]);
  if (info.planillero) await pool.query(`UPDATE sport_control.planilleros SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.planillero.id]);
  if (info.financiero) await pool.query(`UPDATE sport_control.financieros SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.financiero.id]);

  const token = await crearSesion(pool, cedula);
  return { success: true, data: { token, nombres: info.nombres, roles: info.roles } };
}

async function verificarClaveUnificada(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();

  const info = await detectarRoles(pool, cedula);
  if (!info.encontrado) return { success: false, error: 'No se encontró esa cédula.' };

  const registroClave = encontrarClaveExistente(info);
  if (!registroClave) return { success: false, error: 'Todavía no tienes una clave creada.' };

  if (registroClave.bloqueado_hasta && new Date(registroClave.bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }
  if (registroClave.debe_cambiar_clave && registroClave.clave_reset_expira && new Date(registroClave.clave_reset_expira) < new Date()) {
    return { success: false, error: 'Tu clave temporal ya venció. Pídele al Admin que te genere una nueva.' };
  }

  const coincide = await bcrypt.compare(clave, registroClave.clave_hash);

  // Los intentos fallidos y el bloqueo se llevan por persona (cedula),
  // asi que se actualizan en TODAS las tablas donde tenga registro,
  // para que quede consistente sin importar por cual rol entro.
  const actualizarIntentos = async (intentos, bloqueadoHasta) => {
    if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.jugador.id]);
    if (info.representante) await pool.query(`UPDATE sport_control.representantes SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.representante.id]);
    if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.entrenador.id]);
    if (info.planillero) await pool.query(`UPDATE sport_control.planilleros SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.planillero.id]);
    if (info.financiero) await pool.query(`UPDATE sport_control.financieros SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.financiero.id]);
  };

  if (!coincide) {
    const intentos = registroClave.intentos_fallidos + 1;
    if (intentos >= MAX_INTENTOS) {
      const bloqueadoHasta = new Date(Date.now() + MINUTOS_BLOQUEO * 60000);
      await actualizarIntentos(0, bloqueadoHasta);
      return { success: false, error: `Demasiados intentos fallidos. Espera ${MINUTOS_BLOQUEO} minutos o pide al Admin que te resetee la clave.` };
    }
    await actualizarIntentos(intentos, null);
    return { success: false, error: 'Clave incorrecta.' };
  }

  await actualizarIntentos(0, null);
  const token = await crearSesion(pool, cedula);
  return { success: true, data: { token, nombres: info.nombres, roles: info.roles, debeCambiarClave: registroClave.debe_cambiar_clave } };
}

async function cambiarClaveUnificada(pool, cedula, body) {
  const claveActual = String(body.claveActual || '').trim();
  const claveNueva = String(body.claveNueva || '').trim();
  if (!/^\d{6}$/.test(claveNueva)) return { success: false, error: 'La clave nueva debe ser de exactamente 6 números.' };

  const info = await detectarRoles(pool, cedula);
  const registroClave = encontrarClaveExistente(info);
  if (!registroClave || !(await bcrypt.compare(claveActual, registroClave.clave_hash))) {
    return { success: false, error: 'Tu clave actual no es correcta.' };
  }

  const hash = await bcrypt.hash(claveNueva, 10);
  if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.jugador.id]);
  if (info.representante) await pool.query(`UPDATE sport_control.representantes SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.representante.id]);
  if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.entrenador.id]);
  if (info.planillero) await pool.query(`UPDATE sport_control.planilleros SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.planillero.id]);
  if (info.financiero) await pool.query(`UPDATE sport_control.financieros SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.financiero.id]);

  return { success: true };
}

// Devuelve los roles + IDs vigentes de la sesion actual (se resuelve
// en vivo, nunca se guarda cacheado) y el menu que le corresponde.
async function obtenerSesionYMenu(pool, cedula) {
  const info = await detectarRoles(pool, cedula);
  const roles = info.roles;
  const menu = await listarPantallasParaRoles(pool, roles);

  // Se generan tokens internos en las tablas de sesion de CADA app
  // original -- asi las pantallas portadas pueden llamar directo a
  // /api/jugador, /api/representante, /api/entrenador reutilizando
  // el 100% de su logica existente, sin duplicar nada.
  let jugadorToken = null, representanteToken = null, entrenadorToken = null;
  if (info.jugador) {
    const r = await pool.query(
      `INSERT INTO sport_control.sesiones_pwa (jugador_id, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
      [info.jugador.id]
    );
    jugadorToken = r.rows[0].token;
  }
  if (info.representante) {
    const r = await pool.query(
      `INSERT INTO sport_control.sesiones_representante (representante_id, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
      [info.representante.id]
    );
    representanteToken = r.rows[0].token;
  }
  if (info.entrenador) {
    const r = await pool.query(
      `INSERT INTO sport_control.sesiones_entrenador (entrenador_id, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
      [info.entrenador.id]
    );
    entrenadorToken = r.rows[0].token;
  }

  return {
    success: true,
    data: {
      roles,
      jugadorId: info.jugador ? info.jugador.id : null,
      representanteId: info.representante ? info.representante.id : null,
      entrenadorId: info.entrenador ? info.entrenador.id : null,
      planilleroId: info.planillero ? info.planillero.id : null,
      financieroId: info.financiero ? info.financiero.id : null,
      jugadorToken, representanteToken, entrenadorToken,
      nombres: info.nombres,
      menu: menu.data,
    },
  };
}

async function obtenerPerfilUnificado(pool, cedula) {
  const info = await detectarRoles(pool, cedula);
  const registro = info.representante || info.entrenador || info.jugador;
  const telRow = await pool.query(
    `SELECT telefono FROM sport_control.representantes WHERE cedula = $1
     UNION ALL SELECT telefono FROM sport_control.entrenadores WHERE cedula = $1
     UNION ALL SELECT telefono FROM sport_control.jugadores WHERE cedula = $1
     UNION ALL SELECT telefono FROM sport_control.planilleros WHERE cedula = $1
     UNION ALL SELECT telefono FROM sport_control.financieros WHERE cedula = $1
     LIMIT 1`,
    [cedula]
  );
  let representantesHabilitado = false;
  if (info.jugador) {
    const cfg = await pool.query(`SELECT representantes_habilitado FROM sport_control.configuracion_club WHERE id = 1`);
    representantesHabilitado = !!(cfg.rows[0] && cfg.rows[0].representantes_habilitado);
  }
  return {
    success: true,
    data: {
      cedula,
      nombres: registro.nombres,
      apellidos: registro.apellidos,
      telefono: telRow.rows[0] ? telRow.rows[0].telefono : null,
      roles: info.roles,
      representantesHabilitado,
      aliasEntrenador: info.entrenador ? info.entrenador.alias : null,
    },
  };
}

async function actualizarPerfilUnificado(pool, cedula, body) {
  const { nombres, apellidos, telefono, aliasEntrenador } = body;
  const info = await detectarRoles(pool, cedula);
  if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET nombres = $1, apellidos = $2 WHERE id = $3`, [nombres, apellidos, info.jugador.id]);
  if (info.representante) await pool.query(`UPDATE sport_control.representantes SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [nombres, apellidos, telefono || null, info.representante.id]);
  if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET nombres = $1, apellidos = $2, telefono = $3, alias = $4 WHERE id = $5`, [nombres, apellidos, telefono || null, aliasEntrenador || null, info.entrenador.id]);
  if (info.planillero) await pool.query(`UPDATE sport_control.planilleros SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [nombres, apellidos, telefono || null, info.planillero.id]);
  if (info.financiero) await pool.query(`UPDATE sport_control.financieros SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [nombres, apellidos, telefono || null, info.financiero.id]);
  return { success: true };
}

async function listarPantallasParaRoles(pool, roles) {
  if (!roles || roles.length === 0) return { success: true, data: [] };
  const r = await pool.query(
    `SELECT DISTINCT p.id, p.clave, p.etiqueta, p.icono, p.archivo_pantalla AS "archivoPantalla", p.orden
     FROM sport_control.pantallas_menu p
     JOIN sport_control.pantalla_rol pr ON pr.pantalla_id = p.id
     WHERE p.activa = true AND pr.habilitado = true AND pr.rol = ANY($1::text[])
     ORDER BY p.orden ASC`,
    [roles]
  );
  return { success: true, data: r.rows };
}

/* ---------- Planillero: captura de estadisticas en vivo ---------- */
async function listarPartidosActivosPlanillero(pool) {
  const r = await pool.query(
    `SELECT p.id, p.alias, p.fecha, p.hora, p.lugar, p.estado, p.marcador_propio, p.marcador_rival, p.rival_nombre,
       d.nombre AS "disciplinaNombre", d.icono AS "disciplinaIcono"
     FROM sport_control.partidos p
     LEFT JOIN sport_control.disciplinas d ON d.id = p.disciplina_id
     WHERE p.estado IN ('confirmando', 'en_juego', 'cerrado')
     ORDER BY p.fecha ASC, p.hora ASC LIMIT 20`
  );
  return { success: true, data: r.rows };
}

async function abrirCapturaPartido(pool, body) {
  const { partidoId } = body;
  const partido = await pool.query(
    `SELECT p.id, p.alias, p.rival_nombre, p.marcador_propio, p.marcador_rival, p.disciplina_id AS "disciplinaId", p.evento_id AS "eventoId",
       p.faltas_equipo_propio AS "faltasPropio", p.faltas_equipo_rival AS "faltasRival"
     FROM sport_control.partidos p WHERE p.id = $1`,
    [partidoId]
  );
  if (!partido.rows[0]) return { success: false, error: 'Partido no encontrado.' };
  const p = partido.rows[0];

  // Roster: jugadores confirmados, con su numero de camiseta -- el del
  // evento (si el partido pertenece a uno) tiene prioridad sobre el
  // numero de base del jugador.
  const jugadores = await pool.query(
    `SELECT j.id, j.nombres, j.apellidos, COALESCE(j.alias, j.nombres) AS "nombreCorto",
       COALESCE(ecj.numero_camiseta, j.numero_camiseta) AS "numeroCamiseta"
     FROM sport_control.confirmaciones_partido cp
     JOIN sport_control.jugadores j ON j.id = cp.jugador_id
     LEFT JOIN sport_control.evento_cuota_jugador ecj ON ecj.jugador_id = j.id AND ecj.evento_id = $2
     WHERE cp.partido_id = $1 AND cp.estado = 'confirmado'
     ORDER BY COALESCE(ecj.numero_camiseta, j.numero_camiseta, '999') ::text, j.nombres`,
    [partidoId, p.eventoId]
  );

  // Tipos de estadistica activos para la disciplina de este partido
  // (nivel jugador -- las de nivel equipo no aplican a este flujo de
  // "toco jugador"). Si el partido no tiene disciplina asignada (no
  // deberia pasar, pero por seguridad de cara a un partido en vivo no
  // se puede dejar al planillero sin botones), se usa la disciplina
  // activa por defecto del club como respaldo.
  let disciplinaIdParaTipos = p.disciplinaId;
  if (!disciplinaIdParaTipos) {
    const activas = await pool.query(`SELECT id FROM sport_control.disciplinas WHERE activo = true ORDER BY id LIMIT 1`);
    disciplinaIdParaTipos = activas.rows[0] ? activas.rows[0].id : null;
  }
  const tipos = await pool.query(
    `SELECT id, nombre, clave, puntos FROM sport_control.tipos_estadistica
     WHERE disciplina_id = $1 AND nivel = 'jugador' AND activo = true ORDER BY orden, nombre`,
    [disciplinaIdParaTipos]
  );

  // Bitacora reciente -- para reconstruir el estado si el planillero
  // sale de la app o se queda sin bateria y vuelve a entrar.
  const log = await pool.query(
    `SELECT l.id, l.jugador_id AS "jugadorId", l.tipo_estadistica_id AS "tipoEstadisticaId", l.es_rival AS "esRival", l.puntos, l.creado_en AS "creadoEn",
       (j.nombres || ' ' || j.apellidos) AS "jugadorNombre", t.nombre AS "tipoNombre"
     FROM sport_control.partido_stats_log l
     LEFT JOIN sport_control.jugadores j ON j.id = l.jugador_id
     LEFT JOIN sport_control.tipos_estadistica t ON t.id = l.tipo_estadistica_id
     WHERE l.partido_id = $1 ORDER BY l.creado_en DESC LIMIT 500`,
    [partidoId]
  );

  const rivalFaltas = await pool.query(
    `SELECT numero_rival AS numero, faltas FROM sport_control.partido_rival_faltas WHERE partido_id = $1 ORDER BY numero_rival`,
    [partidoId]
  );

  const reloj = await obtenerEstadoReloj(pool, partidoId);
  const enCanchaIds = await obtenerJugadoresEnCancha(pool, partidoId);
  const minutosPorJugador = await minutosJugadosPartido(pool, partidoId);
  const cambiosLog = await pool.query(
    `SELECT pcl.id, pcl.jugador_id AS "jugadorId", COALESCE(j.alias, j.nombres) AS "nombreCorto", pcl.entro, pcl.periodo, pcl.segundos_reloj AS "segundosReloj", pcl.creado_en AS "creadoEn"
     FROM sport_control.partido_cambios_log pcl
     JOIN sport_control.jugadores j ON j.id = pcl.jugador_id
     WHERE pcl.partido_id = $1 ORDER BY pcl.creado_en DESC LIMIT 100`,
    [partidoId]
  );

  return {
    success: true,
    data: {
      partido: p,
      jugadores: jugadores.rows.map((j) => ({ ...j, enCancha: enCanchaIds.includes(j.id), segundosJugados: minutosPorJugador.get(j.id) || 0 })),
      tipos: tipos.rows,
      log: log.rows,
      rivalFaltas: rivalFaltas.rows,
      reloj,
      cambiosLog: cambiosLog.rows,
    },
  };
}

// Registro de un evento de captura en UNA sola consulta (antes eran 5
// viajes seguidos a la base). Es atomica (todo o nada) e idempotente:
// si el celular reintenta el mismo envio por mala señal, el `clienteId`
// evita que se cuente dos veces.
async function registrarEventoPartido(pool, planilleroId, body) {
  const { partidoId, jugadorId, tipoEstadisticaId, esRival, puntos, clienteId } = body;
  const puntosNum = Number(puntos) || 0;
  const rival = !!esRival;
  const jug = rival ? null : (jugadorId || null);
  const tipo = rival ? null : (tipoEstadisticaId || null);

  const r = await pool.query(
    `WITH nuevo AS (
       INSERT INTO sport_control.partido_stats_log (partido_id, jugador_id, tipo_estadistica_id, es_rival, puntos, planillero_id, cliente_id)
       VALUES ($1::int, $2::int, $3::int, $4::boolean, $5::int, $6::int, $7::varchar)
       ON CONFLICT (cliente_id) DO NOTHING
       RETURNING id, creado_en
     ),
     es_falta AS (
       SELECT (nombre ~* 'falta') AS v FROM sport_control.tipos_estadistica WHERE id = $3::int
     ),
     stat AS (
       INSERT INTO sport_control.partido_estadisticas (partido_id, tipo_estadistica_id, jugador_id, valor, actualizado_en)
       SELECT $1::int, $3::int, $2::int, 1, NOW()
       WHERE EXISTS (SELECT 1 FROM nuevo) AND $4::boolean = false AND $2::int IS NOT NULL AND $3::int IS NOT NULL
       ON CONFLICT (partido_id, tipo_estadistica_id, jugador_id)
       DO UPDATE SET valor = sport_control.partido_estadisticas.valor + 1, actualizado_en = NOW()
       RETURNING 1
     ),
     marcador AS (
       UPDATE sport_control.partidos SET
         marcador_propio = CASE WHEN $4::boolean = false AND $5::int > 0 THEN COALESCE(marcador_propio, 0) + $5::int ELSE marcador_propio END,
         marcador_rival = CASE WHEN $4::boolean = true THEN COALESCE(marcador_rival, 0) + $5::int ELSE marcador_rival END,
         faltas_equipo_propio = CASE WHEN $4::boolean = false AND $2::int IS NOT NULL AND COALESCE((SELECT v FROM es_falta), false)
                                     THEN faltas_equipo_propio + 1 ELSE faltas_equipo_propio END
       WHERE id = $1::int AND EXISTS (SELECT 1 FROM nuevo)
       RETURNING faltas_equipo_propio
     )
     SELECT
       COALESCE((SELECT id FROM nuevo), (SELECT id FROM sport_control.partido_stats_log WHERE cliente_id = $7::varchar)) AS id,
       COALESCE((SELECT creado_en FROM nuevo), (SELECT creado_en FROM sport_control.partido_stats_log WHERE cliente_id = $7::varchar)) AS "creadoEn",
       COALESCE((SELECT faltas_equipo_propio FROM marcador), (SELECT faltas_equipo_propio FROM sport_control.partidos WHERE id = $1::int)) AS "faltasPropio"`,
    [partidoId, jug, tipo, rival, puntosNum, planilleroId, clienteId || null]
  );
  const row = r.rows[0];
  return { success: true, data: { id: row.id, creadoEn: row.creadoEn, faltasPropio: row.faltasPropio } };
}

// Falta de un jugador rival identificado por su numero de camiseta.
// delta = +1 (falta) o -1 (correccion en modo edicion). Tambien mueve el
// contador de faltas de equipo del rival. Idempotente por clienteId.
async function registrarFaltaJugadorRival(pool, body) {
  const { partidoId, clienteId } = body;
  const numero = String(body.numeroRival || '').replace('#', '').trim().slice(0, 4);
  const delta = Number(body.delta) < 0 ? -1 : 1;
  if (!numero) return { success: false, error: 'Falta el número del rival.' };

  const r = await pool.query(
    `WITH op AS (
       INSERT INTO sport_control.captura_operaciones (cliente_id) VALUES (COALESCE($1::varchar, gen_random_uuid()::varchar))
       ON CONFLICT DO NOTHING RETURNING 1
     ),
     previo AS (
       SELECT COALESCE((SELECT faltas FROM sport_control.partido_rival_faltas WHERE partido_id = $2::int AND numero_rival = $3::varchar), 0) AS n
     ),
     rf AS (
       INSERT INTO sport_control.partido_rival_faltas (partido_id, numero_rival, faltas)
       SELECT $2::int, $3::varchar, GREATEST(0, $4::int) WHERE EXISTS (SELECT 1 FROM op)
       ON CONFLICT (partido_id, numero_rival)
       DO UPDATE SET faltas = GREATEST(0, sport_control.partido_rival_faltas.faltas + $4::int)
       RETURNING faltas
     ),
     equipo AS (
       UPDATE sport_control.partidos SET faltas_equipo_rival = GREATEST(0, faltas_equipo_rival +
         CASE WHEN $4::int < 0 AND (SELECT n FROM previo) = 0 THEN 0 ELSE $4::int END)
       WHERE id = $2::int AND EXISTS (SELECT 1 FROM op)
       RETURNING faltas_equipo_rival
     )
     SELECT COALESCE((SELECT faltas FROM rf), (SELECT n FROM previo)) AS faltas,
            COALESCE((SELECT faltas_equipo_rival FROM equipo), (SELECT faltas_equipo_rival FROM sport_control.partidos WHERE id = $2::int)) AS "faltasRival"`,
    [clienteId || null, partidoId, numero, delta]
  );
  return { success: true, data: { numero, faltas: r.rows[0].faltas, faltasRival: r.rows[0].faltasRival } };
}

// Falta del equipo rival sin numero (cuando no se sabe quien fue). Idempotente.
async function registrarFaltaEquipoRival(pool, body) {
  const r = await pool.query(
    `WITH op AS (
       INSERT INTO sport_control.captura_operaciones (cliente_id) VALUES (COALESCE($1::varchar, gen_random_uuid()::varchar))
       ON CONFLICT DO NOTHING RETURNING 1
     ),
     u AS (
       UPDATE sport_control.partidos SET faltas_equipo_rival = faltas_equipo_rival + 1
       WHERE id = $2::int AND EXISTS (SELECT 1 FROM op) RETURNING faltas_equipo_rival
     )
     SELECT COALESCE((SELECT faltas_equipo_rival FROM u), (SELECT faltas_equipo_rival FROM sport_control.partidos WHERE id = $2::int)) AS "faltasRival"`,
    [body.clienteId || null, body.partidoId]
  );
  return { success: true, data: { faltasRival: r.rows[0].faltasRival } };
}

// Sesion + id de planillero en UN solo viaje (antes: resolverSesion +
// detectarRoles con 5 consultas solo para sacar este id).
async function resolverSesionConPlanillero(pool, token) {
  const r = await pool.query(
    `SELECT s.cedula,
            (SELECT pl.id FROM sport_control.planilleros pl WHERE pl.cedula = s.cedula AND pl.activo = true LIMIT 1) AS "planilleroId"
     FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_app s ON s.token = $1 LIMIT 1`,
    [token || '']
  );
  return r.rows[0] || {};
}

async function editarEventoPartido(pool, body) {
  const { logId, jugadorId, tipoEstadisticaId } = body;
  const log = await pool.query(`SELECT * FROM sport_control.partido_stats_log WHERE id = $1`, [logId]);
  if (!log.rows[0]) return { success: false, error: 'Ese registro ya no existe.' };
  const l = log.rows[0];
  if (l.es_rival) return { success: false, error: 'Los puntos del rival se corrigen borrando el registro.' };

  // Revertir lo viejo
  if (l.puntos > 0) {
    await pool.query(`UPDATE sport_control.partidos SET marcador_propio = GREATEST(0, COALESCE(marcador_propio, 0) - $1) WHERE id = $2`, [l.puntos, l.partido_id]);
  }
  let faltasPropio = null;
  if (l.jugador_id && l.tipo_estadistica_id) {
    await pool.query(
      `UPDATE sport_control.partido_estadisticas SET valor = GREATEST(0, valor - 1) WHERE partido_id = $1 AND jugador_id = $2 AND tipo_estadistica_id = $3`,
      [l.partido_id, l.jugador_id, l.tipo_estadistica_id]
    );
    const tipoViejo = await pool.query(`SELECT nombre FROM sport_control.tipos_estadistica WHERE id = $1`, [l.tipo_estadistica_id]);
    if (tipoViejo.rows[0] && /falta/i.test(tipoViejo.rows[0].nombre)) {
      const upd = await pool.query(`UPDATE sport_control.partidos SET faltas_equipo_propio = GREATEST(0, faltas_equipo_propio - 1) WHERE id = $1 RETURNING faltas_equipo_propio`, [l.partido_id]);
      faltasPropio = upd.rows[0].faltas_equipo_propio;
    }
  }

  // Aplicar lo nuevo
  const tipo = await pool.query(`SELECT nombre, puntos FROM sport_control.tipos_estadistica WHERE id = $1`, [tipoEstadisticaId]);
  if (!tipo.rows[0]) return { success: false, error: 'Tipo de estadística no válido.' };
  const nuevosPuntos = tipo.rows[0].puntos;

  await pool.query(`UPDATE sport_control.partido_stats_log SET jugador_id = $1, tipo_estadistica_id = $2, puntos = $3 WHERE id = $4`, [jugadorId, tipoEstadisticaId, nuevosPuntos, logId]);

  if (nuevosPuntos > 0) {
    await pool.query(`UPDATE sport_control.partidos SET marcador_propio = COALESCE(marcador_propio, 0) + $1 WHERE id = $2`, [nuevosPuntos, l.partido_id]);
  }
  await pool.query(
    `INSERT INTO sport_control.partido_estadisticas (partido_id, tipo_estadistica_id, jugador_id, valor, actualizado_en)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (partido_id, tipo_estadistica_id, jugador_id) DO UPDATE SET valor = sport_control.partido_estadisticas.valor + 1, actualizado_en = NOW()`,
    [l.partido_id, tipoEstadisticaId, jugadorId]
  );
  if (/falta/i.test(tipo.rows[0].nombre)) {
    const upd2 = await pool.query(`UPDATE sport_control.partidos SET faltas_equipo_propio = faltas_equipo_propio + 1 WHERE id = $1 RETURNING faltas_equipo_propio`, [l.partido_id]);
    faltasPropio = upd2.rows[0].faltas_equipo_propio;
  }

  // Devuelve el partido actualizado para refrescar el marcador en pantalla
  const partido = await pool.query(`SELECT marcador_propio, marcador_rival FROM sport_control.partidos WHERE id = $1`, [l.partido_id]);
  const jugador = await pool.query(`SELECT nombres || ' ' || apellidos AS nombre FROM sport_control.jugadores WHERE id = $1`, [jugadorId]);
  return {
    success: true,
    data: {
      marcadorPropio: partido.rows[0].marcador_propio,
      marcadorRival: partido.rows[0].marcador_rival,
      puntos: nuevosPuntos,
      jugadorNombre: jugador.rows[0] ? jugador.rows[0].nombre : '',
      tipoNombre: tipo.rows[0].nombre,
      faltasPropio,
    },
  };
}

async function eliminarEventoPartido(pool, body) {
  const { logId } = body;
  const log = await pool.query(`SELECT * FROM sport_control.partido_stats_log WHERE id = $1`, [logId]);
  if (!log.rows[0]) return { success: false, error: 'Ese registro ya no existe.' };
  const l = log.rows[0];

  let faltasPropio = null;
  if (l.es_rival) {
    await pool.query(`UPDATE sport_control.partidos SET marcador_rival = GREATEST(0, COALESCE(marcador_rival, 0) - $1) WHERE id = $2`, [l.puntos, l.partido_id]);
  } else {
    if (l.puntos > 0) {
      await pool.query(`UPDATE sport_control.partidos SET marcador_propio = GREATEST(0, COALESCE(marcador_propio, 0) - $1) WHERE id = $2`, [l.puntos, l.partido_id]);
    }
    if (l.jugador_id && l.tipo_estadistica_id) {
      await pool.query(
        `UPDATE sport_control.partido_estadisticas SET valor = GREATEST(0, valor - 1)
         WHERE partido_id = $1 AND jugador_id = $2 AND tipo_estadistica_id = $3`,
        [l.partido_id, l.jugador_id, l.tipo_estadistica_id]
      );
      const tipo = await pool.query(`SELECT nombre FROM sport_control.tipos_estadistica WHERE id = $1`, [l.tipo_estadistica_id]);
      if (tipo.rows[0] && /falta/i.test(tipo.rows[0].nombre)) {
        const upd = await pool.query(`UPDATE sport_control.partidos SET faltas_equipo_propio = GREATEST(0, faltas_equipo_propio - 1) WHERE id = $1 RETURNING faltas_equipo_propio`, [l.partido_id]);
        faltasPropio = upd.rows[0].faltas_equipo_propio;
      }
    }
  }

  await pool.query(`DELETE FROM sport_control.partido_stats_log WHERE id = $1`, [logId]);
  return { success: true, data: { faltasPropio } };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  const body = req.body || {};
  const { accion, token } = body;
  const pool = getPool();

  try {
    if (accion === 'login_unificado') return res.status(200).json(await loginUnificado(pool, body));
    if (accion === 'crear_clave_unificada') return res.status(200).json(await crearClaveUnificada(pool, body));
    if (accion === 'verificar_clave_unificada') return res.status(200).json(await verificarClaveUnificada(pool, body));

    // Captura en vivo: acciones muy frecuentes, van por un camino corto
    // (sesion + id de planillero en un solo viaje, sin detectarRoles).
    const ACCIONES_CAPTURA_RAPIDA = [
      'registrar_evento_partido_planillero', 'registrar_falta_rival_planillero', 'registrar_falta_jugador_rival_planillero',
      'iniciar_reloj_partido_planillero', 'pausar_reloj_partido_planillero', 'avanzar_periodo_partido_planillero',
      'ajustar_reloj_partido_planillero', 'toggle_jugador_cancha_planillero',
    ];
    if (ACCIONES_CAPTURA_RAPIDA.includes(accion)) {
      const s = await resolverSesionConPlanillero(pool, token);
      if (!s.cedula) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });
      if (accion === 'registrar_evento_partido_planillero') return res.status(200).json(await registrarEventoPartido(pool, s.planilleroId || null, body));
      if (accion === 'registrar_falta_rival_planillero') return res.status(200).json(await registrarFaltaEquipoRival(pool, body));
      if (accion === 'registrar_falta_jugador_rival_planillero') return res.status(200).json(await registrarFaltaJugadorRival(pool, body));
      if (accion === 'iniciar_reloj_partido_planillero') return res.status(200).json(await iniciarReloj(pool, body));
      if (accion === 'pausar_reloj_partido_planillero') return res.status(200).json(await pausarReloj(pool, body));
      if (accion === 'avanzar_periodo_partido_planillero') return res.status(200).json(await avanzarPeriodo(pool, body));
      if (accion === 'ajustar_reloj_partido_planillero') return res.status(200).json(await ajustarReloj(pool, body));
      return res.status(200).json(await toggleJugadorCancha(pool, body));
    }

    const cedula = await resolverSesion(pool, token);
    if (!cedula) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    if (accion === 'cambiar_clave_unificada') return res.status(200).json(await cambiarClaveUnificada(pool, cedula, body));
    if (accion === 'obtener_sesion_y_menu') return res.status(200).json(await obtenerSesionYMenu(pool, cedula));
    if (accion === 'obtener_perfil_unificado') return res.status(200).json(await obtenerPerfilUnificado(pool, cedula));
    if (accion === 'actualizar_perfil_unificado') return res.status(200).json(await actualizarPerfilUnificado(pool, cedula, body));
    if (accion === 'listar_partidos_activos_planillero') return res.status(200).json(await listarPartidosActivosPlanillero(pool));
    if (accion === 'abrir_captura_partido_planillero') return res.status(200).json(await abrirCapturaPartido(pool, body));
    if (accion === 'eliminar_evento_partido_planillero') return res.status(200).json(await eliminarEventoPartido(pool, body));
    if (accion === 'editar_numero_alias_jugador_planillero') {
      const { jugadorId, numeroCamiseta, alias, partidoId } = body;
      await pool.query(`UPDATE sport_control.jugadores SET numero_camiseta = $1, alias = $2 WHERE id = $3`, [numeroCamiseta || null, alias || null, jugadorId]);
      // Si este partido pertenece a un evento y esa jugadora tiene un
      // numero especifico para ese torneo (que tiene prioridad sobre
      // el numero base), se actualiza tambien -- si no, el cambio no
      // se veria reflejado en la captura de ESTE partido aunque el
      // numero base ya haya quedado bien guardado.
      if (partidoId) {
        const partido = await pool.query(`SELECT evento_id FROM sport_control.partidos WHERE id = $1`, [partidoId]);
        const eventoId = partido.rows[0] ? partido.rows[0].evento_id : null;
        if (eventoId) {
          await pool.query(
            `UPDATE sport_control.evento_cuota_jugador SET numero_camiseta = $1 WHERE evento_id = $2 AND jugador_id = $3`,
            [numeroCamiseta || null, eventoId, jugadorId]
          );
        }
      }
      return res.status(200).json({ success: true });
    }
    if (accion === 'resetear_faltas_equipo_planillero') {
      const r = await pool.query(`UPDATE sport_control.partidos SET faltas_equipo_propio = 0, faltas_equipo_rival = 0 WHERE id = $1 RETURNING faltas_equipo_propio AS "faltasPropio", faltas_equipo_rival AS "faltasRival"`, [body.partidoId]);
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    if (accion === 'ajustar_faltas_equipo_planillero') {
      // Ajuste manual, solo disponible en modo edicion -- para
      // emergencias donde el conteo automatico no coincide con lo
      // que realmente paso en la cancha.
      const campo = body.equipo === 'rival' ? 'faltas_equipo_rival' : 'faltas_equipo_propio';
      const valor = Math.max(0, parseInt(body.valor) || 0);
      await pool.query(`UPDATE sport_control.partidos SET ${campo} = $1 WHERE id = $2`, [valor, body.partidoId]);
      return res.status(200).json({ success: true });
    }

    if (accion === 'listar_rubros_club_financiero') return res.status(200).json(await listarRubros(pool));
    if (accion === 'crear_rubro_club_financiero') return res.status(200).json(await crearRubro(pool, body));
    if (accion === 'editar_rubro_club_financiero') return res.status(200).json(await editarRubro(pool, body));
    if (accion === 'toggle_rubro_club_financiero') return res.status(200).json(await toggleRubro(pool, body));
    if (accion === 'listar_movimientos_club_financiero') return res.status(200).json(await listarMovimientosClub(pool, body));
    if (accion === 'registrar_movimiento_club_financiero') return res.status(200).json(await registrarMovimientoClub(pool, body));
    if (accion === 'eliminar_movimiento_club_financiero') return res.status(200).json(await eliminarMovimientoClub(pool, body));
    if (accion === 'ver_mensualidad_jugador_financiero') return res.status(200).json(await verMensualidadJugadorAdmin(pool, body));
    if (accion === 'dashboard_morosos_mensualidad_financiero') return res.status(200).json(await dashboardMorososMensualidad(pool));
    if (accion === 'listar_jugadores_financiero') {
      const r = await pool.query(`SELECT id, nombres, apellidos FROM sport_control.jugadores WHERE estado = 'activo' ORDER BY nombres`);
      return res.status(200).json({ success: true, data: r.rows });
    }
    if (accion === 'editar_evento_partido_planillero') return res.status(200).json(await editarEventoPartido(pool, body));

    // Endpoint de prueba de la Fase 1 -- se mantiene por compatibilidad
    if (accion === 'listar_pantallas_para_roles_prueba') {
      const roles = Array.isArray(body.roles) ? body.roles : [];
      return res.status(200).json(await listarPantallasParaRoles(pool, roles));
    }

    return res.status(200).json({ success: false, error: 'Accion no reconocida' });
  } catch (err) {
    console.error(`Error en /api/app_unificada (accion=${accion}):`, err);
    return res.status(200).json({ success: false, error: 'Error interno: ' + (err && err.message ? err.message : String(err)) });
  }
};

module.exports.listarPantallasParaRoles = listarPantallasParaRoles;

