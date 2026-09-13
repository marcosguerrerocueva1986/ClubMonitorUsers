// api/logo.js
// Sirve el logo del club como una imagen REAL (no como texto/base64
// dentro de una respuesta JSON), para que pueda usarse directamente
// como icono de instalacion (PWA), como imagen en las paginas, y como
// icono de las notificaciones push -- todos estos necesitan una URL
// que devuelva bytes de imagen de verdad, con su Content-Type correcto.
//
// GET /api/logo -- sin body, sin autenticacion (es una imagen publica,
// igual que cualquier logo de una pagina web).

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT logo_base64 FROM sport_control.configuracion_club WHERE id = 1`);
    const base64 = r.rows[0] && r.rows[0].logo_base64;

    if (!base64) {
      // Sin logo configurado todavia: responde 404 en vez de romper,
      // para que el navegador simplemente no muestre nada raro.
      return res.status(404).send('Logo no configurado');
    }

    const buffer = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min: se refresca rapido si el Admin lo cambia, pero no pega la BD en cada carga
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Error en /api/logo:', err);
    return res.status(500).send('Error interno');
  }
};
