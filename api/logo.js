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

    const badgeBase64 = req.query && BADGES_BASE64[req.query.badge];
    if (badgeBase64) {
      const logoImg = await Jimp.read(buffer);
      const badgeImg = await Jimp.read(Buffer.from(badgeBase64, 'base64'));
      const w = logoImg.getWidth();
      // Insignia grande y visible, con un margen moderado (no pegada a
      // la esquina, para que no se corte en launchers mas agresivos,
      // pero sin exagerar el margen para que no se vea "vacia").
      const badgeSize = Math.round(w * 0.40);
      badgeImg.resize(badgeSize, badgeSize);
      const margin = Math.round(w * 0.09);
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
