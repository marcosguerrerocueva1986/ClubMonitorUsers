// api/invitados.js
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token, partidoId } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    const result = await pool.query(
      `SELECT COALESCE(json_agg(json_build_object('id', ia.id, 'nombre', ia.nombre, 'token', ca.token) ORDER BY ia.id), '[]'::json) AS invitados
       FROM sport_control.invitados_asistencia ia
       LEFT JOIN sport_control.codigos_asistencia ca ON ca.invitado_asistencia_id = ia.id
       WHERE ia.partido_id = $1 AND ia.jugador_anfitrion_id = $2 AND ia.estado = 'confirmado'`,
      [partidoId, jugadorId]
    );

    return res.status(200).json({ success: true, data: result.rows[0].invitados });
  } catch (err) {
    console.error('Error en /api/invitados:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
