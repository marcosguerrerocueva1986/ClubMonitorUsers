// api/documento.js
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { slug } = req.body || {};
    const pool = getPool();
    const result = await pool.query(
      `SELECT filename, contenido_base64 FROM sport_control.documentos_club WHERE slug = $1 LIMIT 1`,
      [slug]
    );
    const row = result.rows[0] || {};
    return res.status(200).json({ success: true, data: { filename: row.filename || null, contenido_base64: row.contenido_base64 || null } });
  } catch (err) {
    console.error('Error en /api/documento:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
