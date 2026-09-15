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
const { verDetallePartidoStatsJugador, verFotoPartidoAdmin } = require('./jugador');

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
  return { success: true, data: { token, nombres: r.rows[0].nombres } };
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
  return { success: true, data: { token, nombres: ent.nombres, debeCambiarClave: ent.debe_cambiar_clave } };
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
  return { success: true, data: { id: r.rows[0].id } };
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

    return res.status(200).json({ success: false, error: 'Accion no reconocida' });
  } catch (err) {
    console.error(`Error en /api/entrenador (accion=${accion}):`, err);
    return res.status(200).json({ success: false, error: 'Error interno: ' + (err && err.message ? err.message : String(err)) });
  }
};
