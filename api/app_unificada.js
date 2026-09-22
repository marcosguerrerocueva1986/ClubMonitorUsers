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
    `SELECT id, nombres, apellidos, rol, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
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
  return {
    success: true,
    data: {
      cedula,
      nombres: registro.nombres,
      apellidos: registro.apellidos,
      telefono: telRow.rows[0] ? telRow.rows[0].telefono : null,
      roles: info.roles,
    },
  };
}

async function actualizarPerfilUnificado(pool, cedula, body) {
  const { nombres, apellidos, telefono } = body;
  const info = await detectarRoles(pool, cedula);
  if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET nombres = $1, apellidos = $2 WHERE id = $3`, [nombres, apellidos, info.jugador.id]);
  if (info.representante) await pool.query(`UPDATE sport_control.representantes SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [nombres, apellidos, telefono || null, info.representante.id]);
  if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [nombres, apellidos, telefono || null, info.entrenador.id]);
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
     ORDER BY p.fecha DESC, p.hora DESC LIMIT 20`
  );
  return { success: true, data: r.rows };
}

async function abrirCapturaPartido(pool, body) {
  const { partidoId } = body;
  const partido = await pool.query(
    `SELECT p.id, p.alias, p.rival_nombre, p.marcador_propio, p.marcador_rival, p.disciplina_id AS "disciplinaId", p.evento_id AS "eventoId"
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
  // "toco jugador").
  const tipos = await pool.query(
    `SELECT id, nombre, clave, puntos FROM sport_control.tipos_estadistica
     WHERE disciplina_id = $1 AND nivel = 'jugador' AND activo = true ORDER BY orden, nombre`,
    [p.disciplinaId]
  );

  // Bitacora reciente -- para reconstruir el estado si el planillero
  // sale de la app o se queda sin bateria y vuelve a entrar.
  const log = await pool.query(
    `SELECT l.id, l.jugador_id AS "jugadorId", l.tipo_estadistica_id AS "tipoEstadisticaId", l.es_rival AS "esRival", l.puntos, l.creado_en AS "creadoEn",
       (j.nombres || ' ' || j.apellidos) AS "jugadorNombre", t.nombre AS "tipoNombre"
     FROM sport_control.partido_stats_log l
     LEFT JOIN sport_control.jugadores j ON j.id = l.jugador_id
     LEFT JOIN sport_control.tipos_estadistica t ON t.id = l.tipo_estadistica_id
     WHERE l.partido_id = $1 ORDER BY l.creado_en DESC LIMIT 50`,
    [partidoId]
  );

  return {
    success: true,
    data: {
      partido: p,
      jugadores: jugadores.rows,
      tipos: tipos.rows,
      log: log.rows,
    },
  };
}

async function registrarEventoPartido(pool, planilleroId, body) {
  const { partidoId, jugadorId, tipoEstadisticaId, esRival, puntos } = body;
  const puntosNum = Number(puntos) || 0;

  const ins = await pool.query(
    `INSERT INTO sport_control.partido_stats_log (partido_id, jugador_id, tipo_estadistica_id, es_rival, puntos, planillero_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, creado_en AS "creadoEn"`,
    [partidoId, esRival ? null : (jugadorId || null), esRival ? null : (tipoEstadisticaId || null), !!esRival, puntosNum, planilleroId]
  );

  if (esRival) {
    await pool.query(`UPDATE sport_control.partidos SET marcador_rival = COALESCE(marcador_rival, 0) + $1 WHERE id = $2`, [puntosNum, partidoId]);
  } else {
    if (puntosNum > 0) {
      await pool.query(`UPDATE sport_control.partidos SET marcador_propio = COALESCE(marcador_propio, 0) + $1 WHERE id = $2`, [puntosNum, partidoId]);
    }
    if (jugadorId && tipoEstadisticaId) {
      await pool.query(
        `INSERT INTO sport_control.partido_estadisticas (partido_id, tipo_estadistica_id, jugador_id, valor, actualizado_en)
         VALUES ($1, $2, $3, 1, NOW())
         ON CONFLICT (partido_id, tipo_estadistica_id, jugador_id) DO UPDATE SET valor = sport_control.partido_estadisticas.valor + 1, actualizado_en = NOW()`,
        [partidoId, tipoEstadisticaId, jugadorId]
      );
    }
  }

  return { success: true, data: { id: ins.rows[0].id, creadoEn: ins.rows[0].creadoEn } };
}

// Corrige un registro sin borrarlo: revierte lo que ese registro habia
// aplicado (marcador + estadistica) y aplica de nuevo con los datos
// corregidos. Solo aplica a eventos que NO son puntos del rival (esos
// se corrigen borrando y volviendo a tocar el boton correcto, ya que
// no dependen de una jugadora ni de un tipo).
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
  if (l.jugador_id && l.tipo_estadistica_id) {
    await pool.query(
      `UPDATE sport_control.partido_estadisticas SET valor = GREATEST(0, valor - 1) WHERE partido_id = $1 AND jugador_id = $2 AND tipo_estadistica_id = $3`,
      [l.partido_id, l.jugador_id, l.tipo_estadistica_id]
    );
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
    },
  };
}

async function eliminarEventoPartido(pool, body) {
  const { logId } = body;
  const log = await pool.query(`SELECT * FROM sport_control.partido_stats_log WHERE id = $1`, [logId]);
  if (!log.rows[0]) return { success: false, error: 'Ese registro ya no existe.' };
  const l = log.rows[0];

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
    }
  }

  await pool.query(`DELETE FROM sport_control.partido_stats_log WHERE id = $1`, [logId]);
  return { success: true };
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

    const cedula = await resolverSesion(pool, token);
    if (!cedula) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    if (accion === 'cambiar_clave_unificada') return res.status(200).json(await cambiarClaveUnificada(pool, cedula, body));
    if (accion === 'obtener_sesion_y_menu') return res.status(200).json(await obtenerSesionYMenu(pool, cedula));
    if (accion === 'obtener_perfil_unificado') return res.status(200).json(await obtenerPerfilUnificado(pool, cedula));
    if (accion === 'actualizar_perfil_unificado') return res.status(200).json(await actualizarPerfilUnificado(pool, cedula, body));
    if (accion === 'listar_partidos_activos_planillero') return res.status(200).json(await listarPartidosActivosPlanillero(pool));
    if (accion === 'abrir_captura_partido_planillero') return res.status(200).json(await abrirCapturaPartido(pool, body));
    if (accion === 'registrar_evento_partido_planillero') {
      const info = await detectarRoles(pool, cedula);
      return res.status(200).json(await registrarEventoPartido(pool, info.planillero ? info.planillero.id : null, body));
    }
    if (accion === 'eliminar_evento_partido_planillero') return res.status(200).json(await eliminarEventoPartido(pool, body));

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

