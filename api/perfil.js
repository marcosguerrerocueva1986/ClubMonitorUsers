// api/perfil.js
// Reemplaza la accion 'obtener_mi_perfil_jugador' que antes vivia en n8n.
// Misma logica exacta: resuelve la sesion por token y devuelve los datos
// del jugador. Usa el mismo patron de "fila ancla" (LEFT JOIN desde una
// fila fija) para garantizar que siempre haya una respuesta, incluso si
// el token no existe o esta vencido.

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  }

  try {
    const { token } = req.body || {};
    const pool = getPool();

    const result = await pool.query(
      `SELECT s.jugador_id, j.nombres, j.apellidos, j.telefono, j.cedula, j.correo
       FROM (SELECT 1 AS ancla) d
       LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1
       LEFT JOIN sport_control.jugadores j ON j.id = s.jugador_id
       LIMIT 1`,
      [token || '']
    );

    const row = result.rows[0];

    if (!row || !row.jugador_id) {
      return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });
    }

    return res.status(200).json({
      success: true,
      data: {
        jugadorId: row.jugador_id,
        nombres: row.nombres,
        apellidos: row.apellidos,
        telefono: row.telefono,
        cedula: row.cedula,
        correo: row.correo,
      },
    });
  } catch (err) {
    console.error('Error en /api/perfil:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
