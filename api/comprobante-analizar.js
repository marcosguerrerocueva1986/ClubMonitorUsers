// api/comprobante-analizar.js
// Reemplaza 'analizar_comprobante_jugador'. Usa el mismo modelo y prompt
// exactos que ya funcionaban en n8n (gpt-4o-mini, vision).
//
// Requiere la variable de entorno OPENAI_API_KEY en Vercel
// (Settings -> Environment Variables) con la misma clave que ya usa
// la credencial "OpenAIApiKey" en n8n.

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const { token, imagenBase64 } = req.body || {};
    const pool = getPool();
    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: 'Eres un asistente que extrae datos de comprobantes de pago bancarios (transferencias) de Ecuador. Devuelve SOLO un JSON con las claves: esComprobante (boolean), numeroComprobante (string), monto (number), banco (string), fechaComprobante (string formato YYYY-MM-DD), titular (string), confianza (number 0-1). Si la imagen no es un comprobante de pago, esComprobante debe ser false.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extrae los datos de este comprobante de pago.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imagenBase64}` } },
            ],
          },
        ],
      }),
    });

    const openaiJson = await openaiRes.json();
    let datos = { esComprobante: false };
    try {
      datos = JSON.parse(openaiJson.choices[0].message.content);
    } catch (e) {
      datos = { esComprobante: false };
    }

    const numeroComprobante = datos.numeroComprobante || '';
    const dup = await pool.query(`SELECT COUNT(*) AS existe FROM sport_control.pagos WHERE numero_comprobante = $1`, [numeroComprobante]);

    return res.status(200).json({
      success: true,
      data: {
        esComprobante: datos.esComprobante === true,
        numeroComprobante,
        monto: datos.monto || 0,
        banco: datos.banco || '',
        fechaComprobante: datos.fechaComprobante || '',
        duplicado: Number(dup.rows[0].existe) > 0,
      },
    });
  } catch (err) {
    console.error('Error en /api/comprobante-analizar:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
