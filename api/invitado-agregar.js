// api/invitado-agregar.js
const { getPool } = require('./_db');
const { avisarGrupo } = require('./_avisar-grupo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token, partidoId, nombre } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    const nuevo = await pool.query(
      `INSERT INTO sport_control.invitados_asistencia (partido_id, jugador_anfitrion_id, nombre, estado, creado_en)
       VALUES ($1, $2, $3, 'confirmado', NOW()) RETURNING id`,
      [partidoId, jugadorId, nombre]
    );
    const invitadoId = nuevo.rows[0].id;

    const codigo = await pool.query(
      `INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, invitado_asistencia_id, token)
       VALUES ($1, $2, $3, sport_control.generar_token_alfanumerico()) RETURNING token`,
      [partidoId, jugadorId, invitadoId]
    );

    await avisarGrupo(pool, partidoId);

    return res.status(200).json({ success: true, data: { id: invitadoId, token: codigo.rows[0].token } });
  } catch (err) {
    console.error('Error en /api/invitado-agregar:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
