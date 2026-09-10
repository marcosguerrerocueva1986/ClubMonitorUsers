// api/qr.js
// Reemplaza la accion 'ver_mi_qr_jugador' que antes vivia en n8n.

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  }

  try {
    const { token, partidoId } = req.body || {};
    const pool = getPool();

    const sesion = await pool.query(
      `SELECT s.jugador_id
       FROM (SELECT 1 AS ancla) d
       LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1
       LIMIT 1`,
      [token || '']
    );

    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;

    if (!jugadorId) {
      return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });
    }

    const result = await pool.query(
      `SELECT token FROM sport_control.codigos_asistencia
       WHERE partido_id = $1 AND jugador_id = $2 AND invitado_asistencia_id IS NULL
       LIMIT 1`,
      [partidoId, jugadorId]
    );

    const qrToken = result.rows[0] ? result.rows[0].token : null;

    return res.status(200).json({ success: true, data: { token: qrToken } });
  } catch (err) {
    console.error('Error en /api/qr:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
