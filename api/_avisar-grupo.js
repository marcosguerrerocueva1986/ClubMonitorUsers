// api/_avisar-grupo.js
// Helper compartido: envia al grupo de WhatsApp la lista actualizada de
// confirmados de un partido. Usado por confirmar/cancelar partido y por
// agregar/quitar invitados. Es "best-effort": si falla, se registra en
// consola pero nunca interrumpe la accion principal del jugador.

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
    console.error('Aviso al grupo fallo (no bloquea la accion principal):', e);
  }
}

module.exports = { avisarGrupo };
