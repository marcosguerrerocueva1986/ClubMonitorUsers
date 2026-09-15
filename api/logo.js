// api/logo.js
// Sirve el logo del club como una imagen REAL, para iconos de
// instalacion (PWA), favicons, y notificaciones push.
//
// GET /api/logo -- el logo tal cual.
// GET /api/logo?badge=admin|jugador|representante -- el logo con la
// insignia correspondiente superpuesta, para diferenciar visualmente
// cada app aunque el club cambie su logo.
//
// Las insignias van incrustadas como base64 en _badges_base64.js (no
// se leen como archivos sueltos del disco) porque Vercel no siempre
// incluye automaticamente archivos de imagen accedidos dinamicamente
// en el paquete de la funcion -- eso causaba que esto fallara en
// produccion aunque funcionara perfecto en las pruebas locales.

const { getPool } = require('./_db');
const Jimp = require('jimp');
const BADGES_BASE64 = require('./_badges_base64');

module.exports = async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT logo_base64 FROM sport_control.configuracion_club WHERE id = 1`);
    const base64 = r.rows[0] && r.rows[0].logo_base64;

    if (!base64) {
      return res.status(404).send('Logo no configurado');
    }

    let buffer = Buffer.from(base64, 'base64');

    // El logo tal como lo sube el Admin suele quedar con bastante
    // margen blanco alrededor -- se acerca (zoom + recorte centrado)
    // para que rellene mas el marco del icono, sin distorsionar la
    // proporcion.
    const logoImg = await Jimp.read(buffer);
    const w0 = logoImg.getWidth(), h0 = logoImg.getHeight();
    const zoom = 1.18;
    logoImg.resize(Math.round(w0 * zoom), Math.round(h0 * zoom));
    logoImg.crop(Math.round((logoImg.getWidth() - w0) / 2), Math.round((logoImg.getHeight() - h0) / 2), w0, h0);
    buffer = await logoImg.getBufferAsync(Jimp.MIME_PNG);

    const badgeBase64 = req.query && BADGES_BASE64[req.query.badge];
    if (badgeBase64) {
      const logoConBadge = await Jimp.read(buffer);
      const badgeImg = await Jimp.read(Buffer.from(badgeBase64, 'base64'));
      const w = logoConBadge.getWidth();
      const badgeSize = Math.round(w * 0.40);
      badgeImg.resize(badgeSize, badgeSize);
      const margin = Math.round(w * 0.09);
      logoConBadge.composite(badgeImg, w - badgeSize - margin, logoConBadge.getHeight() - badgeSize - margin);
      buffer = await logoConBadge.getBufferAsync(Jimp.MIME_PNG);
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Error en /api/logo:', err);
    return res.status(500).send('Error interno');
  }
};
