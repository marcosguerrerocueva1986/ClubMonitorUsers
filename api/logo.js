// api/logo.js
// Sirve el logo del club como una imagen REAL, para iconos de
// instalacion (PWA), favicons, y notificaciones push.
//
// GET /api/logo -- el logo tal cual.
// GET /api/logo?badge=admin|jugador|representante -- el logo con la
// insignia correspondiente superpuesta, para diferenciar visualmente
// cada app aunque el club cambie su logo.

const path = require('path');
const { getPool } = require('./_db');
const Jimp = require('jimp');

const BADGES = {
  admin: '_admin-badge.png',
  jugador: '_jugador-badge.png',
  representante: '_representante-badge.png',
};

module.exports = async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT logo_base64 FROM sport_control.configuracion_club WHERE id = 1`);
    const base64 = r.rows[0] && r.rows[0].logo_base64;

    if (!base64) {
      return res.status(404).send('Logo no configurado');
    }

    let buffer = Buffer.from(base64, 'base64');

    const badgeArchivo = req.query && BADGES[req.query.badge];
    if (badgeArchivo) {
      const logoImg = await Jimp.read(buffer);
      const badgeImg = await Jimp.read(path.join(__dirname, badgeArchivo));
      const w = logoImg.getWidth();
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
