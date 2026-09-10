// api/_admin_pagos.js

async function registrarPagoEfectivo(pool, body) {
  const cobro = await pool.query(`SELECT id, valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1`);
  const { id: tipoCobroId, valor } = cobro.rows[0];
  await pool.query(
    `INSERT INTO sport_control.pagos (jugador_id, tipo_cobro_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, creado_en)
     VALUES ($1, $2, $3, $4, 'Efectivo (cancha)', CURRENT_DATE, 'efectivo', 'confirmado', NOW())`,
    [body.jugadorId, tipoCobroId, valor, `EFECTIVO-${body.jugadorId}-${Date.now()}`]
  );
  return { success: true };
}

async function marcarMesesPagados(pool, body) {
  const ref = await pool.query(
    `SELECT j.id AS jugador_id,
       GREATEST((SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)::timestamp,
         COALESCE((SELECT MAX(pg.creado_en) FROM sport_control.pagos pg WHERE pg.jugador_id = j.id AND pg.estado = 'confirmado' AND pg.tipo_cobro_id IN (SELECT id FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad')), j.creado_en)) AS fecha_referencia,
       (SELECT id FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1) AS tipo_cobro_id,
       COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0) AS cuota_mensual
     FROM sport_control.jugadores j WHERE j.id = $1`,
    [body.jugadorId]
  );
  const row = ref.rows[0];
  const monto = Number(body.cantidadMeses) * Number(row.cuota_mensual);
  await pool.query(
    `INSERT INTO sport_control.pagos (jugador_id, tipo_cobro_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, creado_en)
     VALUES ($1, $2, $3, $4, 'Efectivo (meses)', CURRENT_DATE, 'efectivo', 'confirmado', LEAST(NOW(), $5::timestamp + ($6 || ' months')::interval))`,
    [row.jugador_id, row.tipo_cobro_id, monto, `EFECTIVO-MESES-${row.jugador_id}-${Date.now()}`, row.fecha_referencia, body.cantidadMeses]
  );
  return { success: true };
}

function formatearResultadoPago(tipoConcepto, r) {
  let mensaje = '';
  let restante = 0;
  if (tipoConcepto === 'mensualidad') {
    mensaje = r.meses_cubiertos > 0 ? 'Se aplicaron ' + r.meses_cubiertos + ' mes(es) de mensualidad.' : 'El monto no alcanza para cubrir un mes completo.';
    restante = Number(r.restante);
  } else if (tipoConcepto === 'invitado') {
    mensaje = r.cubiertos > 0 ? 'Se cubrieron ' + r.cubiertos + ' invitado(s) (más antiguo primero).' : 'El monto no alcanza para cubrir un invitado.';
    if (r.pendientes > 0) mensaje += ' Quedan ' + r.pendientes + ' pendiente(s).';
    restante = Number(r.restante);
  } else if (tipoConcepto === 'multas_propias' || tipoConcepto === 'multas_invitados') {
    mensaje = r.cubiertas > 0 ? 'Se cubrieron ' + r.cubiertas + ' multa(s).' : 'El monto no alcanza para cubrir una multa.';
    if (r.pendientes > 0) mensaje += ' Quedan ' + r.pendientes + ' pendiente(s).';
    restante = Number(r.restante);
  } else if (tipoConcepto === 'partido_especial') {
    mensaje = 'Pago de partido especial registrado.';
    restante = Number(r.restante);
  }
  return { mensaje, restante };
}

async function registrarPagoCategorizado(pool, body) {
  const { jugadorId, monto, tipoConcepto, partidoId, conceptoMonto } = body;
  const ins = await pool.query(
    `INSERT INTO sport_control.pagos (jugador_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, tipo_concepto, creado_en, partido_id)
     VALUES ($1, $2, $3, 'Efectivo', CURRENT_DATE, 'efectivo', 'confirmado', $4, NOW(), $5) RETURNING id`,
    [jugadorId, monto, `EFECTIVO-CAT-${jugadorId}-${Date.now()}`, tipoConcepto, partidoId || null]
  );
  const pagoId = ins.rows[0].id;

  let resultado;
  if (tipoConcepto === 'mensualidad') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_mensualidad($1, $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'invitado') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_invitados($1, $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'multas_propias') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'propia', $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'multas_invitados') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'invitado', $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'partido_especial') {
    resultado = { restante: Math.max(Number(monto) - Number(conceptoMonto), 0) };
  } else {
    return { success: false, error: 'Concepto de pago no reconocido' };
  }

  let { mensaje, restante } = formatearResultadoPago(tipoConcepto, resultado);
  if (restante > 0.009) mensaje += ' Sobran $' + restante.toFixed(2) + ' (quedan disponibles para otro concepto).';
  return { success: true, data: { mensaje, restante } };
}

async function verRecaudadoMes(pool) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('jugadorId', jugador_id, 'nombre', nombre, 'total', total, 'transferencia', transferencia, 'efectivo', efectivo) ORDER BY total DESC), '[]'::json) AS jugadores
     FROM (SELECT j.id AS jugador_id, j.nombres || ' ' || j.apellidos AS nombre, SUM(pg.monto) AS total,
             SUM(CASE WHEN pg.metodo_pago = 'transferencia' THEN pg.monto ELSE 0 END) AS transferencia,
             SUM(CASE WHEN pg.metodo_pago = 'efectivo' THEN pg.monto ELSE 0 END) AS efectivo
           FROM sport_control.pagos pg JOIN sport_control.jugadores j ON j.id = pg.jugador_id
           WHERE pg.estado = 'confirmado' AND date_trunc('month', pg.creado_en) = date_trunc('month', CURRENT_DATE)
           GROUP BY j.id, j.nombres, j.apellidos) sub`
  );
  const jugadores = r.rows[0].jugadores;
  const granTotal = jugadores.reduce((s, j) => s + Number(j.total), 0);
  const granTransferencia = jugadores.reduce((s, j) => s + Number(j.transferencia), 0);
  const granEfectivo = jugadores.reduce((s, j) => s + Number(j.efectivo), 0);
  return { success: true, data: { jugadores, granTotal, granTransferencia, granEfectivo } };
}

async function listarInformeCompleto(pool) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object(
       'nombre', j.nombres || ' ' || j.apellidos, 'telefono', j.telefono,
       'totalPagadoHistorico', COALESCE(pg_hist.total, 0), 'pagadoEsteMes', COALESCE(pg_mes.total, 0),
       'mesesAtraso', sport_control.meses_atraso(j.id),
       'deudaMensualidad', GREATEST(sport_control.meses_atraso(j.id), 1) * COALESCE(cuota.valor, 0),
       'deudaInvitados', COALESCE(inv.total, 0), 'deudaMultasPropias', COALESCE(mp.total, 0), 'deudaMultasInvitados', COALESCE(mi.total, 0), 'deudaPartidosEspeciales', COALESCE(pe.total, 0),
       'deudaTotal', GREATEST(sport_control.meses_atraso(j.id), 1) * COALESCE(cuota.valor, 0) + COALESCE(inv.total, 0) + COALESCE(mp.total, 0) + COALESCE(mi.total, 0) + COALESCE(pe.total, 0),
       'saldoAFavor', COALESCE(sf.total, 0),
       'saldo', GREATEST((sport_control.meses_atraso(j.id) * COALESCE(cuota.valor, 0) + COALESCE(inv.total, 0) + COALESCE(mp.total, 0) + COALESCE(mi.total, 0) + COALESCE(pe.total, 0)) - COALESCE(sf.total, 0), 0),
       'moroso', sport_control.meses_atraso(j.id) > (SELECT meses_maximo_atraso FROM sport_control.configuracion_club WHERE id = 1) AND NOT j.autorizado_excepcion_pago
     ) ORDER BY j.nombres), '[]'::json) AS jugadores
     FROM sport_control.jugadores j
     CROSS JOIN LATERAL (SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1) cuota
     LEFT JOIN LATERAL (SELECT SUM(monto) AS total FROM sport_control.pagos WHERE jugador_id = j.id AND estado = 'confirmado') pg_hist ON true
     LEFT JOIN LATERAL (SELECT SUM(monto) AS total FROM sport_control.pagos WHERE jugador_id = j.id AND estado = 'confirmado' AND date_trunc('month', creado_en) = date_trunc('month', CURRENT_DATE)) pg_mes ON true
     LEFT JOIN LATERAL (SELECT COUNT(*) * COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'invitado' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0) AS total FROM sport_control.invitados_asistencia ia JOIN sport_control.partidos p ON p.id = ia.partido_id WHERE ia.jugador_anfitrion_id = j.id AND ia.estado = 'confirmado' AND COALESCE(ia.pagado, false) = false AND p.estado = 'finalizado' AND p.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1) AND NOT EXISTS (SELECT 1 FROM sport_control.multas mx WHERE mx.invitado_asistencia_id = ia.id)) inv ON true
     LEFT JOIN LATERAL (SELECT SUM(m.monto) AS total FROM sport_control.multas m JOIN sport_control.partidos p ON p.id = m.partido_id WHERE m.jugador_id = j.id AND m.origen_multa = 'propia' AND m.estado IN ('pendiente_aprobacion', 'aprobada') AND COALESCE(m.pagada, false) = false AND p.estado = 'finalizado' AND p.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)) mp ON true
     LEFT JOIN LATERAL (SELECT SUM(m.monto) AS total FROM sport_control.multas m JOIN sport_control.partidos p ON p.id = m.partido_id WHERE m.jugador_id = j.id AND m.origen_multa = 'invitado' AND m.estado IN ('pendiente_aprobacion', 'aprobada') AND COALESCE(m.pagada, false) = false AND p.estado = 'finalizado' AND p.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)) mi ON true
     LEFT JOIN LATERAL (SELECT SUM(p.costo_inscripcion) AS total FROM sport_control.partidos p JOIN sport_control.confirmaciones_partido cp ON cp.partido_id = p.id AND cp.jugador_id = j.id AND cp.estado = 'confirmado' WHERE p.costo_inscripcion IS NOT NULL AND p.costo_inscripcion > 0 AND NOT EXISTS (SELECT 1 FROM sport_control.pagos pg2 WHERE pg2.partido_id = p.id AND pg2.jugador_id = j.id AND pg2.estado = 'confirmado')) pe ON true
     LEFT JOIN LATERAL (SELECT SUM(monto) AS total FROM sport_control.saldo_a_favor WHERE jugador_id = j.id AND usado = false) sf ON true
     WHERE j.estado = 'activo'`
  );
  return { success: true, data: r.rows[0].jugadores };
}

async function obtenerDashboard(pool) {
  const r = await pool.query(
    `WITH base AS (SELECT j.id, sport_control.meses_atraso(j.id) AS meses_atraso, j.autorizado_excepcion_pago FROM sport_control.jugadores j WHERE j.estado = 'activo')
     SELECT (SELECT COUNT(*) FROM base) AS total_jugadores,
       (SELECT COUNT(*) FROM base WHERE meses_atraso > (SELECT meses_maximo_atraso FROM sport_control.configuracion_club WHERE id = 1) AND NOT autorizado_excepcion_pago) AS total_morosos,
       (SELECT COUNT(*) FROM base WHERE meses_atraso = 1) AS atraso_1, (SELECT COUNT(*) FROM base WHERE meses_atraso = 2) AS atraso_2, (SELECT COUNT(*) FROM base WHERE meses_atraso >= 3) AS atraso_3mas,
       (SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1) AS cuota_mensual,
       (SELECT COALESCE(SUM(pg.monto), 0) FROM sport_control.pagos pg WHERE pg.estado = 'confirmado' AND date_trunc('month', pg.creado_en) = date_trunc('month', CURRENT_DATE)) AS recaudado_mes,
       ((SELECT COUNT(*) FROM base) * COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0)) AS esperado_mes,
       (SELECT COUNT(*) FROM sport_control.jugadores WHERE date_trunc('month', creado_en) = date_trunc('month', CURRENT_DATE)) AS nuevos_mes,
       (SELECT COALESCE(SUM(m.monto), 0) FROM sport_control.multas m JOIN sport_control.partidos p ON p.id = m.partido_id WHERE m.estado = 'pendiente_aprobacion' AND p.estado = 'finalizado' AND p.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)) AS multas_pendientes_monto,
       (SELECT COUNT(DISTINCT m.partido_id) FROM sport_control.multas m JOIN sport_control.partidos p ON p.id = m.partido_id WHERE m.estado = 'pendiente_aprobacion' AND p.estado = 'finalizado' AND p.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)) AS multas_pendientes_partidos`
  );
  return { success: true, data: r.rows[0] };
}

async function listarEstadoPagos(pool) {
  const r = await pool.query(
    `WITH base AS (SELECT j.nombres || ' ' || j.apellidos AS nombre, j.telefono, j.autorizado_excepcion_pago, sport_control.meses_atraso(j.id) AS meses_atraso FROM sport_control.jugadores j WHERE j.estado = 'activo')
     SELECT COALESCE(json_agg(json_build_object('nombre', nombre, 'telefono', telefono, 'mesesAtraso', meses_atraso,
       'moroso', meses_atraso > (SELECT meses_maximo_atraso FROM sport_control.configuracion_club WHERE id = 1) AND NOT autorizado_excepcion_pago,
       'deudaEstimada', meses_atraso * COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0)
     ) ORDER BY meses_atraso DESC, nombre), '[]'::json) AS jugadores FROM base`
  );
  return { success: true, data: r.rows[0].jugadores };
}

async function analizarComprobanteAdmin(pool, body) {
  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'Eres un asistente que extrae datos de comprobantes de pago bancarios (transferencias) de Ecuador. Devuelve SOLO un JSON con las claves: esComprobante (boolean), numeroComprobante (string), monto (number), banco (string), fechaComprobante (string formato YYYY-MM-DD), titular (string), confianza (number 0-1). Si la imagen no es un comprobante de pago, esComprobante debe ser false.' },
        { role: 'user', content: [{ type: 'text', text: 'Extrae los datos de este comprobante de pago.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${body.imagenBase64}` } }] },
      ],
    }),
  });
  const openaiJson = await openaiRes.json();
  let datos = { esComprobante: false };
  try { datos = JSON.parse(openaiJson.choices[0].message.content); } catch (e) { datos = { esComprobante: false }; }
  const numeroComprobante = datos.numeroComprobante || '';
  const dup = await pool.query(`SELECT COUNT(*) AS existe FROM sport_control.pagos WHERE numero_comprobante = $1`, [numeroComprobante]);
  return {
    success: true,
    data: {
      esComprobante: datos.esComprobante === true,
      numeroComprobante,
      monto: datos.monto || 0,
      banco: datos.banco || '',
      fechaComprobante: datos.fechaComprobante || '',
      duplicado: Number(dup.rows[0].existe) > 0,
    },
  };
}

async function registrarPagoComprobanteAdmin(pool, body) {
  const r = await pool.query(
    `INSERT INTO sport_control.pagos (jugador_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, creado_en)
     VALUES ($1, $2, $3, $4, $5::date, 'transferencia', 'confirmado', NOW()) RETURNING id`,
    [body.jugadorId, body.monto, body.numeroComprobante, body.banco, body.fecha]
  );
  return { success: true, data: { pagoId: r.rows[0].id, monto: body.monto } };
}

async function aplicarPagoComprobanteAdmin(pool, body) {
  const { jugadorId, pagoId, monto, tipoConcepto, conceptoMonto } = body;
  let resultado;
  if (tipoConcepto === 'mensualidad') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_mensualidad($1, $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'invitado') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_invitados($1, $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'multas_propias') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'propia', $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'multas_invitados') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'invitado', $2, $3) AS resultado`, [jugadorId, pagoId, monto])).rows[0].resultado;
  } else if (tipoConcepto === 'partido_especial') {
    resultado = { restante: Math.max(Number(monto) - Number(conceptoMonto), 0) };
  } else {
    return { success: false, error: 'Concepto de pago no reconocido' };
  }
  const { mensaje, restante } = formatearResultadoPago(tipoConcepto, resultado);
  return { success: true, data: { mensaje, restante, pagoId } };
}

async function guardarSaldoFavorAdmin(pool, body) {
  await pool.query(`SELECT sport_control.crear_saldo_favor($1, $2, $3) AS saldo_id`, [body.jugadorId, body.monto, body.pagoId]);
  return { success: true, data: true };
}

async function verPendientesCategorizado(pool, body) {
  const r = await pool.query(`SELECT sport_control.pendientes_jugador($1) AS pendientes`, [body.jugadorId]);
  return { success: true, data: r.rows[0].pendientes };
}

module.exports = {
  registrarPagoEfectivo, marcarMesesPagados, registrarPagoCategorizado, verRecaudadoMes, listarInformeCompleto,
  obtenerDashboard, listarEstadoPagos, analizarComprobanteAdmin, registrarPagoComprobanteAdmin,
  aplicarPagoComprobanteAdmin, guardarSaldoFavorAdmin, verPendientesCategorizado,
};
