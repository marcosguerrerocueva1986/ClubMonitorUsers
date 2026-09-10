// api/actualizar-perfil.js
// Reemplaza la accion 'actualizar_mis_datos_jugador' que antes vivia en n8n.
// A diferencia de la version en n8n (que armaba el UPDATE con texto
// interpolado), aqui se usan parametros reales de Postgres ($1, $2...),
// que es mas seguro contra inyeccion SQL -- una mejora de paso.

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  }

  try {
    const { token, nombres, apellidos, cedula, correo } = req.body || {};
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

    await pool.query(
      `UPDATE sport_control.jugadores
       SET nombres = $1, apellidos = $2, cedula = $3, correo = $4
       WHERE id = $5`,
      [nombres, apellidos, cedula, correo, jugadorId]
    );

    return res.status(200).json({ success: true, data: true });
  } catch (err) {
    console.error('Error en /api/actualizar-perfil:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
