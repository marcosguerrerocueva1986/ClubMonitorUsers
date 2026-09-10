// api/comprobante-registrar.js
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token, monto, banco, numeroComprobante, fecha } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    const result = await pool.query(
      `INSERT INTO sport_control.pagos (jugador_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, creado_en)
       VALUES ($1, $2, $3, $4, $5::date, 'transferencia', 'confirmado', NOW()) RETURNING id`,
      [jugadorId, monto, numeroComprobante, banco, fecha]
    );

    return res.status(200).json({ success: true, data: { pagoId: result.rows[0].id, monto } });
  } catch (err) {
    console.error('Error en /api/comprobante-registrar:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
