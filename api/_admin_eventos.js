// api/_admin_eventos.js
// Modulo de Eventos (torneos, viajes especiales), con soporte para
// MULTIPLES FECHAS/SEDES dentro de un mismo evento. Presupuesto, cuotas
// y movimientos pueden ser generales del evento (evento_fecha_id = NULL)
// o especificos de una fecha puntual.
//
// El catalogo de rubros (tipos_movimiento_evento) se administra con sus
// propias 3 funciones al final de este archivo (tiene un campo extra
// 'tipo' que no encaja en el CRUD generico de _admin_exentos_catalogos.js).

async function crearEvento(pool, body) {
  const { nombre, descripcion, lugar, fechaInicio, fechaFin } = body;
  if (!nombre) return { success: false, error: 'El evento necesita un nombre.' };
  const r = await pool.query(
    `INSERT INTO sport_control.eventos (nombre, descripcion, lugar, fecha_inicio, fecha_fin, estado, creado_en)
     VALUES ($1, $2, $3, $4, $5, 'planificacion', NOW()) RETURNING id`,
    [nombre, descripcion || null, lugar || null, fechaInicio || null, fechaFin || null]
  );
  return { success: true, data: { id: r.rows[0].id } };
}

async function editarEvento(pool, body) {
  const { eventoId, nombre, descripcion, lugar, fechaInicio, fechaFin, estado } = body;
  await pool.query(
    `UPDATE sport_control.eventos SET nombre = $1, descripcion = $2, lugar = $3, fecha_inicio = $4, fecha_fin = $5, estado = $6 WHERE id = $7`,
    [nombre, descripcion || null, lugar || null, fechaInicio || null, fechaFin || null, estado, eventoId]
  );
  return { success: true };
}

async function listarEventos(pool) {
  const r = await pool.query(
    `SELECT e.id, e.nombre, e.lugar, e.fecha_inicio, e.fecha_fin, e.estado,
       (SELECT COUNT(*) FROM sport_control.evento_fechas ef WHERE ef.evento_id = e.id) AS "totalFechas",
       COALESCE((SELECT SUM(monto_proyectado) FROM sport_control.evento_presupuesto WHERE evento_id = e.id), 0) AS "totalProyectado",
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m JOIN sport_control.tipos_movimiento_evento t ON t.id = m.tipo_movimiento_id WHERE m.evento_id = e.id AND t.tipo = 'ingreso'), 0) AS "totalIngresos",
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m JOIN sport_control.tipos_movimiento_evento t ON t.id = m.tipo_movimiento_id WHERE m.evento_id = e.id AND t.tipo = 'gasto'), 0) AS "totalGastos"
     FROM sport_control.eventos e ORDER BY e.fecha_inicio DESC NULLS LAST, e.creado_en DESC`
  );
  return { success: true, data: r.rows };
}

// ---------- Fechas/sedes dentro de un evento ----------

async function crearEventoFecha(pool, body) {
  const { eventoId, fecha, lugar, descripcion } = body;
  if (!eventoId || !fecha) return { success: false, error: 'Falta el evento o la fecha.' };
  const r = await pool.query(
    `INSERT INTO sport_control.evento_fechas (evento_id, fecha, lugar, descripcion, creado_en) VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
    [eventoId, fecha, lugar || null, descripcion || null]
  );
  return { success: true, data: { id: r.rows[0].id } };
}

async function editarEventoFecha(pool, body) {
  const { eventoFechaId, fecha, lugar, descripcion } = body;
  await pool.query(
    `UPDATE sport_control.evento_fechas SET fecha = $1, lugar = $2, descripcion = $3 WHERE id = $4`,
    [fecha, lugar || null, descripcion || null, eventoFechaId]
  );
  return { success: true };
}

async function eliminarEventoFecha(pool, body) {
  const { eventoFechaId } = body;
  await pool.query(`UPDATE sport_control.evento_presupuesto SET evento_fecha_id = NULL WHERE evento_fecha_id = $1`, [eventoFechaId]);
  await pool.query(`UPDATE sport_control.evento_cuota_jugador SET evento_fecha_id = NULL WHERE evento_fecha_id = $1`, [eventoFechaId]);
  await pool.query(`UPDATE sport_control.evento_movimientos SET evento_fecha_id = NULL WHERE evento_fecha_id = $1`, [eventoFechaId]);
  await pool.query(`DELETE FROM sport_control.evento_fechas WHERE id = $1`, [eventoFechaId]);
  return { success: true };
}

// ---------- Detalle completo del evento (presupuesto + cuotas + movimientos, agrupables por fecha) ----------

async function verDetalleEvento(pool, body) {
  const { eventoId } = body;
  const evento = await pool.query(`SELECT id, nombre, descripcion, lugar, fecha_inicio, fecha_fin, estado FROM sport_control.eventos WHERE id = $1`, [eventoId]);

  const fechas = await pool.query(
    `SELECT id, fecha, lugar, descripcion FROM sport_control.evento_fechas WHERE evento_id = $1 ORDER BY fecha ASC`,
    [eventoId]
  );

  const presupuesto = await pool.query(
    `SELECT t.id AS "tipoMovimientoId", t.nombre, t.tipo, p.evento_fecha_id AS "eventoFechaId",
       COALESCE(p.monto_proyectado, 0) AS "montoProyectado",
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m WHERE m.evento_id = $1 AND m.tipo_movimiento_id = t.id AND m.evento_fecha_id IS NOT DISTINCT FROM p.evento_fecha_id), 0) AS "montoReal"
     FROM sport_control.evento_presupuesto p
     JOIN sport_control.tipos_movimiento_evento t ON t.id = p.tipo_movimiento_id
     WHERE p.evento_id = $1
     ORDER BY t.tipo, t.nombre`,
    [eventoId]
  );

  const cuotas = await pool.query(
    `SELECT ec.id, ec.jugador_id AS "jugadorId", j.nombres || ' ' || j.apellidos AS jugador, ec.monto_cuota AS "montoCuota", ec.evento_fecha_id AS "eventoFechaId", ec.numero_camiseta AS "numeroCamiseta",
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m WHERE m.evento_id = $1 AND m.jugador_id = ec.jugador_id AND m.evento_fecha_id IS NOT DISTINCT FROM ec.evento_fecha_id), 0) AS "montoPagado"
     FROM sport_control.evento_cuota_jugador ec
     JOIN sport_control.jugadores j ON j.id = ec.jugador_id
     WHERE ec.evento_id = $1 ORDER BY j.nombres`,
    [eventoId]
  );

  const movimientos = await pool.query(
    `SELECT m.id, m.monto, m.fecha, m.descripcion, m.evento_fecha_id AS "eventoFechaId", m.tipo_movimiento_id AS "tipoMovimientoId", m.jugador_id AS "jugadorId",
       t.nombre AS "tipoMovimiento", t.tipo,
       j.nombres || ' ' || j.apellidos AS jugador, m.comprobante_base64 IS NOT NULL AS "tieneComprobante"
     FROM sport_control.evento_movimientos m
     JOIN sport_control.tipos_movimiento_evento t ON t.id = m.tipo_movimiento_id
     LEFT JOIN sport_control.jugadores j ON j.id = m.jugador_id
     WHERE m.evento_id = $1 ORDER BY m.fecha DESC, m.id DESC`,
    [eventoId]
  );

  return { success: true, data: { evento: evento.rows[0], fechas: fechas.rows, presupuesto: presupuesto.rows, cuotas: cuotas.rows, movimientos: movimientos.rows } };
}

// ---------- Presupuesto, cuotas y movimientos (todos aceptan eventoFechaId opcional) ----------

async function guardarPresupuestoItem(pool, body) {
  const { eventoId, eventoFechaId, tipoMovimientoId, montoProyectado } = body;
  const fechaId = eventoFechaId || null;
  const existente = await pool.query(
    `SELECT id FROM sport_control.evento_presupuesto WHERE evento_id = $1 AND tipo_movimiento_id = $2 AND evento_fecha_id IS NOT DISTINCT FROM $3`,
    [eventoId, tipoMovimientoId, fechaId]
  );
  if (existente.rows[0]) {
    await pool.query(`UPDATE sport_control.evento_presupuesto SET monto_proyectado = $1 WHERE id = $2`, [montoProyectado, existente.rows[0].id]);
  } else {
    await pool.query(
      `INSERT INTO sport_control.evento_presupuesto (evento_id, evento_fecha_id, tipo_movimiento_id, monto_proyectado) VALUES ($1, $2, $3, $4)`,
      [eventoId, fechaId, tipoMovimientoId, montoProyectado]
    );
  }
  return { success: true };
}

async function eliminarPresupuestoItem(pool, body) {
  await pool.query(`DELETE FROM sport_control.evento_presupuesto WHERE id = $1`, [body.presupuestoId]);
  return { success: true };
}

async function asignarCuotaJugador(pool, body) {
  const { eventoId, eventoFechaId, jugadorId, montoCuota, numeroCamiseta } = body;
  const fechaId = eventoFechaId || null;
  const existente = await pool.query(
    `SELECT id FROM sport_control.evento_cuota_jugador WHERE evento_id = $1 AND jugador_id = $2 AND evento_fecha_id IS NOT DISTINCT FROM $3`,
    [eventoId, jugadorId, fechaId]
  );
  if (existente.rows[0]) {
    await pool.query(`UPDATE sport_control.evento_cuota_jugador SET monto_cuota = $1, numero_camiseta = $2 WHERE id = $3`, [montoCuota, numeroCamiseta || null, existente.rows[0].id]);
  } else {
    await pool.query(
      `INSERT INTO sport_control.evento_cuota_jugador (evento_id, evento_fecha_id, jugador_id, monto_cuota, numero_camiseta) VALUES ($1, $2, $3, $4, $5)`,
      [eventoId, fechaId, jugadorId, montoCuota, numeroCamiseta || null]
    );
  }
  return { success: true };
}

async function aplicarCuotaATodos(pool, body) {
  const { eventoId, eventoFechaId, montoCuota } = body;
  const fechaId = eventoFechaId || null;
  const jugadores = await pool.query(`SELECT id FROM sport_control.jugadores WHERE estado = 'activo'`);
  for (const j of jugadores.rows) {
    const existente = await pool.query(
      `SELECT id FROM sport_control.evento_cuota_jugador WHERE evento_id = $1 AND jugador_id = $2 AND evento_fecha_id IS NOT DISTINCT FROM $3`,
      [eventoId, j.id, fechaId]
    );
    if (existente.rows[0]) {
      await pool.query(`UPDATE sport_control.evento_cuota_jugador SET monto_cuota = $1 WHERE id = $2`, [montoCuota, existente.rows[0].id]);
    } else {
      await pool.query(
        `INSERT INTO sport_control.evento_cuota_jugador (evento_id, evento_fecha_id, jugador_id, monto_cuota) VALUES ($1, $2, $3, $4)`,
        [eventoId, fechaId, j.id, montoCuota]
      );
    }
  }
  return { success: true, data: { jugadores: jugadores.rows.length } };
}

async function quitarCuotaJugador(pool, body) {
  await pool.query(`DELETE FROM sport_control.evento_cuota_jugador WHERE id = $1`, [body.cuotaId]);
  return { success: true };
}

async function enviarPushMovimientoRepresentante(pool, jugadorId, monto, tipoDireccion, tipoNombre, eventoNombre) {
  try {
    const cfg = await pool.query(`SELECT onesignal_app_id, sitio_url_representante FROM sport_control.configuracion_club WHERE id = 1`);
    const c = cfg.rows[0];
    if (!c || !c.onesignal_app_id) return;

    const representantes = await pool.query(
      `SELECT representante_id FROM sport_control.jugador_representante WHERE jugador_id = $1`,
      [jugadorId]
    );
    if (representantes.rows.length === 0) return;

    // Mensaje corto pero completo: monto, si fue pago o cargo, y el
    // evento -- pensado para caber comodo en una notificacion sin
    // truncarse en la mayoria de telefonos.
    const esPago = tipoDireccion === 'ingreso';
    const titulo = esPago ? '💰 Pago registrado' : '📤 Cargo registrado';
    const montoFmt = Number(monto).toFixed(2);
    const cuerpo = `${esPago ? 'Se registró un pago de' : 'Se registró un cargo de'} $${montoFmt} (${tipoNombre}) en ${eventoNombre}.`;

    await enviarPushPorRepresentantes(c, representantes.rows.map(r => r.representante_id), titulo, cuerpo);
  } catch (e) {
    console.error('Push de movimiento de evento falló (no bloquea el registro):', e);
  }
}

// Movimiento GENERAL del evento (sin jugador puntual): les llega a
// TODOS los representantes de los jugadores que son parte del evento
// -- "parte del evento" se define como tener una fila en
// evento_cuota_jugador, sin importar si el monto de esa cuota es 0.
async function enviarPushMovimientoGeneralRepresentantes(pool, eventoId, monto, tipoDireccion, tipoNombre, eventoNombre) {
  try {
    const cfg = await pool.query(`SELECT onesignal_app_id, sitio_url_representante FROM sport_control.configuracion_club WHERE id = 1`);
    const c = cfg.rows[0];
    if (!c || !c.onesignal_app_id) return;

    const representantes = await pool.query(
      `SELECT DISTINCT jr.representante_id
       FROM sport_control.evento_cuota_jugador ecj
       JOIN sport_control.jugador_representante jr ON jr.jugador_id = ecj.jugador_id
       WHERE ecj.evento_id = $1`,
      [eventoId]
    );
    if (representantes.rows.length === 0) return;

    const esPago = tipoDireccion === 'ingreso';
    const titulo = esPago ? '💰 Nuevo ingreso al evento' : '📤 Nuevo gasto del evento';
    const montoFmt = Number(monto).toFixed(2);
    const cuerpo = `${eventoNombre}: ${tipoNombre} — $${montoFmt}`;

    await enviarPushPorRepresentantes(c, representantes.rows.map(r => r.representante_id), titulo, cuerpo);
  } catch (e) {
    console.error('Push general de movimiento de evento falló (no bloquea el registro):', e);
  }
}

async function enviarPushPorRepresentantes(config, representanteIds, titulo, cuerpo) {
  const filters = [];
  representanteIds.forEach((id, i) => {
    if (i > 0) filters.push({ operator: 'OR' });
    filters.push({ field: 'tag', key: 'representante_id', relation: '=', value: String(id) });
  });
  await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: config.onesignal_app_id,
      filters,
      target_channel: 'push',
      headings: { en: titulo },
      contents: { en: cuerpo },
      url: config.sitio_url_representante || '',
    }),
  });
}

async function registrarMovimientoEvento(pool, body) {
  const { eventoId, eventoFechaId, tipoMovimientoId, jugadorId, monto, fecha, descripcion, comprobanteBase64 } = body;
  if (!eventoId || !tipoMovimientoId || !monto) return { success: false, error: 'Faltan datos del movimiento.' };
  const r = await pool.query(
    `INSERT INTO sport_control.evento_movimientos (evento_id, evento_fecha_id, tipo_movimiento_id, jugador_id, monto, fecha, descripcion, comprobante_base64, creado_en)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, NOW()) RETURNING id`,
    [eventoId, eventoFechaId || null, tipoMovimientoId, jugadorId || null, monto, fecha || null, descripcion || null, comprobanteBase64 || null]
  );

  const info = await pool.query(
    `SELECT e.nombre AS "eventoNombre", t.nombre AS "tipoNombre", t.tipo AS "tipoDireccion"
     FROM sport_control.eventos e, sport_control.tipos_movimiento_evento t
     WHERE e.id = $1 AND t.id = $2`,
    [eventoId, tipoMovimientoId]
  );
  if (info.rows[0]) {
    const { eventoNombre, tipoNombre, tipoDireccion } = info.rows[0];
    if (jugadorId) {
      await enviarPushMovimientoRepresentante(pool, jugadorId, monto, tipoDireccion, tipoNombre, eventoNombre);
    } else {
      await enviarPushMovimientoGeneralRepresentantes(pool, eventoId, monto, tipoDireccion, tipoNombre, eventoNombre);
    }
  }

  return { success: true, data: { id: r.rows[0].id } };
}

async function eliminarMovimientoEvento(pool, body) {
  await pool.query(`DELETE FROM sport_control.evento_movimientos WHERE id = $1`, [body.movimientoId]);
  return { success: true };
}

async function editarMovimientoEvento(pool, body) {
  const { movimientoId, eventoFechaId, tipoMovimientoId, jugadorId, monto, fecha, descripcion, comprobanteBase64 } = body;
  if (comprobanteBase64) {
    await pool.query(
      `UPDATE sport_control.evento_movimientos
       SET evento_fecha_id = $1, tipo_movimiento_id = $2, jugador_id = $3, monto = $4, fecha = $5, descripcion = $6, comprobante_base64 = $7
       WHERE id = $8`,
      [eventoFechaId || null, tipoMovimientoId, jugadorId || null, monto, fecha, descripcion || null, comprobanteBase64, movimientoId]
    );
  } else {
    await pool.query(
      `UPDATE sport_control.evento_movimientos
       SET evento_fecha_id = $1, tipo_movimiento_id = $2, jugador_id = $3, monto = $4, fecha = $5, descripcion = $6
       WHERE id = $7`,
      [eventoFechaId || null, tipoMovimientoId, jugadorId || null, monto, fecha, descripcion || null, movimientoId]
    );
  }
  return { success: true };
}

async function verComprobanteMovimiento(pool, body) {
  const r = await pool.query(`SELECT comprobante_base64 FROM sport_control.evento_movimientos WHERE id = $1`, [body.movimientoId]);
  return { success: true, data: { comprobante_base64: r.rows[0] ? r.rows[0].comprobante_base64 : null } };
}

async function listarInformeConsolidadoEventos(pool) {
  const r = await pool.query(
    `SELECT e.id, e.nombre, e.estado, e.fecha_inicio,
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m JOIN sport_control.tipos_movimiento_evento t ON t.id = m.tipo_movimiento_id WHERE m.evento_id = e.id AND t.tipo = 'ingreso'), 0) AS "totalIngresos",
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m JOIN sport_control.tipos_movimiento_evento t ON t.id = m.tipo_movimiento_id WHERE m.evento_id = e.id AND t.tipo = 'gasto'), 0) AS "totalGastos",
       COALESCE((SELECT SUM(ec.monto_cuota) FROM sport_control.evento_cuota_jugador ec WHERE ec.evento_id = e.id), 0) AS "totalCuotasEsperadas"
     FROM sport_control.eventos e ORDER BY e.fecha_inicio DESC NULLS LAST`
  );
  return { success: true, data: r.rows };
}

// ---------- Catalogo de tipos de movimiento (campo extra 'tipo', CRUD propio) ----------

async function listarTiposMovimientoEvento(pool) {
  const r = await pool.query(`SELECT id, nombre, tipo, activo FROM sport_control.tipos_movimiento_evento ORDER BY tipo, nombre`);
  return { success: true, data: r.rows };
}

async function crearTipoMovimientoEvento(pool, body) {
  const { nombre, tipo } = body;
  if (!nombre || !['ingreso', 'gasto'].includes(tipo)) return { success: false, error: 'Falta el nombre o el tipo (ingreso/gasto).' };
  const r = await pool.query(`INSERT INTO sport_control.tipos_movimiento_evento (nombre, tipo) VALUES ($1, $2) RETURNING id`, [nombre, tipo]);
  return { success: true, data: { id: r.rows[0].id } };
}

async function toggleTipoMovimientoEvento(pool, body) {
  await pool.query(`UPDATE sport_control.tipos_movimiento_evento SET activo = $1 WHERE id = $2`, [!!body.activo, body.id]);
  return { success: true };
}

async function listarEventosSelector(pool) {
  const r = await pool.query(`SELECT id, nombre FROM sport_control.eventos WHERE estado != 'cancelado' ORDER BY creado_en DESC`);
  return { success: true, data: r.rows };
}

async function listarFechasEventoSelector(pool, body) {
  const r = await pool.query(
    `SELECT id, fecha, lugar, descripcion FROM sport_control.evento_fechas WHERE evento_id = $1 ORDER BY fecha ASC`,
    [body.eventoId]
  );
  return { success: true, data: r.rows };
}

module.exports = {
  crearEvento, editarEvento, listarEventos,
  crearEventoFecha, editarEventoFecha, eliminarEventoFecha,
  verDetalleEvento, guardarPresupuestoItem, eliminarPresupuestoItem,
  asignarCuotaJugador, aplicarCuotaATodos, quitarCuotaJugador,
  registrarMovimientoEvento, editarMovimientoEvento, eliminarMovimientoEvento, verComprobanteMovimiento,
  listarInformeConsolidadoEventos, listarTiposMovimientoEvento, crearTipoMovimientoEvento, toggleTipoMovimientoEvento,
  listarEventosSelector, listarFechasEventoSelector,
};
