// api/_admin_finanzas_club.js
// Modulo financiero del club (matriculas, mensualidad, servicios,
// auspicios, etc.) -- separado de Eventos, que sigue siendo su propio
// mundo. Un rubro nuevo es una fila en rubros_club, nunca codigo nuevo.

async function listarRubros(pool) {
  const r = await pool.query(
    `SELECT id, nombre, tipo, aplica_a AS "aplicaA", recurrencia, monto_sugerido AS "montoSugerido", activo, orden
     FROM sport_control.rubros_club ORDER BY orden, nombre`
  );
  return { success: true, data: r.rows };
}

async function crearRubro(pool, body) {
  const nombre = (body.nombre || '').trim();
  const { tipo, aplicaA, recurrencia, montoSugerido } = body;
  if (!nombre) return { success: false, error: 'El nombre no puede estar vacío.' };
  if (!['ingreso', 'egreso'].includes(tipo)) return { success: false, error: 'Tipo inválido.' };
  if (!['jugador', 'club'].includes(aplicaA)) return { success: false, error: 'Ámbito inválido.' };
  if (!['unico', 'mensual', 'anual'].includes(recurrencia)) return { success: false, error: 'Recurrencia inválida.' };
  const r = await pool.query(
    `INSERT INTO sport_control.rubros_club (nombre, tipo, aplica_a, recurrencia, monto_sugerido, orden)
     VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(orden),0)+10 FROM sport_control.rubros_club))
     RETURNING id`,
    [nombre, tipo, aplicaA, recurrencia, montoSugerido || null]
  );
  return { success: true, data: { id: r.rows[0].id } };
}

async function editarRubro(pool, body) {
  const { rubroId, nombre, tipo, aplicaA, recurrencia, montoSugerido } = body;
  await pool.query(
    `UPDATE sport_control.rubros_club SET nombre = $1, tipo = $2, aplica_a = $3, recurrencia = $4, monto_sugerido = $5 WHERE id = $6`,
    [nombre, tipo, aplicaA, recurrencia, montoSugerido || null, rubroId]
  );
  return { success: true };
}

async function toggleRubro(pool, body) {
  await pool.query(`UPDATE sport_control.rubros_club SET activo = $1 WHERE id = $2`, [!!body.activo, body.rubroId]);
  return { success: true };
}

/* ---------- Movimientos ---------- */
async function listarMovimientosClub(pool, body) {
  const { rubroId, jugadorId, desde, hasta } = body || {};
  const condiciones = [];
  const vals = [];
  let i = 1;
  if (rubroId) { condiciones.push(`m.rubro_id = $${i++}`); vals.push(rubroId); }
  if (jugadorId) { condiciones.push(`m.jugador_id = $${i++}`); vals.push(jugadorId); }
  if (desde) { condiciones.push(`m.fecha >= $${i++}`); vals.push(desde); }
  if (hasta) { condiciones.push(`m.fecha <= $${i++}`); vals.push(hasta); }
  const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';

  const r = await pool.query(
    `SELECT m.id, m.monto, m.fecha, m.periodo, m.descripcion, m.rubro_id AS "rubroId",
       rc.nombre AS rubro, rc.tipo, m.jugador_id AS "jugadorId",
       (j.nombres || ' ' || j.apellidos) AS jugador
     FROM sport_control.movimientos_club m
     JOIN sport_control.rubros_club rc ON rc.id = m.rubro_id
     LEFT JOIN sport_control.jugadores j ON j.id = m.jugador_id
     ${where}
     ORDER BY m.fecha DESC, m.id DESC LIMIT 200`,
    vals
  );
  const totales = await pool.query(
    `SELECT rc.tipo, COALESCE(SUM(m.monto),0) AS total
     FROM sport_control.movimientos_club m JOIN sport_control.rubros_club rc ON rc.id = m.rubro_id
     ${where} GROUP BY rc.tipo`,
    vals
  );
  const totalIngresos = Number((totales.rows.find(t=>t.tipo==='ingreso')||{}).total || 0);
  const totalEgresos = Number((totales.rows.find(t=>t.tipo==='egreso')||{}).total || 0);
  return { success: true, data: { movimientos: r.rows, totalIngresos, totalEgresos } };
}

async function registrarMovimientoClub(pool, body) {
  const { rubroId, jugadorId, monto, fecha, periodo, descripcion, comprobanteBase64 } = body;
  if (!rubroId || !monto) return { success: false, error: 'Faltan datos del movimiento.' };
  const r = await pool.query(
    `INSERT INTO sport_control.movimientos_club (rubro_id, jugador_id, monto, fecha, periodo, descripcion, comprobante_base64)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7) RETURNING id`,
    [rubroId, jugadorId || null, monto, fecha || null, periodo || null, descripcion || null, comprobanteBase64 || null]
  );
  return { success: true, data: { id: r.rows[0].id } };
}

async function eliminarMovimientoClub(pool, body) {
  await pool.query(`DELETE FROM sport_control.movimientos_club WHERE id = $1`, [body.movimientoId]);
  return { success: true };
}

module.exports = {
  listarRubros, crearRubro, editarRubro, toggleRubro,
  listarMovimientosClub, registrarMovimientoClub, eliminarMovimientoClub,
};
