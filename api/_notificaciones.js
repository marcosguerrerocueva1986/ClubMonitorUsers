// api/_notificaciones.js
// ============================================================
// PUNTO UNICO DE CONTROL DE NOTIFICACIONES A REPRESENTANTES
//
// Hay dos interruptores maestros (Admin -> Parametros -> Notificaciones),
// guardados en configuracion_club:
//   - notif_push_representantes
//   - notif_whatsapp_representantes
//
// REGLA PARA CUALQUIER NOTIFICACION NUEVA:
//   * Push a representantes  -> usar enviarPushRepresentantes() de aqui.
//   * WhatsApp (grupo o privado) -> usar enviarWhatsAppGrupo / Privado /
//     Media de _admin_partidos.js (ya consultan el interruptor).
//   No llamar directamente a OneSignal ni a Evolution API desde otro
//   lado: hacerlo se saltaria los interruptores.
//
// No se aplican a: push al Admin, ni a los push que un jugador recibe
// en su propio dispositivo (tag jugador_id).
// ============================================================

const URL_ONESIGNAL = 'https://onesignal.com/api/v1/notifications';

const MOTIVO_PUSH_APAGADO = 'Push a representantes desactivado (Parámetros → Notificaciones).';
const MOTIVO_WHATSAPP_APAGADO = 'WhatsApp a representantes desactivado (Parámetros → Notificaciones).';

// Estado actual de los dos interruptores. Si la columna aun no existe o
// esta vacia se considera ENCENDIDO (el comportamiento historico).
async function obtenerInterruptores(pool) {
  const r = await pool.query(
    `SELECT notif_push_representantes AS push, notif_whatsapp_representantes AS whatsapp
     FROM sport_control.configuracion_club WHERE id = 1`
  );
  const row = r.rows[0] || {};
  return { push: row.push !== false, whatsapp: row.whatsapp !== false };
}

// Para las funciones de WhatsApp, que reciben la fila `config` ya cargada.
function whatsappRepresentantesActivo(config) {
  return !(config && config.notif_whatsapp_representantes === false);
}

function resultadoWhatsAppApagado() {
  return { enviado: false, omitido: true, razon: MOTIVO_WHATSAPP_APAGADO };
}

// ids de los representantes vinculados a un jugador
async function representantesDeJugador(pool, jugadorId) {
  const r = await pool.query(
    `SELECT representante_id FROM sport_control.jugador_representante WHERE jugador_id = $1`,
    [jugadorId]
  );
  return r.rows.map((x) => x.representante_id);
}

// Push a uno o varios representantes. Devuelve siempre un objeto (nunca lanza):
//   { enviado:true, statusHttp, respuestaOneSignal, representantesTag }
//   { enviado:false, omitido:true, motivo }  -> interruptor apagado
//   { enviado:false, motivo }                -> no se pudo (config, sin destinatarios, error)
async function enviarPushRepresentantes(pool, { representanteIds, titulo, cuerpo }) {
  try {
    const cfg = await pool.query(
      `SELECT onesignal_app_id, sitio_url_representante, notif_push_representantes
       FROM sport_control.configuracion_club WHERE id = 1`
    );
    const c = cfg.rows[0];
    if (c && c.notif_push_representantes === false) return { enviado: false, omitido: true, motivo: MOTIVO_PUSH_APAGADO };
    if (!c || !c.onesignal_app_id) return { enviado: false, motivo: 'Falta configurar onesignal_app_id en el club.' };

    const ids = [...new Set((representanteIds || []).filter((x) => x !== null && x !== undefined))];
    if (ids.length === 0) return { enviado: false, motivo: 'No hay representantes destinatarios.' };

    // Filtro con OR entre todos los representantes: un dispositivo puede
    // tener varios tags (de distintos roles a la vez) y asi le llega a
    // cada uno sin importar que mas tenga marcado ese dispositivo.
    const filters = [];
    ids.forEach((id, i) => {
      if (i > 0) filters.push({ operator: 'OR' });
      filters.push({ field: 'tag', key: 'representante_id', relation: '=', value: String(id) });
    });

    const resp = await fetch(URL_ONESIGNAL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}` },
      body: JSON.stringify({
        app_id: c.onesignal_app_id,
        filters,
        target_channel: 'push',
        headings: { en: titulo },
        contents: { en: cuerpo },
        url: c.sitio_url_representante || '',
      }),
    });
    let respuestaOneSignal = null;
    try { respuestaOneSignal = await resp.json(); } catch (e) { /* respuesta sin cuerpo JSON */ }
    return { enviado: resp.ok !== false, statusHttp: resp.status, respuestaOneSignal, representantesTag: ids };
  } catch (e) {
    return { enviado: false, motivo: 'Excepción: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = {
  obtenerInterruptores, whatsappRepresentantesActivo, resultadoWhatsAppApagado,
  representantesDeJugador, enviarPushRepresentantes,
  MOTIVO_PUSH_APAGADO, MOTIVO_WHATSAPP_APAGADO,
};
