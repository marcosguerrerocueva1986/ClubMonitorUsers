// api/ultimos-pagos.js
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    const result = await pool.query(
      `SELECT COALESCE(json_agg(t.*), '[]'::json) AS pagos FROM (
         SELECT * FROM (
           SELECT pg.creado_en AS fecha, pg.monto,
             CASE WHEN cc.tipo = 'mensualidad' THEN 'Mensualidad'
                  WHEN cc.tipo = 'invitado' THEN 'Invitado' || (CASE WHEN pg.cantidad_invitados > 1 THEN ' (x' || pg.cantidad_invitados || ')' ELSE '' END)
                  WHEN pg.partido_id IS NOT NULL THEN 'Partido especial' || (CASE WHEN p.alias IS NOT NULL THEN ': ' || p.alias ELSE '' END)
                  ELSE 'Pago' END AS motivo
           FROM sport_control.pagos pg
           LEFT JOIN sport_control.catalogo_cobros cc ON cc.id = pg.tipo_cobro_id
           LEFT JOIN sport_control.partidos p ON p.id = pg.partido_id
           WHERE pg.jugador_id = $1 AND pg.estado = 'confirmado'
           UNION ALL
           SELECT COALESCE(m.pagada_en, m.aprobada_en) AS fecha, m.monto, 'Multa: ' || tm.nombre AS motivo
           FROM sport_control.multas m JOIN sport_control.tipos_multa tm ON tm.id = m.tipo_multa_id
           WHERE m.jugador_id = $1 AND m.pagada = true
         ) sub ORDER BY fecha DESC LIMIT 5
       ) t`,
      [jugadorId]
    );

    return res.status(200).json({ success: true, data: result.rows[0].pagos });
  } catch (err) {
    console.error('Error en /api/ultimos-pagos:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
