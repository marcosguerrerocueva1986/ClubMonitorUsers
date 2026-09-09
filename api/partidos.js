// api/partidos.js
// Reemplaza la accion 'ver_mis_partidos_jugador' que antes vivia en n8n.
// Primero resuelve el jugador_id a partir del token (igual que perfil.js),
// luego trae la lista de partidos activos con el estado de confirmacion
// del jugador y la cantidad de invitados que tiene en cada uno.

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  }

  try {
    const { token } = req.body || {};
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

    const partidos = await pool.query(
      `SELECT
         p.id,
         p.alias,
         p.fecha,
         p.hora,
         p.lugar,
         p.estado,
         COALESCE(cp.estado, 'sin_confirmar') AS "miEstado",
         (SELECT COUNT(*) FROM sport_control.invitados_asistencia ia
          WHERE ia.partido_id = p.id
            AND ia.jugador_anfitrion_id = $1
            AND ia.estado = 'confirmado') AS "cantidadInvitados"
       FROM sport_control.partidos p
       LEFT JOIN sport_control.confirmaciones_partido cp
         ON cp.partido_id = p.id AND cp.jugador_id = $1
       WHERE p.estado IN ('confirmando', 'cerrado', 'en_juego')
       ORDER BY p.fecha ASC`,
      [jugadorId]
    );

    const data = partidos.rows.map((p) => ({
      id: p.id,
      alias: p.alias,
      fecha: p.fecha,
      hora: p.hora,
      lugar: p.lugar,
      estado: p.estado,
      miEstado: p.miEstado,
      cantidadInvitados: Number(p.cantidadInvitados),
    }));

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('Error en /api/partidos:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
