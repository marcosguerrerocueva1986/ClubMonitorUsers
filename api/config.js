// api/config.js
// Entrega configuracion PUBLICA del club -- valores que hacen falta
// ANTES de que exista una sesion (ej. para inicializar el SDK de
// OneSignal apenas carga la pagina, antes del login). Nunca debe
// devolver nada sensible (claves, tokens, etc.) -- este endpoint no
// tiene autenticacion a proposito, es lo mismo que exponer un dato en
// el <head> del HTML, solo que parametrizado desde la base de datos.
//
// GET /api/config -- sin body.

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`SELECT onesignal_app_id FROM sport_control.configuracion_club WHERE id = 1`);
    const row = r.rows[0] || {};
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ onesignalAppId: row.onesignal_app_id || null });
  } catch (err) {
    console.error('Error en /api/config:', err);
    return res.status(200).json({ onesignalAppId: null });
  }
};
