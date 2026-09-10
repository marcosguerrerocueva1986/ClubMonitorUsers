// api/registro.js
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
    const { telefono, nombres, apellidos, cedula, correo } = req.body || {};
    const norm = normalizarTelefono(telefono);
    if (!norm.valido) return res.status(200).json({ success: false, error: norm.error });

    const pool = getPool();
    const r = await pool.query(
      `WITH nuevo AS (
         INSERT INTO sport_control.jugadores (nombres, apellidos, cedula, correo, telefono, estado, creado_en)
         VALUES ($1, $2, $3, $4, $5, 'activo', NOW()) RETURNING id
       ),
       sesion AS (
         INSERT INTO sport_control.sesiones_pwa (jugador_id, token)
         SELECT id, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico() FROM nuevo
         RETURNING jugador_id, token
       )
       SELECT jugador_id, token FROM sesion`,
      [nombres, apellidos, cedula, correo, norm.telefono]
    );

    const row = r.rows[0];
    return res.status(200).json({ success: true, data: { jugadorId: row.jugador_id, token: row.token } });
  } catch (err) {
    console.error('Error en /api/registro:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
