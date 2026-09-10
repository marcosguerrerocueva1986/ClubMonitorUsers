// api/saldo-favor.js
// La clave REST de OneSignal se lee de la variable de entorno
// ONESIGNAL_REST_API_KEY (Vercel -> Settings -> Environment Variables),
// nunca escrita directamente en el codigo (GitHub bloquea pushes con
// secretos expuestos por seguridad -- con razon).

const { getPool } = require('./_db');

async function enviarPushSaldoFavor(jugadorId, monto) {
  try {
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic Key ${process.env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: '94fc2cb8-f935-4abc-b237-ea9d81c1eb81',
        include_aliases: { external_id: [String(jugadorId)] },
        target_channel: 'push',
        headings: { en: '💰 Tienes saldo sin distribuir' },
        contents: { en: `Guardamos $${Number(monto).toFixed(2)} como saldo a favor. Toca para asignarlo a una deuda.` },
        url: 'https://club-monitor-users.vercel.app/',
      }),
    });
  } catch (e) {
    console.error('Push de saldo a favor fallo (no bloquea el guardado):', e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token, monto, pagoId } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    await pool.query(`SELECT sport_control.crear_saldo_favor($1, $2, $3) AS saldo_id`, [jugadorId, monto, pagoId]);

    await enviarPushSaldoFavor(jugadorId, monto);

    return res.status(200).json({ success: true, data: true });
  } catch (err) {
    console.error('Error en /api/saldo-favor:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
