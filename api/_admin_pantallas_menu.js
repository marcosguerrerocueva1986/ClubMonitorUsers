// api/_admin_pantallas_menu.js
// Gestion minima del catalogo de pantallas del menu unificado
// (Fase 1 de la unificacion de apps). Permite ver que pantallas
// existen y que rol(es) las tienen habilitadas, sin tocar codigo.

async function listarPantallasMenu(pool) {
  const pantallas = await pool.query(
    `SELECT id, clave, etiqueta, icono, archivo_pantalla AS "archivoPantalla", orden, activa
     FROM sport_control.pantallas_menu ORDER BY orden ASC`
  );
  const asignaciones = await pool.query(
    `SELECT pantalla_id AS "pantallaId", rol, habilitado FROM sport_control.pantalla_rol`
  );
  return { success: true, data: { pantallas: pantallas.rows, asignaciones: asignaciones.rows } };
}

async function togglePantallaRol(pool, body) {
  const { pantallaId, rol, habilitado } = body;
  await pool.query(
    `INSERT INTO sport_control.pantalla_rol (pantalla_id, rol, habilitado) VALUES ($1, $2, $3)
     ON CONFLICT (pantalla_id, rol) DO UPDATE SET habilitado = EXCLUDED.habilitado`,
    [pantallaId, rol, !!habilitado]
  );
  return { success: true };
}

async function toggleActivaPantalla(pool, body) {
  await pool.query(`UPDATE sport_control.pantallas_menu SET activa = $1 WHERE id = $2`, [!!body.activa, body.pantallaId]);
  return { success: true };
}

module.exports = { listarPantallasMenu, togglePantallaRol, toggleActivaPantalla };
