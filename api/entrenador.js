// api/entrenador.js
//
// Backend del rol Entrenador/Director. Mismo patron de login que
// representante.js (cedula + clave de 6 digitos encriptada, primer
// ingreso pide crear clave, reseteo del Admin obliga a cambiarla).
//
// Diferencia de permisos: un 'entrenador' solo ve los grupos que tiene
// asignados (entrenador_grupo); un 'director' ve TODOS los grupos del
// club, sin necesidad de asignacion explicita.

const bcrypt = require('bcryptjs');
const { getPool } = require('./_db');
const { verDetallePartidoStatsJugador, verFotoPartidoAdmin, verHistorialTorneosJugadorEntrenador } = require('./jugador');

const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

async function resolverSesionEntrenador(pool, token) {
  const r = await pool.query(
    `SELECT s.entrenador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_entrenador s ON s.token = $1 LIMIT 1`,
    [token || '']
  );
  return r.rows[0] && r.rows[0].entrenador_id;
}

async function crearSesionEntrenador(pool, entrenadorId) {
  const r = await pool.query(
    `INSERT INTO sport_control.sesiones_entrenador (entrenador_id, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
    [entrenadorId]
  );
  return r.rows[0].token;
}

async function loginEntrenador(pool, body) {
  const cedula = String(body.cedula || '').trim();
  if (!cedula) return { success: false, error: 'Ingresa tu cédula.' };
  const r = await pool.query(`SELECT id, nombres, clave_hash, bloqueado_hasta, activo FROM sport_control.entrenadores WHERE cedula = $1`, [cedula]);
  if (!r.rows[0]) return { success: true, data: { registrado: false } };
  if (!r.rows[0].activo) return { success: false, error: 'Tu cuenta está desactivada. Consulta con el club.' };
  if (r.rows[0].bloqueado_hasta && new Date(r.rows[0].bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }
  return { success: true, data: { registrado: true, tieneClave: !!r.rows[0].clave_hash, nombres: r.rows[0].nombres } };
}

async function crearClaveEntrenador(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();
  if (!/^\d{6}$/.test(clave)) return { success: false, error: 'La clave debe ser de exactamente 6 números.' };
  const r = await pool.query(`SELECT id, nombres, clave_hash FROM sport_control.entrenadores WHERE cedula = $1`, [cedula]);
  if (!r.rows[0]) return { success: false, error: 'No se encontró esa cédula.' };
  if (r.rows[0].clave_hash) return { success: false, error: 'Ya tienes una clave creada. Ingrésala para entrar.' };
  const hash = await bcrypt.hash(clave, 10);
  await pool.query(`UPDATE sport_control.entrenadores SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, r.rows[0].id]);
  const token = await crearSesionEntrenador(pool, r.rows[0].id);
  return { success: true, data: { token, nombres: r.rows[0].nombres, entrenadorId: r.rows[0].id } };
}

async function verificarClaveEntrenador(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();
  const r = await pool.query(
    `SELECT id, nombres, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.entrenadores WHERE cedula = $1`,
    [cedula]
  );
  if (!r.rows[0]) return { success: false, error: 'No se encontró esa cédula.' };
  const ent = r.rows[0];

  if (ent.bloqueado_hasta && new Date(ent.bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }
  if (ent.debe_cambiar_clave && ent.clave_reset_expira && new Date(ent.clave_reset_expira) < new Date()) {
    return { success: false, error: 'Tu clave temporal ya venció. Pídele al Admin que te genere una nueva.' };
  }

  const coincide = ent.clave_hash && await bcrypt.compare(clave, ent.clave_hash);
  if (!coincide) {
    const intentos = ent.intentos_fallidos + 1;
    if (intentos >= MAX_INTENTOS) {
      await pool.query(
        `UPDATE sport_control.entrenadores SET intentos_fallidos = 0, bloqueado_hasta = NOW() + ($1 || ' minutes')::interval WHERE id = $2`,
        [MINUTOS_BLOQUEO, ent.id]
      );
      return { success: false, error: `Demasiados intentos fallidos. Espera ${MINUTOS_BLOQUEO} minutos o pide al Admin que te resetee la clave.` };
    }
    await pool.query(`UPDATE sport_control.entrenadores SET intentos_fallidos = $1 WHERE id = $2`, [intentos, ent.id]);
    return { success: false, error: 'Clave incorrecta.' };
  }

  await pool.query(`UPDATE sport_control.entrenadores SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`, [ent.id]);
  const token = await crearSesionEntrenador(pool, ent.id);
  return { success: true, data: { token, nombres: ent.nombres, debeCambiarClave: ent.debe_cambiar_clave, entrenadorId: ent.id } };
}

async function cambiarClaveEntrenador(pool, entrenadorId, body) {
  const claveActual = String(body.claveActual || '').trim();
  const claveNueva = String(body.claveNueva || '').trim();
  if (!/^\d{6}$/.test(claveNueva)) return { success: false, error: 'La clave nueva debe ser de exactamente 6 números.' };
  const r = await pool.query(`SELECT clave_hash FROM sport_control.entrenadores WHERE id = $1`, [entrenadorId]);
  const coincide = r.rows[0] && r.rows[0].clave_hash && await bcrypt.compare(claveActual, r.rows[0].clave_hash);
  if (!coincide) return { success: false, error: 'Tu clave actual no es correcta.' };
  const hash = await bcrypt.hash(claveNueva, 10);
  await pool.query(`UPDATE sport_control.entrenadores SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, entrenadorId]);
  return { success: true };
}

async function obtenerPerfilEntrenador(pool, entrenadorId) {
  const r = await pool.query(`SELECT nombres, apellidos, telefono, cedula, rol FROM sport_control.entrenadores WHERE id = $1`, [entrenadorId]);
  return { success: true, data: r.rows[0] };
}

async function actualizarPerfilEntrenador(pool, entrenadorId, body) {
  await pool.query(`UPDATE sport_control.entrenadores SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [body.nombres, body.apellidos, body.telefono, entrenadorId]);
  return { success: true, data: true };
}

/* ---------- Grupos ---------- */
async function listarMisGrupos(pool, entrenadorId) {
  const rolR = await pool.query(`SELECT rol FROM sport_control.entrenadores WHERE id = $1`, [entrenadorId]);
  const esDirector = rolR.rows[0] && rolR.rows[0].rol === 'director';

  const query = esDirector
    ? `SELECT g.id, g.nombre, g.descripcion,
         (SELECT COUNT(*) FROM sport_control.jugadores j WHERE j.grupo_id = g.id AND j.estado = 'activo') AS "totalJugadores"
       FROM sport_control.grupos g WHERE g.activo = true ORDER BY g.nombre`
    : `SELECT g.id, g.nombre, g.descripcion,
         (SELECT COUNT(*) FROM sport_control.jugadores j WHERE j.grupo_id = g.id AND j.estado = 'activo') AS "totalJugadores"
       FROM sport_control.entrenador_grupo eg JOIN sport_control.grupos g ON g.id = eg.grupo_id
       WHERE eg.entrenador_id = $1 AND g.activo = true ORDER BY g.nombre`;

  const r = await pool.query(query, esDirector ? [] : [entrenadorId]);
  return { success: true, data: { esDirector, grupos: r.rows } };
}

// Verifica que el entrenador tenga permiso de ver este grupo: los
// directores ven cualquiera, los entrenadores solo los suyos.
async function verificarAccesoGrupo(pool, entrenadorId, grupoId) {
  const rolR = await pool.query(`SELECT rol FROM sport_control.entrenadores WHERE id = $1`, [entrenadorId]);
  if (rolR.rows[0] && rolR.rows[0].rol === 'director') return true;
  const r = await pool.query(`SELECT 1 FROM sport_control.entrenador_grupo WHERE entrenador_id = $1 AND grupo_id = $2`, [entrenadorId, grupoId]);
  return !!r.rows[0];
}

async function verDetalleGrupoEntrenador(pool, body) {
  const { grupoId } = body;
  const grupo = await pool.query(`SELECT id, nombre, descripcion FROM sport_control.grupos WHERE id = $1`, [grupoId]);
  if (!grupo.rows[0]) return { success: false, error: 'Grupo no encontrado.' };

  const jugadores = await pool.query(
    `SELECT id, nombres, apellidos, telefono FROM sport_control.jugadores WHERE grupo_id = $1 AND estado = 'activo' ORDER BY nombres`,
    [grupoId]
  );
  const horarios = await pool.query(
    `SELECT dia_semana AS "diaSemana", hora_inicio AS "horaInicio", hora_fin AS "horaFin", lugar
     FROM sport_control.horarios_grupo WHERE grupo_id = $1 AND activo = true ORDER BY dia_semana, hora_inicio`,
    [grupoId]
  );

  return { success: true, data: { grupo: grupo.rows[0], jugadores: jugadores.rows, horarios: horarios.rows } };
}

/* ---------- Sesiones de entrenamiento y asistencia ---------- */
async function obtenerOCrearSesionDia(pool, entrenadorId, body) {
  const { grupoId, fecha } = body;
  let sesion = await pool.query(
    `SELECT id, rutina, notas FROM sport_control.sesiones_entrenamiento WHERE grupo_id = $1 AND fecha = $2`,
    [grupoId, fecha]
  );
  if (!sesion.rows[0]) {
    const ins = await pool.query(
      `INSERT INTO sport_control.sesiones_entrenamiento (grupo_id, fecha, creado_por) VALUES ($1, $2, $3) RETURNING id, rutina, notas`,
      [grupoId, fecha, entrenadorId]
    );
    sesion = ins;
  }
  const sesionId = sesion.rows[0].id;

  const jugadores = await pool.query(
    `SELECT j.id, j.nombres, j.apellidos, a.asistio, a.justificacion
     FROM sport_control.jugadores j
     LEFT JOIN sport_control.asistencia_entrenamiento a ON a.jugador_id = j.id AND a.sesion_id = $1
     WHERE j.grupo_id = $2 AND j.estado = 'activo' ORDER BY j.nombres`,
    [sesionId, grupoId]
  );

  return { success: true, data: { sesion: sesion.rows[0], jugadores: jugadores.rows } };
}

async function guardarSesionEntrenamiento(pool, body) {
  const { sesionId, rutina, notas, asistencias } = body;
  await pool.query(`UPDATE sport_control.sesiones_entrenamiento SET rutina = $1, notas = $2 WHERE id = $3`, [rutina || null, notas || null, sesionId]);

  for (const a of (asistencias || [])) {
    await pool.query(
      `INSERT INTO sport_control.asistencia_entrenamiento (sesion_id, jugador_id, asistio, justificacion)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sesion_id, jugador_id) DO UPDATE SET asistio = EXCLUDED.asistio, justificacion = EXCLUDED.justificacion`,
      [sesionId, a.jugadorId, !!a.asistio, a.justificacion || null]
    );
  }
  return { success: true };
}

async function listarHistorialSesiones(pool, body) {
  const { grupoId } = body;
  const r = await pool.query(
    `SELECT se.id, se.fecha, se.rutina,
       (SELECT COUNT(*) FROM sport_control.asistencia_entrenamiento a WHERE a.sesion_id = se.id AND a.asistio = true) AS "totalAsistieron",
       (SELECT COUNT(*) FROM sport_control.jugadores j WHERE j.grupo_id = se.grupo_id AND j.estado = 'activo') AS "totalJugadores"
     FROM sport_control.sesiones_entrenamiento se WHERE se.grupo_id = $1 ORDER BY se.fecha DESC LIMIT 20`,
    [grupoId]
  );
  return { success: true, data: r.rows };
}

async function verHistorialAsistenciaJugador(pool, body) {
  const { jugadorId, grupoId } = body;
  const r = await pool.query(
    `SELECT se.fecha, a.asistio, a.justificacion
     FROM sport_control.asistencia_entrenamiento a
     JOIN sport_control.sesiones_entrenamiento se ON se.id = a.sesion_id
     WHERE a.jugador_id = $1 AND se.grupo_id = $2 ORDER BY se.fecha DESC LIMIT 20`,
    [jugadorId, grupoId]
  );
  const total = r.rows.length;
  const asistio = r.rows.filter(x => x.asistio).length;
  return { success: true, data: { historial: r.rows, total, asistio, porcentaje: total > 0 ? Math.round((asistio / total) * 100) : null } };
}

/* ---------- Novedades del jugador ---------- */
async function listarNovedadesJugador(pool, body) {
  const r = await pool.query(
    `SELECT n.id, n.fecha, n.tipo, n.descripcion, n.visible_representante AS "visibleRepresentante",
       e.nombres || ' ' || e.apellidos AS "entrenadorNombre"
     FROM sport_control.novedades_jugador n
     LEFT JOIN sport_control.entrenadores e ON e.id = n.entrenador_id
     WHERE n.jugador_id = $1 ORDER BY n.fecha DESC, n.id DESC`,
    [body.jugadorId]
  );
  return { success: true, data: r.rows };
}

async function enviarPushNovedadRepresentante(pool, jugadorId, tipo) {
  try {
    const cfg = await pool.query(`SELECT onesignal_app_id, sitio_url_representante FROM sport_control.configuracion_club WHERE id = 1`);
    const c = cfg.rows[0];
    if (!c || !c.onesignal_app_id) return { enviado: false, motivo: 'Falta configurar onesignal_app_id en el club.' };

    const jugador = await pool.query(`SELECT nombres FROM sport_control.jugadores WHERE id = $1`, [jugadorId]);
    const nombreJugador = jugador.rows[0] ? jugador.rows[0].nombres : 'tu representado';

    const representantes = await pool.query(
      `SELECT representante_id FROM sport_control.jugador_representante WHERE jugador_id = $1`,
      [jugadorId]
    );
    if (representantes.rows.length === 0) return { enviado: false, motivo: 'Este jugador no tiene ningún representante vinculado.' };

    // Filtro con "OR" entre todos los representantes vinculados -- un
    // dispositivo puede quedar marcado con varios tags (incluso de
    // distintos roles a la vez), asi que esto le llega a cada uno
    // independientemente de que mas tenga marcado ese dispositivo.
    const filters = [];
    representantes.rows.forEach((r, i) => {
      if (i > 0) filters.push({ operator: 'OR' });
      filters.push({ field: 'tag', key: 'representante_id', relation: '=', value: String(r.representante_id) });
    });
    const resp = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: c.onesignal_app_id,
        filters,
        target_channel: 'push',
        headings: { en: '📋 Nueva novedad de ' + nombreJugador },
        contents: { en: `El entrenador registró una novedad (${tipo}). Toca para ver el detalle.` },
        url: c.sitio_url_representante || '',
      }),
    });
    const data = await resp.json();
    return { enviado: true, statusHttp: resp.status, respuestaOneSignal: data, representantesTag: representantes.rows.map(r => r.representante_id) };
  } catch (e) {
    return { enviado: false, motivo: 'Excepción: ' + e.message };
  }
}

async function crearNovedadJugador(pool, entrenadorId, body) {
  const { jugadorId, tipo, visibleRepresentante } = body;
  const descripcion = (body.descripcion || '').trim();
  if (!descripcion) return { success: false, error: 'Escribe una descripción.' };
  if (!['lesion', 'comportamiento', 'progreso', 'otro'].includes(tipo)) return { success: false, error: 'Tipo inválido.' };
  const r = await pool.query(
    `INSERT INTO sport_control.novedades_jugador (jugador_id, entrenador_id, tipo, descripcion, visible_representante)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [jugadorId, entrenadorId, tipo, descripcion, !!visibleRepresentante]
  );
  let diagnosticoPush = null;
  if (visibleRepresentante) {
    diagnosticoPush = await enviarPushNovedadRepresentante(pool, jugadorId, tipo);
  }
  return { success: true, data: { id: r.rows[0].id, diagnosticoPush } };
}

/* ---------- Cambiar jugador de grupo ---------- */
async function cambiarJugadorDeGrupoEntrenador(pool, entrenadorId, body) {
  const { jugadorId, nuevoGrupoId } = body;
  if (nuevoGrupoId) {
    const tieneAcceso = await verificarAccesoGrupo(pool, entrenadorId, nuevoGrupoId);
    if (!tieneAcceso) return { success: false, error: 'No tienes acceso a ese grupo.' };
  }
  await pool.query(`UPDATE sport_control.jugadores SET grupo_id = $1 WHERE id = $2`, [nuevoGrupoId || null, jugadorId]);
  return { success: true };
}

async function listarGruposParaCambio(pool) {
  const r = await pool.query(`SELECT id, nombre FROM sport_control.grupos WHERE activo = true ORDER BY nombre`);
  return { success: true, data: r.rows };
}

/* ---------- Estadisticas de partidos del grupo ---------- */
async function listarPartidosGrupo(pool, body) {
  const { grupoId } = body;
  const r = await pool.query(
    `SELECT DISTINCT p.id, p.alias, p.fecha, p.hora, p.lugar, p.estado,
       (p.marcador_propio IS NOT NULL OR EXISTS(SELECT 1 FROM sport_control.partido_estadisticas pe WHERE pe.partido_id = p.id)) AS "tieneEstadisticas"
     FROM sport_control.partidos p
     JOIN sport_control.confirmaciones_partido cp ON cp.partido_id = p.id AND cp.estado = 'confirmado'
     JOIN sport_control.jugadores j ON j.id = cp.jugador_id
     WHERE j.grupo_id = $1
     ORDER BY p.fecha DESC LIMIT 20`,
    [grupoId]
  );
  return { success: true, data: r.rows };
}

/* ---------- Indicadores generales (solo Director) ---------- */
async function obtenerIndicadoresGenerales(pool) {
  const r = await pool.query(
    `SELECT g.id, g.nombre,
       (SELECT COUNT(*) FROM sport_control.jugadores j WHERE j.grupo_id = g.id AND j.estado = 'activo') AS "totalJugadores",
       (SELECT COUNT(*) FROM sport_control.jugadores j WHERE j.grupo_id = g.id AND j.estado = 'activo' AND sport_control.meses_atraso(j.id) > 0) AS "morosos",
       (SELECT ROUND(AVG(CASE WHEN a.asistio THEN 100.0 ELSE 0 END))
        FROM sport_control.asistencia_entrenamiento a
        JOIN sport_control.sesiones_entrenamiento se ON se.id = a.sesion_id
        WHERE se.grupo_id = g.id AND date_trunc('month', se.fecha) = date_trunc('month', CURRENT_DATE)
       ) AS "asistenciaPromedioMes"
     FROM sport_control.grupos g WHERE g.activo = true ORDER BY g.nombre`
  );
  const totalJugadoresClub = await pool.query(`SELECT COUNT(*) AS total FROM sport_control.jugadores WHERE estado = 'activo'`);
  const totalMorososClub = await pool.query(`SELECT COUNT(*) AS total FROM sport_control.jugadores WHERE estado = 'activo' AND sport_control.meses_atraso(id) > 0`);
  return {
    success: true,
    data: {
      grupos: r.rows,
      totalJugadoresClub: Number(totalJugadoresClub.rows[0].total),
      totalMorososClub: Number(totalMorososClub.rows[0].total),
    },
  };
}

    // Devuelve los grupos que este entrenador puede ver -- todos si es
// director, solo los suyos si no.
async function obtenerGruposVisibles(pool, entrenadorId) {
  const rolR = await pool.query(`SELECT rol FROM sport_control.entrenadores WHERE id = $1`, [entrenadorId]);
  const esDirector = rolR.rows[0] && rolR.rows[0].rol === 'director';
  const grupos = esDirector
    ? await pool.query(`SELECT id FROM sport_control.grupos WHERE activo = true`)
    : await pool.query(`SELECT grupo_id AS id FROM sport_control.entrenador_grupo WHERE entrenador_id = $1`, [entrenadorId]);
  return grupos.rows.map(g => g.id);
}

async function listarHorarioSemanal(pool, entrenadorId) {
  const grupoIds = await obtenerGruposVisibles(pool, entrenadorId);
  if (grupoIds.length === 0) return { success: true, data: { horarios: [], asistencias: {} } };

  const horarios = await pool.query(
    `SELECT h.dia_semana AS "diaSemana", h.hora_inicio AS "horaInicio", h.hora_fin AS "horaFin", h.lugar, g.id AS "grupoId", g.nombre AS "grupoNombre"
     FROM sport_control.horarios_grupo h JOIN sport_control.grupos g ON g.id = h.grupo_id
     WHERE h.grupo_id = ANY($1::int[]) AND h.activo = true
     ORDER BY h.dia_semana, h.hora_inicio`,
    [grupoIds]
  );

  const asistencias = {};
  for (const grupoId of grupoIds) {
    const ultima = await pool.query(
      `SELECT id, fecha FROM sport_control.sesiones_entrenamiento WHERE grupo_id = $1 ORDER BY fecha DESC LIMIT 1`,
      [grupoId]
    );
    if (ultima.rows[0]) {
      const conteo = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE asistio) AS asistieron, COUNT(*) AS total FROM sport_control.asistencia_entrenamiento WHERE sesion_id = $1`,
        [ultima.rows[0].id]
      );
      asistencias[grupoId] = { fecha: ultima.rows[0].fecha, asistieron: Number(conteo.rows[0].asistieron), total: Number(conteo.rows[0].total) };
    }
  }

  return { success: true, data: { horarios: horarios.rows, asistencias } };
}

async function listarCalendarioMes(pool, entrenadorId, body) {
  const { anio, mes } = body; // mes 1-12
  const grupoIds = await obtenerGruposVisibles(pool, entrenadorId);
  if (grupoIds.length === 0) return { success: true, data: [] };

  const sesiones = await pool.query(
    `SELECT se.fecha, g.nombre AS grupo, 'entrenamiento' AS tipo, se.rutina AS detalle, se.grupo_id AS "grupoId"
     FROM sport_control.sesiones_entrenamiento se JOIN sport_control.grupos g ON g.id = se.grupo_id
     WHERE se.grupo_id = ANY($1::int[]) AND EXTRACT(YEAR FROM se.fecha) = $2 AND EXTRACT(MONTH FROM se.fecha) = $3`,
    [grupoIds, anio, mes]
  );

  const partidos = await pool.query(
    `SELECT DISTINCT p.fecha, p.alias, 'partido' AS tipo, p.lugar AS detalle, p.hora
     FROM sport_control.partidos p
     JOIN sport_control.confirmaciones_partido cp ON cp.partido_id = p.id AND cp.estado = 'confirmado'
     JOIN sport_control.jugadores j ON j.id = cp.jugador_id
     WHERE j.grupo_id = ANY($1::int[]) AND EXTRACT(YEAR FROM p.fecha) = $2 AND EXTRACT(MONTH FROM p.fecha) = $3`,
    [grupoIds, anio, mes]
  );

  // Horarios recurrentes: se proyectan sobre el mes para marcar todos
  // los dias que "les toca" segun el dia de la semana, aunque todavia
  // no exista una sesion puntual registrada ese dia.
  const horariosGrupo = await pool.query(
    `SELECT h.dia_semana AS "diaSemana", h.hora_inicio AS "horaInicio", h.lugar, g.nombre AS grupo
     FROM sport_control.horarios_grupo h JOIN sport_control.grupos g ON g.id = h.grupo_id
     WHERE h.grupo_id = ANY($1::int[]) AND h.activo = true`,
    [grupoIds]
  );
  const horarios = [];
  if (horariosGrupo.rows.length > 0) {
    const diasEnMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    for (let d = 1; d <= diasEnMes; d++) {
      const fecha = new Date(Date.UTC(anio, mes - 1, d));
      const diaSemana = fecha.getUTCDay();
      horariosGrupo.rows.forEach(h => {
        if (h.diaSemana === diaSemana) {
          horarios.push({ fecha: fecha.toISOString().slice(0, 10), grupo: h.grupo, tipo: 'horario', detalle: h.lugar, hora: h.horaInicio });
        }
      });
    }
  }

  return { success: true, data: { sesiones: sesiones.rows, partidos: partidos.rows, horarios } };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  const body = req.body || {};
  const { accion, token } = body;
  const pool = getPool();

  try {
    if (accion === 'login_entrenador') return res.status(200).json(await loginEntrenador(pool, body));
    if (accion === 'crear_clave_entrenador') return res.status(200).json(await crearClaveEntrenador(pool, body));
    if (accion === 'verificar_clave_entrenador') return res.status(200).json(await verificarClaveEntrenador(pool, body));

    const entrenadorId = await resolverSesionEntrenador(pool, token);
    if (!entrenadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    if (accion === 'cambiar_clave_entrenador') return res.status(200).json(await cambiarClaveEntrenador(pool, entrenadorId, body));
    if (accion === 'obtener_perfil_entrenador') return res.status(200).json(await obtenerPerfilEntrenador(pool, entrenadorId));
    if (accion === 'actualizar_perfil_entrenador') return res.status(200).json(await actualizarPerfilEntrenador(pool, entrenadorId, body));
    if (accion === 'listar_mis_grupos_entrenador') return res.status(200).json(await listarMisGrupos(pool, entrenadorId));

    if (accion === 'ver_detalle_grupo_entrenador') {
      const tieneAcceso = await verificarAccesoGrupo(pool, entrenadorId, body.grupoId);
      if (!tieneAcceso) return res.status(200).json({ success: false, error: 'No tienes acceso a ese grupo.' });
      return res.status(200).json(await verDetalleGrupoEntrenador(pool, body));
    }
    if (accion === 'obtener_o_crear_sesion_dia_entrenador') {
      const tieneAcceso = await verificarAccesoGrupo(pool, entrenadorId, body.grupoId);
      if (!tieneAcceso) return res.status(200).json({ success: false, error: 'No tienes acceso a ese grupo.' });
      return res.status(200).json(await obtenerOCrearSesionDia(pool, entrenadorId, body));
    }
    if (accion === 'guardar_sesion_entrenamiento_entrenador') return res.status(200).json(await guardarSesionEntrenamiento(pool, body));
    if (accion === 'listar_historial_sesiones_entrenador') {
      const tieneAcceso = await verificarAccesoGrupo(pool, entrenadorId, body.grupoId);
      if (!tieneAcceso) return res.status(200).json({ success: false, error: 'No tienes acceso a ese grupo.' });
      return res.status(200).json(await listarHistorialSesiones(pool, body));
    }
    if (accion === 'ver_historial_asistencia_jugador_entrenador') return res.status(200).json(await verHistorialAsistenciaJugador(pool, body));
    if (accion === 'listar_novedades_jugador_entrenador') return res.status(200).json(await listarNovedadesJugador(pool, body));
    if (accion === 'crear_novedad_jugador_entrenador') return res.status(200).json(await crearNovedadJugador(pool, entrenadorId, body));
    if (accion === 'cambiar_jugador_de_grupo_entrenador') return res.status(200).json(await cambiarJugadorDeGrupoEntrenador(pool, entrenadorId, body));
    if (accion === 'listar_grupos_para_cambio_entrenador') return res.status(200).json(await listarGruposParaCambio(pool));
    if (accion === 'listar_partidos_grupo_entrenador') return res.status(200).json(await listarPartidosGrupo(pool, body));
    if (accion === 'ver_detalle_partido_stats_entrenador') return res.status(200).json(await verDetallePartidoStatsJugador(pool, body));
    if (accion === 'ver_foto_partido_entrenador') return res.status(200).json(await verFotoPartidoAdmin(pool, body));
    if (accion === 'ver_historial_torneos_entrenador') return res.status(200).json(await verHistorialTorneosJugadorEntrenador(pool, body.jugadorId));
    if (accion === 'listar_horario_semanal_entrenador') return res.status(200).json(await listarHorarioSemanal(pool, entrenadorId));
    if (accion === 'listar_calendario_mes_entrenador') return res.status(200).json(await listarCalendarioMes(pool, entrenadorId, body));
if (accion === 'obtener_indicadores_generales_entrenador') {
      const rolR = await pool.query(`SELECT rol FROM sport_control.entrenadores WHERE id = $1`, [entrenadorId]);
      if (!rolR.rows[0] || rolR.rows[0].rol !== 'director') return res.status(200).json({ success: false, error: 'Solo el rol Director puede ver esto.' });
      return res.status(200).json(await obtenerIndicadoresGenerales(pool));
    }

    return res.status(200).json({ success: false, error: 'Accion no reconocida' });
  } catch (err) {
    console.error(`Error en /api/entrenador (accion=${accion}):`, err);
    return res.status(200).json({ success: false, error: 'Error interno: ' + (err && err.message ? err.message : String(err)) });
  }
};
