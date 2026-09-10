// api/cancelar-partido.js
// Reemplaza la accion 'cancelar_mi_partido_jugador' que antes vivia en n8n.

const { getPool } = require('./_db');

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
    console.error('Aviso al grupo fallo (no bloquea la cancelacion):', e);
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
      `UPDATE sport_control.confirmaciones_partido SET estado = 'cancelado', timestamp_cancelacion = NOW()
       WHERE partido_id = $1 AND jugador_id = $2`,
      [partidoId, jugadorId]
    );

    await pool.query(
      `DELETE FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND jugador_id = $2 AND invitado_asistencia_id IS NULL`,
      [partidoId, jugadorId]
    );

    await avisarGrupo(pool, partidoId);

    return res.status(200).json({ success: true, data: true });
  } catch (err) {
    console.error('Error en /api/cancelar-partido:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
