// api/_admin_finanzas_club.js
// Modulo financiero del club (matriculas, mensualidad, servicios,
// auspicios, etc.) -- separado de Eventos, que sigue siendo su propio
// mundo. Un rubro nuevo es una fila en rubros_club, nunca codigo nuevo.

async function listarRubros(pool) {
  const r = await pool.query(
    `SELECT id, nombre, tipo, aplica_a AS "aplicaA", recurrencia, monto_sugerido AS "montoSugerido", activo, orden
     FROM sport_control.rubros_club ORDER BY orden, nombre`
  );
  return { success: true, data: r.rows };
}

async function crearRubro(pool, body) {
  const nombre = (body.nombre || '').trim();
  const { tipo, aplicaA, recurrencia, montoSugerido } = body;
  if (!nombre) return { success: false, error: 'El nombre no puede estar vacío.' };
  if (!['ingreso', 'egreso'].includes(tipo)) return { success: false, error: 'Tipo inválido.' };
  if (!['jugador', 'club'].includes(aplicaA)) return { success: false, error: 'Ámbito inválido.' };
  if (!['unico', 'mensual', 'anual'].includes(recurrencia)) return { success: false, error: 'Recurrencia inválida.' };
  const r = await pool.query(
    `INSERT INTO sport_control.rubros_club (nombre, tipo, aplica_a, recurrencia, monto_sugerido, orden)
     VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(orden),0)+10 FROM sport_control.rubros_club))
     RETURNING id`,
    [nombre, tipo, aplicaA, recurrencia, montoSugerido || null]
  );
  return { success: true, data: { id: r.rows[0].id } };
}

async function editarRubro(pool, body) {
  const { rubroId, nombre, tipo, aplicaA, recurrencia, montoSugerido } = body;
  await pool.query(
    `UPDATE sport_control.rubros_club SET nombre = $1, tipo = $2, aplica_a = $3, recurrencia = $4, monto_sugerido = $5 WHERE id = $6`,
    [nombre, tipo, aplicaA, recurrencia, montoSugerido || null, rubroId]
  );
  return { success: true };
}

async function toggleRubro(pool, body) {
  await pool.query(`UPDATE sport_control.rubros_club SET activo = $1 WHERE id = $2`, [!!body.activo, body.rubroId]);
  return { success: true };
}

/* ---------- Movimientos ---------- */
async function listarMovimientosClub(pool, body) {
  const { rubroId, jugadorId, desde, hasta } = body || {};
  const condiciones = [];
  const vals = [];
  let i = 1;
  if (rubroId) { condiciones.push(`m.rubro_id = $${i++}`); vals.push(rubroId); }
  if (jugadorId) { condiciones.push(`m.jugador_id = $${i++}`); vals.push(jugadorId); }
  if (desde) { condiciones.push(`m.fecha >= $${i++}`); vals.push(desde); }
  if (hasta) { condiciones.push(`m.fecha <= $${i++}`); vals.push(hasta); }
  const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';

  const r = await pool.query(
    `SELECT m.id, m.monto, m.fecha, m.periodo, m.descripcion, m.rubro_id AS "rubroId",
       rc.nombre AS rubro, rc.tipo, m.jugador_id AS "jugadorId",
       (j.nombres || ' ' || j.apellidos) AS jugador
     FROM sport_control.movimientos_club m
     JOIN sport_control.rubros_club rc ON rc.id = m.rubro_id
     LEFT JOIN sport_control.jugadores j ON j.id = m.jugador_id
     ${where}
     ORDER BY m.fecha DESC, m.id DESC LIMIT 200`,
    vals
  );
  const totales = await pool.query(
    `SELECT rc.tipo, COALESCE(SUM(m.monto),0) AS total
     FROM sport_control.movimientos_club m JOIN sport_control.rubros_club rc ON rc.id = m.rubro_id
     ${where} GROUP BY rc.tipo`,
    vals
  );
  const totalIngresos = Number((totales.rows.find(t=>t.tipo==='ingreso')||{}).total || 0);
  const totalEgresos = Number((totales.rows.find(t=>t.tipo==='egreso')||{}).total || 0);
  return { success: true, data: { movimientos: r.rows, totalIngresos, totalEgresos } };
}

async function registrarMovimientoClub(pool, body) {
  const { rubroId, jugadorId, monto, fecha, periodo, descripcion, comprobanteBase64 } = body;
  if (!rubroId || !monto) return { success: false, error: 'Faltan datos del movimiento.' };
  const r = await pool.query(
    `INSERT INTO sport_control.movimientos_club (rubro_id, jugador_id, monto, fecha, periodo, descripcion, comprobante_base64)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7) RETURNING id`,
    [rubroId, jugadorId || null, monto, fecha || null, periodo || null, descripcion || null, comprobanteBase64 || null]
  );
  return { success: true, data: { id: r.rows[0].id } };
}

async function eliminarMovimientoClub(pool, body) {
  await pool.query(`DELETE FROM sport_control.movimientos_club WHERE id = $1`, [body.movimientoId]);
  return { success: true };
}

/* ---------- Mensualidad dinamica: meses pendientes + pagos parciales ---------- */

// Genera la lista de meses ('YYYY-MM') desde el inicio hasta el mes
// actual, ambos inclusive.
function generarMesesDesde(fechaInicio) {
  const meses = [];
  const inicio = new Date(fechaInicio);
  const hoy = new Date();
  let y = inicio.getUTCFullYear(), m = inicio.getUTCMonth();
  const yFin = hoy.getUTCFullYear(), mFin = hoy.getUTCMonth();
  while (y < yFin || (y === yFin && m <= mFin)) {
    meses.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return meses;
}

// Reparte lo pagado, mes por mes, del mas antiguo hacia el mas nuevo
// -- asi un pago parcial cubre primero la deuda mas vieja, sin que
// quien registra el pago tenga que decir a que mes corresponde.
async function calcularMensualidadJugador(pool, jugadorId) {
  const cfg = await pool.query(
    `SELECT j.fecha_inicio_mensualidad_propia AS propia, c.fecha_inicio_mensualidades AS club
     FROM sport_control.jugadores j, sport_control.configuracion_club c
     WHERE j.id = $1 AND c.id = 1`,
    [jugadorId]
  );
  const fechaInicio = cfg.rows[0] && (cfg.rows[0].propia || cfg.rows[0].club);
  if (!fechaInicio) return { meses: [], montoMensualidad: 0, totalPagado: 0, totalAdeudado: 0, mesesAtraso: 0 };

  // El monto de la mensualidad se lee de catalogo_cobros -- el MISMO
  // lugar que ya se edita desde Admin > Parametros > Generales >
  // "Cuota mensual". No se duplica en rubros_club para evitar que
  // existan 2 valores distintos guardados en 2 lugares.
  const cobro = await pool.query(`SELECT id, valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1`);
  const catalogoCobroId = cobro.rows[0] && cobro.rows[0].id;
  const montoMensualidadActual = Number((cobro.rows[0] && cobro.rows[0].valor) || 0);

  const mesesLista = generarMesesDesde(fechaInicio);

  // Historial de vigencias: cada cambio de precio queda guardado con
  // la fecha desde la que rige, para que un mes de 2026 siga usando
  // el precio de 2026 aunque hoy ya rija un precio distinto.
  const historial = catalogoCobroId
    ? (await pool.query(
        `SELECT valor, vigente_desde AS "vigenteDesde" FROM sport_control.catalogo_cobros_historial
         WHERE catalogo_cobro_id = $1 ORDER BY vigente_desde ASC`,
        [catalogoCobroId]
      )).rows
    : [];

  // Para un mes dado, el valor vigente es el de la ultima vigencia
  // cuya fecha ya haya llegado para ese mes (la mas reciente que no
  // sea posterior al primer dia de ese mes).
  function valorVigenteParaMes(periodo) {
    const primerDiaMes = new Date(periodo + '-01T00:00:00Z');
    let valor = null;
    for (const v of historial) {
      if (new Date(v.vigenteDesde) <= primerDiaMes) valor = Number(v.valor);
      else break;
    }
    return valor;
  }

  const sinHistorial = historial.length === 0;
  if (sinHistorial && montoMensualidadActual <= 0) {
    const pagos = await pool.query(
      `SELECT COALESCE(SUM(m.monto), 0) AS total FROM sport_control.movimientos_club m
       JOIN sport_control.rubros_club rc ON rc.id = m.rubro_id
       WHERE rc.nombre = 'Mensualidad' AND m.jugador_id = $1`,
      [jugadorId]
    );
    return {
      meses: mesesLista.map(periodo => ({ periodo, monto: 0, montoPagado: 0, estado: 'pendiente' })),
      montoMensualidad: 0,
      totalPagado: Number(pagos.rows[0].total),
      totalAdeudado: 0,
      mesesAtraso: mesesLista.length,
      sinMontoConfigurado: true,
    };
  }

  const pagos = await pool.query(
    `SELECT COALESCE(SUM(m.monto), 0) AS total FROM sport_control.movimientos_club m
     JOIN sport_control.rubros_club rc ON rc.id = m.rubro_id
     WHERE rc.nombre = 'Mensualidad' AND m.jugador_id = $1`,
    [jugadorId]
  );
  let saldoDisponible = Number(pagos.rows[0].total);
  const totalPagado = saldoDisponible;

  // Si un mes no tiene ninguna vigencia que ya haya empezado (por
  // ejemplo, la primera vigencia es posterior a ese mes), se usa el
  // valor actual como respaldo -- mejor eso que dejarlo en $0.
  const meses = mesesLista.map(periodo => {
    const montoDelMes = sinHistorial ? montoMensualidadActual : (valorVigenteParaMes(periodo) ?? montoMensualidadActual);
    let estado, montoPagadoMes;
    if (saldoDisponible >= montoDelMes) {
      estado = 'pagado'; montoPagadoMes = montoDelMes; saldoDisponible -= montoDelMes;
    } else if (saldoDisponible > 0) {
      estado = 'parcial'; montoPagadoMes = saldoDisponible; saldoDisponible = 0;
    } else {
      estado = 'pendiente'; montoPagadoMes = 0;
    }
    return { periodo, monto: montoDelMes, montoPagado: montoPagadoMes, estado };
  });

  const mesesAtraso = meses.filter(m => m.estado !== 'pagado').length;
  const totalAdeudado = meses.reduce((acc, m) => acc + (m.monto - m.montoPagado), 0);

  return { meses, montoMensualidad: montoMensualidadActual, totalPagado, totalAdeudado, mesesAtraso };
}

async function verMensualidadJugadorAdmin(pool, body) {
  const data = await calcularMensualidadJugador(pool, body.jugadorId);
  return { success: true, data };
}

async function dashboardMorososMensualidad(pool) {
  const jugadores = await pool.query(`SELECT id, nombres, apellidos, telefono FROM sport_control.jugadores WHERE estado = 'activo'`);
  const resultados = [];
  for (const j of jugadores.rows) {
    const calc = await calcularMensualidadJugador(pool, j.id);
    if (calc.mesesAtraso > 0) {
      resultados.push({ jugadorId: j.id, nombres: j.nombres, apellidos: j.apellidos, telefono: j.telefono, mesesAtraso: calc.mesesAtraso, totalAdeudado: calc.totalAdeudado });
    }
  }
  resultados.sort((a, b) => b.mesesAtraso - a.mesesAtraso);

  const grupos = { '1_mes': [], '2_meses': [], '3_mas': [] };
  resultados.forEach(r => {
    if (r.mesesAtraso === 1) grupos['1_mes'].push(r);
    else if (r.mesesAtraso === 2) grupos['2_meses'].push(r);
    else grupos['3_mas'].push(r);
  });

  const totalAdeudadoClub = resultados.reduce((acc, r) => acc + r.totalAdeudado, 0);
  return { success: true, data: { grupos, totalMorosos: resultados.length, totalAdeudadoClub } };
}

module.exports = {
  listarRubros, crearRubro, editarRubro, toggleRubro,
  listarMovimientosClub, registrarMovimientoClub, eliminarMovimientoClub,
  verMensualidadJugadorAdmin, dashboardMorososMensualidad, calcularMensualidadJugador,
};
