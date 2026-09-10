// api/push-habilitado.js
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    await pool.query(`UPDATE sport_control.jugadores SET push_habilitado = true WHERE id = $1`, [jugadorId]);
    return res.status(200).json({ success: true, data: true });
  } catch (err) {
    console.error('Error en /api/push-habilitado:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
