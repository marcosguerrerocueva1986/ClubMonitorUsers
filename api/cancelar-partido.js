// api/cancelar-partido.js
// Reemplaza la accion 'cancelar_mi_partido_jugador' que antes vivia en n8n.

const { getPool } = require('./_db');
const { avisarGrupo } = require('./_avisar-grupo');


module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  }

  try {
    const { token, partidoId } = req.body || {};
    const pool = getPool();

    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) {
      return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });
    }

    await pool.query(
      `UPDATE sport_control.confirmaciones_partido SET estado = 'cancelado', timestamp_cancelacion = NOW()
       WHERE partido_id = $1 AND jugador_id = $2`,
      [partidoId, jugadorId]
    );

    await pool.query(
      `DELETE FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND jugador_id = $2 AND invitado_asistencia_id IS NULL`,
      [partidoId, jugadorId]
    );

    await avisarGrupo(pool, partidoId);

    return res.status(200).json({ success: true, data: true });
  } catch (err) {
    console.error('Error en /api/cancelar-partido:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
