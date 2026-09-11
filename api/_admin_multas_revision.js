// api/_admin_multas_revision.js
// Pantalla "Revisar multas y pendientes": genera las multas automaticas
// (inasistencia propia, invitado no-show) de forma idempotente -- segura
// de llamar varias veces, solo genera lo que falte -- y agrupa junto con
// los invitados que asistieron pero no han pagado, todo por jugador.
// Incluye el envio individual (WhatsApp privado + push) y el resumen
// completo al grupo.

const { fechaCorta, enviarWhatsAppGrupo, enviarWhatsAppPrivado } = require('./_admin_partidos');

async function generarMultasSiFaltan(pool, config, partidoId) {
  if (!config.tipo_multa_inasistencia_id) {
    console.error("configuracion_club.tipo_multa_inasistencia_id no esta configurado -- corre configurar_tipos_multa_automaticos.sql. Se omite la generacion de esa multa.");
  } else {
    await pool.query(
      `INSERT INTO sport_control.multas (jugador_id, partido_id, tipo_multa_id, monto, estado)
       SELECT cp.jugador_id, cp.partido_id, $1, $2, 'pendiente_aprobacion'
       FROM sport_control.confirmaciones_partido cp
       WHERE cp.partido_id = $3 AND cp.estado = 'confirmado'
         AND NOT EXISTS (SELECT 1 FROM sport_control.codigos_asistencia ca WHERE ca.jugador_id = cp.jugador_id AND ca.partido_id = cp.partido_id AND ca.invitado_asistencia_id IS NULL AND ca.usado = true)
         AND NOT EXISTS (SELECT 1 FROM sport_control.multas m2 WHERE m2.jugador_id = cp.jugador_id AND m2.partido_id = cp.partido_id AND m2.invitado_asistencia_id IS NULL)`,
      [config.tipo_multa_inasistencia_id, config.valor_multa_inasistencia, partidoId]
    );
  }

  if (!config.tipo_multa_invitado_id) {
    console.error("configuracion_club.tipo_multa_invitado_id no esta configurado -- corre configurar_tipos_multa_automaticos.sql. Se omite la generacion de esa multa.");
  } else {
    await pool.query(
      `INSERT INTO sport_control.multas (jugador_id, partido_id, tipo_multa_id, invitado_asistencia_id, monto, estado)
       SELECT ia.jugador_anfitrion_id, ia.partido_id, $1, ia.id, $2, 'pendiente_aprobacion'
       FROM sport_control.invitados_asistencia ia
       WHERE ia.partido_id = $3 AND ia.estado = 'confirmado'
         AND NOT EXISTS (SELECT 1 FROM sport_control.codigos_asistencia ca WHERE ca.invitado_asistencia_id = ia.id AND ca.usado = true)
         AND NOT EXISTS (SELECT 1 FROM sport_control.multas m3 WHERE m3.invitado_asistencia_id = ia.id)`,
      [config.tipo_multa_invitado_id, config.valor_multa_invitado_no_show, partidoId]
    );
  }
}

async function obtenerPendientesAgrupados(pool, partidoId) {
  // Multas (propias + por invitados no-show), todas ya asociadas a un jugador_id (el anfitrion en el caso de invitados)
  const multas = await pool.query(
    `SELECT m.id AS "multaId", m.jugador_id AS "jugadorId", j.nombres || ' ' || j.apellidos AS nombre, j.telefono,
            CASE WHEN m.invitado_asistencia_id IS NOT NULL THEN 'Invitado no show: ' || ia.nombre ELSE t.nombre END AS motivo,
            m.monto
     FROM sport_control.multas m
     JOIN sport_control.jugadores j ON j.id = m.jugador_id
     JOIN sport_control.tipos_multa t ON t.id = m.tipo_multa_id
     LEFT JOIN sport_control.invitados_asistencia ia ON ia.id = m.invitado_asistencia_id
     WHERE m.partido_id = $1 AND m.estado IN ('pendiente_aprobacion', 'aprobada') AND COALESCE(m.pagada, false) = false`,
    [partidoId]
  );

  // Invitados que SI asistieron (su codigo fue usado) pero no han pagado su costo de entrada
  const invitadosSinPagar = await pool.query(
    `SELECT ia.jugador_anfitrion_id AS "jugadorId", j.nombres || ' ' || j.apellidos AS nombre, j.telefono,
            'Invitado sin pagar: ' || ia.nombre AS motivo,
            COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'invitado' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0) AS monto
     FROM sport_control.invitados_asistencia ia
     JOIN sport_control.jugadores j ON j.id = ia.jugador_anfitrion_id
     WHERE ia.partido_id = $1 AND ia.estado = 'confirmado' AND COALESCE(ia.pagado, false) = false
       AND EXISTS (SELECT 1 FROM sport_control.codigos_asistencia ca WHERE ca.invitado_asistencia_id = ia.id AND ca.usado = true)`,
    [partidoId]
  );

  const porJugador = {};
  for (const row of [...multas.rows, ...invitadosSinPagar.rows]) {
    if (!porJugador[row.jugadorId]) {
      porJugador[row.jugadorId] = { jugadorId: row.jugadorId, nombre: row.nombre, telefono: row.telefono, items: [], total: 0 };
    }
    porJugador[row.jugadorId].items.push({ motivo: row.motivo, monto: Number(row.monto), multaId: row.multaId || null });
    porJugador[row.jugadorId].total += Number(row.monto);
  }
  return Object.values(porJugador).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

async function revisarMultasPartido(pool, config, body) {
  const { partidoId } = body;
  await generarMultasSiFaltan(pool, config, partidoId);
  const jugadores = await obtenerPendientesAgrupados(pool, partidoId);
  const pInfo = await pool.query(`SELECT id, alias, fecha, hora, lugar FROM sport_control.partidos WHERE id = $1`, [partidoId]);
  return { success: true, data: { partido: pInfo.rows[0], jugadores } };
}

async function enviarPushPendiente(jugadorId, montoTotal) {
  try {
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic Key ${process.env.ONESIGNAL_REST_API_KEY}` },
      body: JSON.stringify({
        app_id: '94fc2cb8-f935-4abc-b237-ea9d81c1eb81',
        include_aliases: { external_id: [String(jugadorId)] },
        target_channel: 'push',
        headings: { en: '⚠️ Pendientes del partido anterior' },
        contents: { en: `Tienes $${montoTotal.toFixed(2)} pendientes (multas o invitados). Revisa y paga desde la app.` },
        url: 'https://club-monitor-users.vercel.app/',
      }),
    });
  } catch (e) {
    console.error('Push de pendiente fallo (no bloquea el envio de WhatsApp):', e);
  }
}

async function enviarMultasJugadoresApp(pool, config, body) {
  const { partidoId, jugadorIds } = body;
  const jugadores = await obtenerPendientesAgrupados(pool, partidoId);
  const pInfo = await pool.query(`SELECT alias, fecha, hora, lugar FROM sport_control.partidos WHERE id = $1`, [partidoId]);
  const p = pInfo.rows[0];
  const titulo = p.alias ? p.alias : ('Partido #' + partidoId);

  let enviados = 0;
  for (const jugadorId of jugadorIds) {
    const j = jugadores.find((x) => Number(x.jugadorId) === Number(jugadorId));
    if (!j) continue;
    const lineas = j.items.map((it) => `• ${it.motivo}: $${it.monto}`);
    const texto = `⚠️ Hola ${j.nombre.split(' ')[0]}, tienes pendientes del partido *${titulo}* (${fechaCorta(p.fecha)}):\n\n${lineas.join('\n')}\n\nTotal: $${j.total.toFixed(2)}\n\nPor favor usa la app del club para registrar tu pago. ¡Gracias! ⚽`;
    await enviarWhatsAppPrivado(config, j.telefono, texto);
    await enviarPushPendiente(jugadorId, j.total);
    enviados++;
  }
  return { success: true, data: { enviados } };
}

async function enviarResumenMultasGrupoApp(pool, config, body) {
  const { partidoId } = body;
  const jugadores = await obtenerPendientesAgrupados(pool, partidoId);
  const pInfo = await pool.query(`SELECT alias, fecha, hora, lugar FROM sport_control.partidos WHERE id = $1`, [partidoId]);
  const p = pInfo.rows[0];
  const titulo = p.alias ? p.alias : ('Partido #' + partidoId);

  if (jugadores.length === 0) {
    await enviarWhatsAppGrupo(config, `📢 *Resumen de pendientes: ${titulo}*\n${fechaCorta(p.fecha)}\n\n✅ No hay multas ni pendientes de invitados. ¡Todo en orden!`);
    return { success: true };
  }

  const bloques = jugadores.map((j) => {
    const lineas = j.items.map((it) => `   • ${it.motivo}: $${it.monto}`);
    return `👤 *${j.nombre}* — Total: $${j.total.toFixed(2)}\n${lineas.join('\n')}`;
  });
  const granTotal = jugadores.reduce((s, j) => s + j.total, 0);
  const texto = `📢 *Resumen de pendientes: ${titulo}*\n📅 ${fechaCorta(p.fecha)}\n\n${bloques.join('\n\n')}\n\n💰 Total general: $${granTotal.toFixed(2)}\n\nPor favor usen la app del club para registrar sus pagos. ¡Gracias! ⚽`;

  await enviarWhatsAppGrupo(config, texto);
  await pool.query(`UPDATE sport_control.multas SET estado = 'aprobada', aprobada_en = NOW() WHERE partido_id = $1 AND estado = 'pendiente_aprobacion'`, [partidoId]);
  return { success: true };
}

module.exports = { revisarMultasPartido, enviarMultasJugadoresApp, enviarResumenMultasGrupoApp };
