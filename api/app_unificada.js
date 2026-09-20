// api/app_unificada.js
//
// Backend de la futura app unica (login por cedula, un solo menu que
// se arma segun los roles detectados). Fase 1: solo el catalogo de
// pantallas -- el login unificado y la deteccion de roles se
// construyen en la Fase 2, sobre este mismo archivo.

const { getPool } = require('./_db');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  const body = req.body || {};
  const { accion } = body;
  const pool = getPool();

  try {
    // Endpoint de prueba para la Fase 1 -- recibe los roles
    // directamente en el body (sin login todavia) para poder
    // verificar el catalogo antes de construir el login real.
    if (accion === 'listar_pantallas_para_roles_prueba') {
      const roles = Array.isArray(body.roles) ? body.roles : [];
      return res.status(200).json(await listarPantallasParaRoles(pool, roles));
    }

    return res.status(200).json({ success: false, error: 'Accion no reconocida (Fase 1: solo listar_pantallas_para_roles_prueba)' });
  } catch (err) {
    console.error(`Error en /api/app_unificada (accion=${accion}):`, err);
    return res.status(200).json({ success: false, error: 'Error interno: ' + (err && err.message ? err.message : String(err)) });
  }
};

module.exports.listarPantallasParaRoles = listarPantallasParaRoles;
