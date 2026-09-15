// api/_admin_entrenadores.js
// Gestion de Grupos y Entrenadores/Directores -- Fase 1 del piloto.
// Login/clave de seguridad de entrenadores se construye en Fase 2;
// aqui solo lo que el Admin necesita para armar la estructura.

const bcrypt = require('bcryptjs');

/* ---------- Grupos ---------- */
async function listarGrupos(pool) {
  const r = await pool.query(
    `SELECT g.id, g.nombre, g.descripcion, g.activo, d.nombre AS "disciplinaNombre", d.icono AS "disciplinaIcono",
       (SELECT COUNT(*) FROM sport_control.jugadores j WHERE j.grupo_id = g.id AND j.estado = 'activo') AS "totalJugadores",
       (SELECT STRING_AGG(e.nombres || ' ' || e.apellidos, ', ') FROM sport_control.entrenador_grupo eg JOIN sport_control.entrenadores e ON e.id = eg.entrenador_id WHERE eg.grupo_id = g.id) AS "entrenadoresNombres"
     FROM sport_control.grupos g
     LEFT JOIN sport_control.disciplinas d ON d.id = g.disciplina_id
     ORDER BY g.nombre`
  );
  return { success: true, data: r.rows };
}

async function crearGrupo(pool, body) {
  const nombre = (body.nombre || '').trim();
  if (!nombre) return { success: false, error: 'El nombre no puede estar vacío.' };
  const r = await pool.query(
    `INSERT INTO sport_control.grupos (nombre, descripcion, disciplina_id) VALUES ($1, $2, $3) RETURNING id, nombre`,
    [nombre, body.descripcion || null, body.disciplinaId || null]
  );
  return { success: true, data: r.rows[0] };
}

async function editarGrupo(pool, body) {
  const { grupoId, nombre, descripcion, disciplinaId } = body;
  await pool.query(`UPDATE sport_control.grupos SET nombre = $1, descripcion = $2, disciplina_id = $3 WHERE id = $4`, [nombre, descripcion || null, disciplinaId || null, grupoId]);
  return { success: true };
}

async function toggleGrupo(pool, body) {
  await pool.query(`UPDATE sport_control.grupos SET activo = $1 WHERE id = $2`, [!!body.activo, body.grupoId]);
  return { success: true };
}

async function verDetalleGrupo(pool, body) {
  const { grupoId } = body;
  const jugadores = await pool.query(
    `SELECT id, nombres, apellidos FROM sport_control.jugadores WHERE grupo_id = $1 AND estado = 'activo' ORDER BY nombres`,
    [grupoId]
  );
  const entrenadores = await pool.query(
    `SELECT e.id, e.nombres, e.apellidos, e.rol FROM sport_control.entrenador_grupo eg JOIN sport_control.entrenadores e ON e.id = eg.entrenador_id WHERE eg.grupo_id = $1 ORDER BY e.nombres`,
    [grupoId]
  );
  const disponibles = await pool.query(
    `SELECT id, nombres, apellidos FROM sport_control.jugadores WHERE estado = 'activo' AND (grupo_id IS NULL OR grupo_id != $1) ORDER BY nombres`,
    [grupoId]
  );
  return { success: true, data: { jugadores: jugadores.rows, entrenadores: entrenadores.rows, disponibles: disponibles.rows } };
}

async function asignarJugadorGrupo(pool, body) {
  await pool.query(`UPDATE sport_control.jugadores SET grupo_id = $1 WHERE id = $2`, [body.grupoId || null, body.jugadorId]);
  return { success: true };
}

async function asignarEntrenadorGrupo(pool, body) {
  const { entrenadorId, grupoId } = body;
  await pool.query(
    `INSERT INTO sport_control.entrenador_grupo (entrenador_id, grupo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [entrenadorId, grupoId]
  );
  return { success: true };
}

async function quitarEntrenadorGrupo(pool, body) {
  await pool.query(`DELETE FROM sport_control.entrenador_grupo WHERE entrenador_id = $1 AND grupo_id = $2`, [body.entrenadorId, body.grupoId]);
  return { success: true };
}

/* ---------- Entrenadores ---------- */
async function listarEntrenadores(pool) {
  const r = await pool.query(
    `SELECT e.id, e.nombres, e.apellidos, e.cedula, e.telefono, e.rol, e.activo, (e.clave_hash IS NOT NULL) AS "tieneClave",
       (SELECT STRING_AGG(g.nombre, ', ') FROM sport_control.entrenador_grupo eg JOIN sport_control.grupos g ON g.id = eg.grupo_id WHERE eg.entrenador_id = e.id) AS "gruposNombres"
     FROM sport_control.entrenadores e ORDER BY e.nombres`
  );
  return { success: true, data: r.rows };
}

async function crearEntrenador(pool, body) {
  const { rol } = body;
  const nombres = (body.nombres || '').trim();
  const apellidos = (body.apellidos || '').trim();
  const cedula = (body.cedula || '').trim();
  if (!nombres || !apellidos) return { success: false, error: 'Completa nombres y apellidos.' };
  if (!cedula) return { success: false, error: 'La cédula es obligatoria.' };
  if (!['entrenador', 'director'].includes(rol)) return { success: false, error: 'Rol inválido.' };
  try {
    const r = await pool.query(
      `INSERT INTO sport_control.entrenadores (cedula, nombres, apellidos, telefono, rol) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [cedula, nombres, apellidos, body.telefono || null, rol]
    );
    return { success: true, data: { id: r.rows[0].id } };
  } catch (err) {
    if (err.code === '23505') return { success: false, error: 'Ya existe un entrenador con esa cédula.' };
    throw err;
  }
}

async function editarEntrenador(pool, body) {
  const { entrenadorId, nombres, apellidos, telefono, rol, cedula } = body;
  try {
    await pool.query(
      `UPDATE sport_control.entrenadores SET nombres = $1, apellidos = $2, telefono = $3, rol = $4, cedula = $5 WHERE id = $6`,
      [nombres, apellidos, telefono || null, rol, cedula, entrenadorId]
    );
    return { success: true };
  } catch (err) {
    if (err.code === '23505') return { success: false, error: 'Ya existe un entrenador con esa cédula.' };
    throw err;
  }
}

async function toggleEntrenador(pool, body) {
  await pool.query(`UPDATE sport_control.entrenadores SET activo = $1 WHERE id = $2`, [!!body.activo, body.entrenadorId]);
  return { success: true };
}

async function resetearClaveEntrenadorAdmin(pool, body) {
  const { entrenadorId } = body;
  const check = await pool.query(`SELECT id, nombres, telefono FROM sport_control.entrenadores WHERE id = $1`, [entrenadorId]);
  if (!check.rows[0]) return { success: false, error: 'No se encontró ese entrenador.' };

  const claveTemporal = String(Math.floor(100000 + Math.random() * 900000));
  const hash = await bcrypt.hash(claveTemporal, 10);
  await pool.query(
    `UPDATE sport_control.entrenadores
     SET clave_hash = $1, debe_cambiar_clave = true, clave_reset_expira = NOW() + INTERVAL '24 hours',
         intentos_fallidos = 0, bloqueado_hasta = NULL
     WHERE id = $2`,
    [hash, entrenadorId]
  );

  const ent = check.rows[0];
  const mensajeWhatsapp = `Hola ${ent.nombres}, tu clave temporal para entrar a la app de entrenadores del club es: ${claveTemporal}\n\nEs válida por 24 horas y solo funciona una vez -- al ingresar con ella, la app te va a pedir crear tu clave definitiva.`;

  return { success: true, data: { claveTemporal, telefono: ent.telefono, mensajeWhatsapp } };
}

module.exports = {
  listarGrupos, crearGrupo, editarGrupo, toggleGrupo, verDetalleGrupo,
  asignarJugadorGrupo, asignarEntrenadorGrupo, quitarEntrenadorGrupo,
  listarEntrenadores, crearEntrenador, editarEntrenador, toggleEntrenador, resetearClaveEntrenadorAdmin,
};
