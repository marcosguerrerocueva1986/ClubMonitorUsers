// api/login.js
// Reemplaza 'login_jugador'. Incluye la misma validacion/normalizacion
// de telefono que ya vive en n8n (10 digitos empezando con 0 -> 593...).

const { getPool } = require('./_db');

function normalizarTelefono(raw) {
  const soloDigitos = String(raw || '').replace(/\D/g, '');
  if (soloDigitos.length === 10 && soloDigitos.startsWith('0')) {
    return { valido: true, telefono: '593' + soloDigitos.substring(1) };
  }
  if (soloDigitos.length === 12 && soloDigitos.startsWith('593')) {
    return { valido: true, telefono: soloDigitos };
  }
  return { valido: false, error: 'El numero debe tener 10 digitos, solo numeros, sin espacios ni letras. Ejemplo: 0983309625' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { telefono } = req.body || {};
    const norm = normalizarTelefono(telefono);
    if (!norm.valido) return res.status(200).json({ success: false, error: norm.error });

    const pool = getPool();
    const r = await pool.query(
      `WITH j AS (
         SELECT id FROM sport_control.jugadores WHERE telefono = $1 AND estado = 'activo' LIMIT 1
       ),
       nueva_sesion AS (
         INSERT INTO sport_control.sesiones_pwa (jugador_id, token)
         SELECT id, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico() FROM j
         RETURNING jugador_id, token
       )
       SELECT ns.jugador_id, ns.token FROM (SELECT 1 AS ancla) d LEFT JOIN nueva_sesion ns ON true`,
      [norm.telefono]
    );

    const row = r.rows[0];
    if (row && row.jugador_id) {
      return res.status(200).json({ success: true, data: { registrado: true, token: row.token } });
    }
    return res.status(200).json({ success: true, data: { registrado: false } });
  } catch (err) {
    console.error('Error en /api/login:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
