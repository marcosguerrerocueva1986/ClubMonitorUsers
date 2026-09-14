// api/_admin_disciplinas.js
// Gestion de disciplinas deportivas y su catalogo de estadisticas
// (parametrizable por el Admin, sin tocar codigo para agregar/editar
// una estadistica).

async function listarDisciplinas(pool) {
  const r = await pool.query(`SELECT id, nombre, icono, activo, orden FROM sport_control.disciplinas ORDER BY orden, nombre`);
  return { success: true, data: r.rows };
}

async function listarDisciplinasActivas(pool) {
  const r = await pool.query(`SELECT id, nombre, icono FROM sport_control.disciplinas WHERE activo = true ORDER BY orden, nombre`);
  return { success: true, data: r.rows };
}

async function crearDisciplina(pool, body) {
  const nombre = (body.nombre || '').trim();
  const icono = (body.icono || '').trim() || '🏅';
  if (!nombre) return { success: false, error: 'El nombre no puede estar vacío.' };
  try {
    const r = await pool.query(
      `INSERT INTO sport_control.disciplinas (nombre, icono, activo, orden)
       VALUES ($1, $2, true, (SELECT COALESCE(MAX(orden),0)+1 FROM sport_control.disciplinas))
       RETURNING id, nombre, icono, activo, orden`,
      [nombre, icono]
    );
    return { success: true, data: r.rows[0] };
  } catch (err) {
    if (err.code === '23505') return { success: false, error: 'Ya existe una disciplina con ese nombre.' };
    throw err;
  }
}

async function editarDisciplina(pool, body) {
  const { disciplinaId, nombre, icono } = body;
  await pool.query(`UPDATE sport_control.disciplinas SET nombre = $1, icono = $2 WHERE id = $3`, [nombre, icono, disciplinaId]);
  return { success: true };
}

async function toggleDisciplina(pool, body) {
  await pool.query(`UPDATE sport_control.disciplinas SET activo = $1 WHERE id = $2`, [!!body.activo, body.disciplinaId]);
  return { success: true };
}

async function listarTiposEstadistica(pool, body) {
  const r = await pool.query(
    `SELECT id, nombre, clave, nivel, activo, orden FROM sport_control.tipos_estadistica WHERE disciplina_id = $1 ORDER BY orden, nombre`,
    [body.disciplinaId]
  );
  return { success: true, data: r.rows };
}

function generarClave(nombre) {
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function crearTipoEstadistica(pool, body) {
  const { disciplinaId, nivel } = body;
  const nombre = (body.nombre || '').trim();
  if (!nombre) return { success: false, error: 'El nombre no puede estar vacío.' };
  if (!['jugador', 'equipo'].includes(nivel)) return { success: false, error: 'Nivel inválido.' };
  const clave = generarClave(nombre);
  try {
    const r = await pool.query(
      `INSERT INTO sport_control.tipos_estadistica (disciplina_id, nombre, clave, nivel, orden)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(orden),0)+1 FROM sport_control.tipos_estadistica WHERE disciplina_id = $1))
       RETURNING id, nombre, clave, nivel, activo, orden`,
      [disciplinaId, nombre, clave, nivel]
    );
    return { success: true, data: r.rows[0] };
  } catch (err) {
    if (err.code === '23505') return { success: false, error: 'Ya existe una estadística muy similar en esta disciplina.' };
    throw err;
  }
}

async function toggleTipoEstadistica(pool, body) {
  await pool.query(`UPDATE sport_control.tipos_estadistica SET activo = $1 WHERE id = $2`, [!!body.activo, body.tipoEstadisticaId]);
  return { success: true };
}

module.exports = {
  listarDisciplinas, listarDisciplinasActivas, crearDisciplina, editarDisciplina, toggleDisciplina,
  listarTiposEstadistica, crearTipoEstadistica, toggleTipoEstadistica,
};
