// api/admin.js
// TODAS las acciones del panel Admin viven en ESTE UNICO archivo (una
// sola funcion serverless), igual que api/jugador.js -- para no superar
// el limite de 12 funciones serverless del plan Hobby de Vercel.
//
// Variables de entorno necesarias (ya deberian existir del backend de jugador):
//   DATABASE_URL, OPENAI_API_KEY
//
// Autenticacion: el Admin no usa sesion por token como el jugador, usa
// una clave compartida (misma logica que n8n): se compara body.clave
// contra configuracion_club.clave_admin_app en CADA peticion.

const { getPool } = require('./_db');

// ============================================================
// Config compartida (clave, grupo, instancia de WhatsApp, multas)
// ============================================================
async function cargarConfig(pool) {
  const r = await pool.query(
    `SELECT clave_admin_app, grupo_jid, valor_multa_inasistencia, valor_multa_invitado_no_show, instance_evolutionapi
     FROM sport_control.configuracion_club WHERE id = 1`
  );
  return r.rows[0];
}

function fechaCorta(f) {
  const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const d = new Date(f);
  return dias[d.getUTCDay()] + ' ' + String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
}

async function enviarWhatsAppGrupo(config, texto) {
  if (!config.grupo_jid) return { enviado: false, razon: 'Falta grupo_jid en configuracion_club' };
  if (!config.instance_evolutionapi) return { enviado: false, razon: 'Falta instance_evolutionapi en configuracion_club' };
  try {
    const url = `https://evolution-api-production-641b.up.railway.app/message/sendText/${config.instance_evolutionapi}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: config.grupo_jid, text: texto }),
    });
    const status = resp.status;
    let cuerpoResp = '';
    try { cuerpoResp = await resp.text(); } catch (e) {}
    if (status >= 200 && status < 300) {
      return { enviado: true, razon: 'ok', status };
    }
    return { enviado: false, razon: 'Evolution API respondio con error', status, cuerpoResp: cuerpoResp.slice(0, 300), url };
  } catch (e) {
    console.error('Aviso al grupo fallo (no bloquea la accion principal):', e);
    return { enviado: false, razon: 'Excepcion al llamar Evolution API', error: String(e && e.message || e) };
  }
}

async function enviarWhatsAppPrivado(config, numero, texto) {
  try {
    await fetch(`https://evolution-api-production-641b.up.railway.app/message/sendText/${config.instance_evolutionapi}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: numero, text: texto }),
    });
  } catch (e) {
    console.error('Envio privado fallo:', e);
  }
}

async function enviarWhatsAppMedia(config, numero, mediaUrl, caption) {
  try {
    await fetch(`https://evolution-api-production-641b.up.railway.app/message/sendMedia/${config.instance_evolutionapi}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: numero, mediatype: 'image', media: mediaUrl, caption }),
    });
  } catch (e) {
    console.error('Envio de media fallo:', e);
  }
}

// ============================================================
// PARTIDOS
// ============================================================

async function listarPartidos(pool) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('id', id, 'alias', alias, 'fecha', fecha, 'hora', hora, 'lugar', lugar, 'estado', estado, 'costo_inscripcion', costo_inscripcion) ORDER BY fecha ASC), '[]'::json) AS partidos
     FROM sport_control.partidos WHERE estado IN ('confirmando', 'cerrado', 'en_juego')`
  );
  return { success: true, data: r.rows[0].partidos };
}

async function crearPartido(pool, config, body) {
  const tipoR = await pool.query(`SELECT id, costo_default, requiere_pago_previo_qr FROM sport_control.tipos_partido WHERE UPPER(nombre) = UPPER($1) LIMIT 1`, [body.tipo]);
  const tipo = tipoR.rows[0];
  if (!tipo) return { success: false, error: 'Tipo de partido no encontrado' };

  const alias = (body.alias || '').trim() || null;
  const costo = (body.costo !== undefined && body.costo !== null && body.costo !== '') ? body.costo : tipo.costo_default;

  const [dd, mm, yyyy] = String(body.fecha).split('/');
  const fechaIso = `${yyyy}-${mm}-${dd}`;

  const ins = await pool.query(
    `INSERT INTO sport_control.partidos (fecha, hora, lugar, alias, estado, tipo_partido_id, costo_inscripcion, requiere_pago_previo_qr)
     VALUES ($1::date, $2::time, $3, $4, 'confirmando', $5, $6, $7)
     RETURNING id, alias, fecha, hora, lugar, estado`,
    [fechaIso, body.hora, body.lugar, alias, tipo.id, costo, tipo.requiere_pago_previo_qr]
  );
  const p = ins.rows[0];
  const titulo = p.alias ? p.alias : ('Partido #' + p.id);
  await enviarWhatsAppGrupo(config, `📅 Nuevo partido: *${titulo}*\n📅 ${fechaCorta(p.fecha)}  🕐 ${p.hora}\n📍 ${p.lugar}\n\nResponde *voy* o *no voy* para confirmar tu asistencia.`);
  return { success: true, data: p };
}

async function cancelarPartido(pool, config, body) {
  const r = await pool.query(`UPDATE sport_control.partidos SET estado = 'cancelado' WHERE id = $1 RETURNING id, alias, fecha, hora, lugar`, [body.id]);
  const p = r.rows[0];
  const titulo = p.alias ? p.alias : ('Partido #' + p.id);
  await enviarWhatsAppGrupo(config, `📅 El partido: *${titulo}*\n📅 ${fechaCorta(p.fecha)}  🕐 ${p.hora}\n📍 ${p.lugar}\n\nFue *cancelado*.`);
  return { success: true, data: p };
}

async function eliminarPartido(pool, body) {
  const c = await pool.query(`SELECT COUNT(*) AS total FROM sport_control.confirmaciones_partido WHERE partido_id = $1`, [body.id]);
  if (Number(c.rows[0].total) !== 0) {
    return { success: false, error: 'Este partido ya tiene confirmaciones, no se puede eliminar. Usa cancelar en su lugar.' };
  }
  await pool.query(`DELETE FROM sport_control.partidos WHERE id = $1`, [body.id]);
  return { success: true };
}

async function editarPartido(pool, config, body) {
  const campo = (body.campo || '').toUpperCase();
  const valor = body.valor || '';
  const id = body.id;
  let r;
  if (campo === 'FECHA') {
    r = await pool.query(`UPDATE sport_control.partidos SET fecha = to_date($1, 'DD/MM/YYYY') WHERE id = $2 RETURNING id, alias, fecha, hora, lugar`, [valor, id]);
  } else if (campo === 'HORA') {
    r = await pool.query(`UPDATE sport_control.partidos SET hora = $1::time WHERE id = $2 RETURNING id, alias, fecha, hora, lugar`, [valor, id]);
  } else if (campo === 'LUGAR') {
    r = await pool.query(`UPDATE sport_control.partidos SET lugar = $1 WHERE id = $2 RETURNING id, alias, fecha, hora, lugar`, [valor, id]);
  } else if (campo === 'ALIAS') {
    r = await pool.query(`UPDATE sport_control.partidos SET alias = $1 WHERE id = $2 RETURNING id, alias, fecha, hora, lugar`, [valor.trim().length === 0 ? null : valor, id]);
  } else {
    return { success: false, error: 'Campo invalido. Usa FECHA, HORA, LUGAR o ALIAS.' };
  }
  const p = r.rows[0];
  const titulo = p.alias ? p.alias : ('Partido #' + p.id);
  await enviarWhatsAppGrupo(config, `✏️ El partido *${titulo}* fue actualizado:\n📅 ${fechaCorta(p.fecha)}  🕐 ${p.hora}\n📍 ${p.lugar}`);
  return { success: true, data: p };
}

async function finalizarPartido(pool, config, body) {
  const r = await pool.query(`UPDATE sport_control.partidos SET estado = 'finalizado' WHERE id = $1 RETURNING id, alias, fecha, hora, lugar`, [body.id]);
  const p = r.rows[0];
  const titulo = p.alias ? p.alias : ('Partido #' + p.id);
  await enviarWhatsAppGrupo(config, `📅El partido: *${titulo}*\n📅 ${fechaCorta(p.fecha)}  🕐 ${p.hora}\n📍 ${p.lugar}\n\nA Finalizado`);

  const tipoInasistencia = await pool.query(`SELECT id FROM sport_control.tipos_multa WHERE nombre = 'Inasistencia sin aviso' LIMIT 1`);
  const tipoInvitadoNoShow = await pool.query(`SELECT id FROM sport_control.tipos_multa WHERE nombre = 'Invitado no show' LIMIT 1`);

  await pool.query(
    `INSERT INTO sport_control.multas (jugador_id, partido_id, tipo_multa_id, monto, estado)
     SELECT cp.jugador_id, cp.partido_id, $1, $2, 'pendiente_aprobacion'
     FROM sport_control.confirmaciones_partido cp
     WHERE cp.partido_id = $3 AND cp.estado = 'confirmado'
       AND NOT EXISTS (SELECT 1 FROM sport_control.codigos_asistencia ca WHERE ca.jugador_id = cp.jugador_id AND ca.partido_id = cp.partido_id AND ca.invitado_asistencia_id IS NULL AND ca.usado = true)`,
    [tipoInasistencia.rows[0].id, config.valor_multa_inasistencia, p.id]
  );

  await pool.query(
    `INSERT INTO sport_control.multas (jugador_id, partido_id, tipo_multa_id, invitado_asistencia_id, monto, estado)
     SELECT ia.jugador_anfitrion_id, ia.partido_id, $1, ia.id, $2, 'pendiente_aprobacion'
     FROM sport_control.invitados_asistencia ia
     WHERE ia.partido_id = $3 AND ia.estado = 'confirmado'
       AND NOT EXISTS (SELECT 1 FROM sport_control.codigos_asistencia ca WHERE ca.invitado_asistencia_id = ia.id AND ca.usado = true)`,
    [tipoInvitadoNoShow.rows[0].id, config.valor_multa_invitado_no_show, p.id]
  );

  const resumen = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('id', m.id, 'nombre', j.nombres || ' ' || j.apellidos, 'motivo', t.nombre, 'monto', m.monto)), '[]'::json) AS multas, COALESCE(SUM(m.monto), 0) AS total
     FROM sport_control.multas m JOIN sport_control.jugadores j ON j.id = m.jugador_id JOIN sport_control.tipos_multa t ON t.id = m.tipo_multa_id
     WHERE m.partido_id = $1 AND m.estado = 'pendiente_aprobacion'`,
    [p.id]
  );
  return { success: true, data: { partidoId: p.id, multas: resumen.rows[0].multas, total: resumen.rows[0].total } };
}

async function marcarEnJuego(pool, body) {
  const r = await pool.query(`UPDATE sport_control.partidos SET estado = 'en_juego' WHERE id = $1 RETURNING id, alias, fecha, hora, lugar, estado`, [body.partidoId]);
  return { success: true, data: r.rows[0] };
}

async function cerrarPartido(pool, body) {
  const r = await pool.query(`UPDATE sport_control.partidos SET estado = 'cerrado' WHERE id = $1 RETURNING id, alias, fecha, hora, lugar, estado`, [body.partidoId]);
  return { success: true, data: r.rows[0] };
}

async function reabrirPartido(pool, body) {
  const r = await pool.query(`UPDATE sport_control.partidos SET estado = 'confirmando' WHERE id = $1 RETURNING id, alias, fecha, hora, lugar, estado`, [body.partidoId]);
  return { success: true, data: r.rows[0] };
}

async function listarTiposPartido(pool) {
  const r = await pool.query(`SELECT COALESCE(json_agg(json_build_object('nombre', nombre, 'costo_default', costo_default) ORDER BY id), '[]'::json) AS tipos FROM sport_control.tipos_partido WHERE activo = true`);
  return { success: true, data: r.rows[0].tipos };
}

module.exports = {
  getPool, cargarConfig, fechaCorta, enviarWhatsAppGrupo, enviarWhatsAppPrivado, enviarWhatsAppMedia,
  listarPartidos, crearPartido, cancelarPartido, eliminarPartido, editarPartido, finalizarPartido,
  marcarEnJuego, cerrarPartido, reabrirPartido, listarTiposPartido,
};
