// api/_admin_lugares.js
// Catalogo de lugares (canchas, coliseos, estadios) donde se juegan
// los partidos. Coordenadas opcionales al crear rapido, completables
// despues desde el mantenimiento.

async function listarLugares(pool) {
  const r = await pool.query(
    `SELECT id, nombre, detalle, latitud, longitud, activo FROM sport_control.lugares WHERE activo = true ORDER BY nombre`
  );
  return { success: true, data: r.rows };
}

async function listarLugaresAdmin(pool) {
  const r = await pool.query(
    `SELECT id, nombre, detalle, latitud, longitud, activo FROM sport_control.lugares ORDER BY nombre`
  );
  return { success: true, data: r.rows };
}

async function crearLugar(pool, body) {
  const nombre = (body.nombre || '').trim();
  if (!nombre) return { success: false, error: 'El nombre es obligatorio.' };
  const r = await pool.query(
    `INSERT INTO sport_control.lugares (nombre, detalle, latitud, longitud) VALUES ($1, $2, $3, $4) RETURNING id, nombre, detalle, latitud, longitud`,
    [nombre, body.detalle || null, body.latitud || null, body.longitud || null]
  );
  return { success: true, data: r.rows[0] };
}

async function editarLugar(pool, body) {
  const { lugarId, nombre, detalle, latitud, longitud } = body;
  await pool.query(
    `UPDATE sport_control.lugares SET nombre = $1, detalle = $2, latitud = $3, longitud = $4 WHERE id = $5`,
    [nombre, detalle || null, latitud || null, longitud || null, lugarId]
  );
  return { success: true };
}

async function toggleLugar(pool, body) {
  await pool.query(`UPDATE sport_control.lugares SET activo = $1 WHERE id = $2`, [!!body.activo, body.lugarId]);
  return { success: true };
}

async function obtenerGoogleMapsApiKey(pool) {
  const r = await pool.query(`SELECT google_maps_api_key FROM sport_control.configuracion_club WHERE id = 1`);
  return { success: true, data: { apiKey: r.rows[0] ? r.rows[0].google_maps_api_key : null } };
}

module.exports = { listarLugares, listarLugaresAdmin, crearLugar, editarLugar, toggleLugar, obtenerGoogleMapsApiKey };
