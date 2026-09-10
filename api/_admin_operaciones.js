// api/_admin_operaciones.js

async function obtenerParametros(pool) {
  const r = await pool.query(
    `SELECT (SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1) AS cuota_mensual,
            (SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'invitado' AND activo = true ORDER BY prioridad ASC LIMIT 1) AS costo_invitado,
            valor_multa_inasistencia, valor_multa_invitado_no_show, meses_maximo_atraso, numero_admin,
            to_char(fecha_inicio_recaudacion, 'DD/MM/YYYY') AS fecha_inicio_recaudacion, meses_retener_codigos
     FROM sport_control.configuracion_club WHERE id = 1`
  );
  return { success: true, data: r.rows[0] };
}

async function actualizarParametro(pool, body) {
  const { campo, valor } = body;
  const map = {
    cuota_mensual: { sql: `UPDATE sport_control.catalogo_cobros SET valor = $1 WHERE tipo = 'mensualidad' AND activo = true`, val: valor },
    costo_invitado: { sql: `UPDATE sport_control.catalogo_cobros SET valor = $1 WHERE tipo = 'invitado' AND activo = true`, val: valor },
    multa_inasistencia: { sql: `UPDATE sport_control.configuracion_club SET valor_multa_inasistencia = $1 WHERE id = 1`, val: valor },
    multa_invitado_no_show: { sql: `UPDATE sport_control.configuracion_club SET valor_multa_invitado_no_show = $1 WHERE id = 1`, val: valor },
    meses_maximo_atraso: { sql: `UPDATE sport_control.configuracion_club SET meses_maximo_atraso = $1 WHERE id = 1`, val: valor },
    numero_admin: { sql: `UPDATE sport_control.configuracion_club SET numero_admin = $1 WHERE id = 1`, val: valor },
    meses_retener_codigos: { sql: `UPDATE sport_control.configuracion_club SET meses_retener_codigos = $1 WHERE id = 1`, val: valor },
  };
  if (campo === 'fecha_inicio_recaudacion') {
    const partes = String(valor).trim().split('/');
    if (partes.length !== 3) return { success: false, error: 'Campo de parametro no reconocido.' };
    const iso = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
    await pool.query(`UPDATE sport_control.configuracion_club SET fecha_inicio_recaudacion = $1::date WHERE id = 1`, [iso]);
    return { success: true };
  }
  const entry = map[campo];
  if (!entry) return { success: false, error: 'Campo de parametro no reconocido.' };
  await pool.query(entry.sql, [entry.val]);
  return { success: true };
}

async function reenviarQrJugador(pool, config, body) {
  const r = await pool.query(
    `SELECT ca.token, j.telefono, j.nombres, j.apellidos FROM sport_control.codigos_asistencia ca JOIN sport_control.jugadores j ON j.id = ca.jugador_id
     WHERE ca.partido_id = $1 AND ca.jugador_id = $2 AND ca.invitado_asistencia_id IS NULL LIMIT 1`,
    [body.partidoId, body.jugadorId]
  );
  const row = r.rows[0];
  if (!row || !row.token) return { success: false, error: 'Este jugador todavia no tiene un codigo QR generado.' };
  const waLink = 'https://wa.me/15122281262?text=ASISTIO-' + row.token;
  const mediaUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=20&ecc=M&data=' + encodeURIComponent(waLink);
  const { enviarWhatsAppMedia } = require('./_admin_partidos');
  await enviarWhatsAppMedia(config, row.telefono, mediaUrl, 'Tu codigo de asistencia para el partido.');
  return { success: true };
}

async function anularMulta(pool, body) {
  const { partidoId, todas, ids } = body;
  let r;
  if (todas) {
    r = await pool.query(`UPDATE sport_control.multas SET estado = 'anulada', anulada_en = NOW() WHERE partido_id = $1 AND estado = 'pendiente_aprobacion'`, [partidoId]);
  } else {
    const idsLimpios = (ids || []).filter((id) => Number.isInteger(id) || /^\d+$/.test(id)).map(Number);
    if (idsLimpios.length === 0) return { success: false, error: 'No se especificaron multas validas para anular.' };
    r = await pool.query(`UPDATE sport_control.multas SET estado = 'anulada', anulada_en = NOW() WHERE partido_id = $1 AND estado = 'pendiente_aprobacion' AND id = ANY($2::int[])`, [partidoId, idsLimpios]);
  }
  const resumen = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('id', m.id, 'nombre', j.nombres || ' ' || j.apellidos, 'motivo', t.nombre, 'monto', m.monto)), '[]'::json) AS multas, COALESCE(SUM(m.monto), 0) AS total
     FROM sport_control.multas m JOIN sport_control.jugadores j ON j.id = m.jugador_id JOIN sport_control.tipos_multa t ON t.id = m.tipo_multa_id
     WHERE m.partido_id = $1 AND m.estado = 'pendiente_aprobacion'`,
    [partidoId]
  );
  return { success: true, data: { multas: resumen.rows[0].multas, total: resumen.rows[0].total } };
}

async function confirmarMultas(pool, config, body) {
  await pool.query(`UPDATE sport_control.multas SET estado = 'aprobada', aprobada_en = NOW() WHERE partido_id = $1 AND estado = 'pendiente_aprobacion'`, [body.partidoId]);
  const resumen = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('nombre', nombre, 'total', total)), '[]'::json) AS jugadores, COALESCE(SUM(total), 0) AS "granTotal"
     FROM (SELECT j.nombres || ' ' || j.apellidos AS nombre, SUM(m.monto) AS total FROM sport_control.multas m JOIN sport_control.jugadores j ON j.id = m.jugador_id WHERE m.partido_id = $1 AND m.estado = 'aprobada' GROUP BY j.id, j.nombres, j.apellidos) sub`,
    [body.partidoId]
  );
  const jugadores = resumen.rows[0].jugadores;
  const granTotal = Number(resumen.rows[0].granTotal);
  if (granTotal > 0) {
    const lineas = jugadores.map((j) => '• ' + j.nombre + ': $' + j.total);
    await enviarWhatsAppGrupoConfig(config, '💰 *Multas del partido*\n\n' + lineas.join('\n') + '\n\nTotal: $' + granTotal);
  }
  return { success: true, data: { jugadores, granTotal } };
}
async function enviarWhatsAppGrupoConfig(config, texto) {
  const { enviarWhatsAppGrupo } = require('./_admin_partidos');
  await enviarWhatsAppGrupo(config, texto);
}

async function toggleAsistencia(pool, body) {
  const { tipo, id, partidoId, presente } = body;
  const where = tipo === 'invitado' ? `invitado_asistencia_id = $2` : `jugador_id = $2 AND invitado_asistencia_id IS NULL`;
  const buscar = await pool.query(`SELECT id FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND ${where} LIMIT 1`, [partidoId, id]);
  const existente = buscar.rows[0];

  if (existente) {
    await pool.query(`UPDATE sport_control.codigos_asistencia SET usado = $1, escaneado_en = ${presente ? 'NOW()' : 'NULL'} WHERE id = $2`, [!!presente, existente.id]);
    return { success: true };
  }

  if (presente) {
    const token = Math.random().toString(36).substring(2, 8).toUpperCase();
    if (tipo === 'invitado') {
      await pool.query(
        `INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, invitado_asistencia_id, token, usado, escaneado_en)
         SELECT $1, jugador_anfitrion_id, $2, $3, true, NOW() FROM sport_control.invitados_asistencia WHERE id = $2`,
        [partidoId, id, token]
      );
    } else {
      await pool.query(
        `INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, token, usado, escaneado_en) VALUES ($1, $2, $3, true, NOW())`,
        [partidoId, id, token]
      );
    }
  }
  return { success: true };
}

async function enviarRecordatorioPartido(pool, config, body) {
  const r = await pool.query(
    `SELECT p.id, p.alias, p.fecha, p.hora, p.lugar, p.estado, sport_control.lista_confirmados_partido(p.id) AS lista FROM sport_control.partidos p WHERE p.id = $1`,
    [body.partidoId]
  );
  const p = r.rows[0];
  const titulo = p.alias ? p.alias : 'Partido';
  const lista = p.lista || [];
  const lineas = lista.map((item, i) => item.tipo === 'invitado' ? `${i + 1}. 🎟️ ${item.nombre} (invitado de ${item.anfitrion})` : `${i + 1}. ${item.nombre}`);
  const { fechaCorta, enviarWhatsAppGrupo } = require('./_admin_partidos');
  const texto = '⏰ *Recordatorio: ' + titulo + '*\n📅 ' + fechaCorta(p.fecha) + '  🕐 ' + (p.hora || '') + '\n📍 ' + (p.lugar || '') + '\n\nConfirmados (' + lista.length + '):\n\n' + (lineas.length > 0 ? lineas.join('\n') : 'Nadie confirmado todavía.') + '\n\nResponde *voy* o *no voy* para confirmar tu asistencia.';
  await enviarWhatsAppGrupo(config, texto);
  return { success: true };
}

async function enviarRecordatorioMorosos(pool, config) {
  const r = await pool.query(
    `SELECT j.id, j.telefono, j.nombres, sport_control.meses_atraso(j.id) AS meses_atraso,
            sport_control.meses_atraso(j.id) * COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0) AS deuda
     FROM sport_control.jugadores j WHERE j.estado = 'activo' AND sport_control.meses_atraso(j.id) > (SELECT meses_maximo_atraso FROM sport_control.configuracion_club WHERE id = 1) AND NOT j.autorizado_excepcion_pago`
  );
  const { enviarWhatsAppPrivado } = require('./_admin_partidos');
  for (const j of r.rows) {
    const texto = `⚠️ Hola ${j.nombres}, este es un recordatorio de pago. Tienes ${j.meses_atraso} mes(es) de mensualidad pendiente (aprox. $${j.deuda}). Por favor regulariza tu pago cuando puedas. ¡Gracias! ⚽`;
    await enviarWhatsAppPrivado(config, j.telefono, texto);
  }
  return { success: true, data: { enviados: r.rows.length } };
}

async function marcarPagoInvitado(pool, body) {
  await pool.query(`UPDATE sport_control.invitados_asistencia SET pagado = $1 WHERE id = $2`, [!!body.pagado, body.invitadoId]);
  return { success: true };
}

async function marcarMultaPagada(pool, body) {
  await pool.query(`UPDATE sport_control.multas SET pagada = $1, pagada_en = CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id = $2`, [!!body.pagada, body.multaId]);
  return { success: true };
}

module.exports = {
  obtenerParametros, actualizarParametro, reenviarQrJugador, anularMulta, confirmarMultas,
  toggleAsistencia, enviarRecordatorioPartido, enviarRecordatorioMorosos, marcarPagoInvitado, marcarMultaPagada,
};
