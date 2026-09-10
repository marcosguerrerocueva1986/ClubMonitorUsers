// api/confirmar-partido.js
// Reemplaza la accion 'confirmar_mi_partido_jugador' que antes vivia en n8n.
// Hace 3 cosas, en este orden:
//   1. Confirma la asistencia (upsert en confirmaciones_partido)
//   2. Genera un nuevo codigo QR para el partido
//   3. Avisa al grupo de WhatsApp con la lista actualizada (best-effort:
//      si el envio de WhatsApp falla, NO se rompe la confirmacion del
//      jugador -- exactamente el mismo comportamiento que ya tenia en n8n
//      con 'neverError').

const { getPool } = require('./_db');

async function generarToken(pool) {
  const r = await pool.query(
    `SELECT sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico() AS token`
  );
  return r.rows[0].token;
}

async function avisarGrupo(pool, partidoId) {
  try {
    const info = await pool.query(
      `SELECT p.alias, p.fecha, p.hora, p.lugar, p.estado,
              sport_control.lista_confirmados_partido(p.id) AS lista,
              (SELECT grupo_jid FROM sport_control.configuracion_club WHERE id = 1) AS grupo_jid,
              (SELECT instance_evolutionapi FROM sport_control.configuracion_club WHERE id = 1) AS instance_evolutionapi
       FROM sport_control.partidos p WHERE p.id = $1`,
      [partidoId]
    );
    const p = info.rows[0];
    if (!p || !p.grupo_jid || !p.instance_evolutionapi) return;

    const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const d = new Date(p.fecha);
    const fechaCorta = dias[d.getUTCDay()] + ' ' + String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
    const titulo = p.alias || 'Partido';
    const lista = p.lista || [];
    const lineas = lista.map((item, i) => item.tipo === 'invitado' ? `${i + 1}. 🎟️ ${item.nombre} (invitado de ${item.anfitrion})` : `${i + 1}. ${item.nombre}`);
    const texto = '⚽ *' + titulo + '* (' + p.estado + ')\n📅 ' + fechaCorta + '  🕐 ' + (p.hora || '') + '\n📍 ' + (p.lugar || '') + '\n\nConfirmados (' + lista.length + '):\n\n' + (lineas.length > 0 ? lineas.join('\n') : 'Nadie confirmado todavía.');

    await fetch(`https://evolution-api-production-641b.up.railway.app/message/sendText/${p.instance_evolutionapi}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: p.grupo_jid, text: texto }),
    });
  } catch (e) {
    console.error('Aviso al grupo fallo (no bloquea la confirmacion):', e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  }

  try {
    const { token, partidoId } = req.body || {};
    const pool = getPool();

    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) {
      return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });
    }

    await pool.query(
      `INSERT INTO sport_control.confirmaciones_partido (partido_id, jugador_id, estado, timestamp_confirmacion, cantidad_invitados)
       VALUES ($1, $2, 'confirmado', NOW(), COALESCE((SELECT cantidad_invitados FROM sport_control.confirmaciones_partido WHERE partido_id = $1 AND jugador_id = $2), 0))
       ON CONFLICT (partido_id, jugador_id) DO UPDATE SET estado = 'confirmado', timestamp_confirmacion = NOW()`,
      [partidoId, jugadorId]
    );

    await pool.query(
      `DELETE FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND jugador_id = $2 AND invitado_asistencia_id IS NULL`,
      [partidoId, jugadorId]
    );

    const nuevoToken = await generarToken(pool);
    await pool.query(
      `INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, token) VALUES ($1, $2, $3)`,
      [partidoId, jugadorId, nuevoToken]
    );

    // No esperamos (await) el aviso al grupo antes de responder al jugador,
    // pero si tarda poco Vercel lo alcanza a completar antes de cerrar la funcion.
    await avisarGrupo(pool, partidoId);

    return res.status(200).json({ success: true, data: { token: nuevoToken } });
  } catch (err) {
    console.error('Error en /api/confirmar-partido:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
