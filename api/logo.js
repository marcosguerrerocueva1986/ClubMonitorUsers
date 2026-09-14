// api/logo.js
// Sirve el logo del club como una imagen REAL (no como texto/base64
// dentro de una respuesta JSON), para que pueda usarse directamente
// como icono de instalacion (PWA), favicon de las paginas, y como
// icono de las notificaciones push -- todos estos necesitan una URL
// que devuelva bytes de imagen de verdad, con su Content-Type correcto.
//
// GET /api/logo -- el logo tal cual.
// GET /api/logo?badge=admin -- el logo con la insignia dorada del
// Admin superpuesta (para diferenciarlo visualmente del icono del
// jugador, incluso cuando el club cambie su logo).

const path = require('path');
const { getPool } = require('./_db');
const Jimp = require('jimp');

module.exports = async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT logo_base64 FROM sport_control.configuracion_club WHERE id = 1`);
    const base64 = r.rows[0] && r.rows[0].logo_base64;

    if (!base64) {
      return res.status(404).send('Logo no configurado');
    }

    let buffer = Buffer.from(base64, 'base64');

    if (req.query && req.query.badge === 'admin') {
      const logoImg = await Jimp.read(buffer);
      const badgeImg = await Jimp.read(path.join(__dirname, '_admin-badge.png'));
      const w = logoImg.getWidth();
      // Insignia proporcional al tamaño del logo, en la esquina inferior derecha.
      const badgeSize = Math.round(w * 0.34);
      badgeImg.resize(badgeSize, badgeSize);
      const margin = Math.round(w * 0.03);
      logoImg.composite(badgeImg, w - badgeSize - margin, logoImg.getHeight() - badgeSize - margin);
      buffer = await logoImg.getBufferAsync(Jimp.MIME_PNG);
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Error en /api/logo:', err);
    return res.status(500).send('Error interno');
  }
};
