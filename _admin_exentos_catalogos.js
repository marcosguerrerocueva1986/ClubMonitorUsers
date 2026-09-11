// api/_admin_exentos_catalogos.js
//
// 1) Flujo de aprobacion de "exentos" (hijos, amigos, invitados
//    especiales) que los jugadores registran desde su app.
// 2) Patron generico de CRUD de catalogos, pensado para que agregar un
//    catalogo nuevo a futuro (tipos de partido, catalogo de cobros, etc.)
//    sea tan simple como agregar una entrada a CATALOGOS_PERMITIDOS.

async function listarExentosPendientes(pool) {
  const r = await pool.query(
    `SELECT je.id, je.nombres, je.apellidos, je.estado, je.creado_en,
            tr.nombre AS relacion, j.nombres || ' ' || j.apellidos AS jugador, j.id AS "jugadorId"
     FROM sport_control.jugador_exentos je
     JOIN sport_control.tipos_relacion_exento tr ON tr.id = je.tipo_relacion_id
     JOIN sport_control.jugadores j ON j.id = je.jugador_id
     WHERE je.estado = 'pendiente_aprobacion'
     ORDER BY je.creado_en ASC`
  );
  return { success: true, data: r.rows };
}

async function aprobarExento(pool, body) {
  await pool.query(`UPDATE sport_control.jugador_exentos SET estado = 'aprobado', revisado_en = NOW() WHERE id = $1`, [body.exentoId]);
  return { success: true };
}

async function rechazarExento(pool, body) {
  await pool.query(`UPDATE sport_control.jugador_exentos SET estado = 'rechazado', revisado_en = NOW() WHERE id = $1`, [body.exentoId]);
  return { success: true };
}

async function listarExentosAprobados(pool) {
  const r = await pool.query(
    `SELECT je.id, je.nombres, je.apellidos, tr.nombre AS relacion, j.nombres || ' ' || j.apellidos AS jugador
     FROM sport_control.jugador_exentos je
     JOIN sport_control.tipos_relacion_exento tr ON tr.id = je.tipo_relacion_id
     JOIN sport_control.jugadores j ON j.id = je.jugador_id
     WHERE je.estado = 'aprobado'
     ORDER BY j.nombres, je.nombres`
  );
  return { success: true, data: r.rows };
}

async function revocarExento(pool, body) {
  const { exentoId } = body;
  try {
    // Intento 1: borrado completo (solo funciona si nunca se uso en ningun partido)
    await pool.query(`DELETE FROM sport_control.jugador_exentos WHERE id = $1`, [exentoId]);
    return { success: true, data: { eliminadoCompleto: true } };
  } catch (err) {
    if (err.code === '23503') {
      // Ya fue usado como invitado en algun partido -- se revoca sin borrar,
      // para no perder el historial de ese partido.
      await pool.query(`UPDATE sport_control.jugador_exentos SET estado = 'revocado', revisado_en = NOW() WHERE id = $1`, [exentoId]);
      return { success: true, data: { eliminadoCompleto: false } };
    }
    throw err;
  }
}

// ---------- Catalogos genericos ----------
// Para agregar un catalogo nuevo mas adelante, solo se agrega aqui una
// entrada con su tabla real. El resto (listar/crear/activar-desactivar)
// funciona automaticamente para cualquier tabla con forma (id, nombre, activo).
const CATALOGOS_PERMITIDOS = {
  tipos_relacion_exento: 'sport_control.tipos_relacion_exento',
  tipos_multa: 'sport_control.tipos_multa',
};

async function listarCatalogo(pool, body) {
  const tabla = CATALOGOS_PERMITIDOS[body.catalogo];
  if (!tabla) return { success: false, error: 'Catálogo no reconocido: ' + body.catalogo };
  const r = await pool.query(`SELECT id, nombre, activo FROM ${tabla} ORDER BY nombre`);
  return { success: true, data: r.rows };
}

async function crearItemCatalogo(pool, body) {
  const tabla = CATALOGOS_PERMITIDOS[body.catalogo];
  if (!tabla) return { success: false, error: 'Catálogo no reconocido: ' + body.catalogo };
  if (!body.nombre || !body.nombre.trim()) return { success: false, error: 'El nombre no puede estar vacío.' };
  const r = await pool.query(`INSERT INTO ${tabla} (nombre) VALUES ($1) RETURNING id, nombre, activo`, [body.nombre.trim()]);
  return { success: true, data: r.rows[0] };
}

async function toggleItemCatalogo(pool, body) {
  const tabla = CATALOGOS_PERMITIDOS[body.catalogo];
  if (!tabla) return { success: false, error: 'Catálogo no reconocido: ' + body.catalogo };
  await pool.query(`UPDATE ${tabla} SET activo = $1 WHERE id = $2`, [!!body.activo, body.id]);
  return { success: true };
}

module.exports = {
  listarExentosPendientes, aprobarExento, rechazarExento, listarExentosAprobados, revocarExento,
  listarCatalogo, crearItemCatalogo, toggleItemCatalogo,
};
