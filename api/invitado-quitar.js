// api/invitado-quitar.js
// Misma logica de limpieza que ya vive en n8n: si el partido sigue en
// 'confirmando' se borra completamente el registro (nunca hubo riesgo de
// multas); si ya avanzo de estado se mantiene como 'cancelado' para no
// perder el historial que podrian referenciar las multas.

const { getPool } = require('./_db');
const { avisarGrupo } = require('./_avisar-grupo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token, invitadoId } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    const result = await pool.query(
      `WITH invitado_info AS (
         SELECT ia.id, ia.partido_id, p.estado AS partido_estado
         FROM sport_control.invitados_asistencia ia
         JOIN sport_control.partidos p ON p.id = ia.partido_id
         WHERE ia.id = $1 AND ia.jugador_anfitrion_id = $2
       ),
       borrar_codigos AS (
         DELETE FROM sport_control.codigos_asistencia
         WHERE invitado_asistencia_id = (SELECT id FROM invitado_info) AND usado = false
         RETURNING id
       ),
       hard_delete AS (
         DELETE FROM sport_control.invitados_asistencia
         WHERE id IN (SELECT id FROM invitado_info WHERE partido_estado = 'confirmando')
         RETURNING id, partido_id
       ),
       soft_cancel AS (
         UPDATE sport_control.invitados_asistencia SET estado = 'cancelado'
         WHERE id IN (SELECT id FROM invitado_info WHERE partido_estado != 'confirmando')
         RETURNING id, partido_id
       )
       SELECT COALESCE((SELECT partido_id FROM hard_delete LIMIT 1), (SELECT partido_id FROM soft_cancel LIMIT 1)) AS partido_id
       FROM (SELECT 1 AS ancla) d`,
      [invitadoId, jugadorId]
    );

    const partidoId = result.rows[0] && result.rows[0].partido_id;
    if (partidoId) await avisarGrupo(pool, partidoId);

    return res.status(200).json({ success: true, data: true });
  } catch (err) {
    console.error('Error en /api/invitado-quitar:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
