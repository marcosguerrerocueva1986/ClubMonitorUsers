// api/deuda.js
// Reemplaza la accion 'ver_pendientes_pago_jugador' que antes vivia en n8n.
// Reutiliza tal cual la funcion SQL 'sport_control.pendientes_jugador()',
// que ya vive en la base de datos y contiene toda la logica de negocio
// probada (deudas de mensualidad, invitados, multas). Aqui solo se llama
// y se reempaqueta la respuesta con el mismo formato que ya espera el
// frontend (saldoAFavor en camelCase).

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

    const result = await pool.query(
      `SELECT sport_control.pendientes_jugador($1) AS pendientes,
              COALESCE((SELECT SUM(monto) FROM sport_control.saldo_a_favor WHERE jugador_id = $1 AND usado = false), 0) AS saldo_a_favor`,
      [jugadorId]
    );

    const row = result.rows[0];

    return res.status(200).json({
      success: true,
      data: {
        pendientes: row.pendientes,
        saldoAFavor: Number(row.saldo_a_favor),
      },
    });
  } catch (err) {
    console.error('Error en /api/deuda:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
