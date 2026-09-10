// api/_admin_jugadores.js

async function listarJugadores(pool, body) {
  const busqueda = body.busqueda || '';
  const r = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object(
       'id', j.id, 'nombres', j.nombres, 'apellidos', j.apellidos, 'telefono', j.telefono, 'cedula', j.cedula, 'correo', j.correo,
       'estado', j.estado, 'es_admin', j.es_admin, 'es_controlador', j.es_controlador, 'autorizado_excepcion_pago', j.autorizado_excepcion_pago,
       'tieneDeuda', ((NOT j.autorizado_excepcion_pago AND sport_control.meses_atraso(j.id) > 0)
         OR EXISTS(SELECT 1 FROM sport_control.multas m JOIN sport_control.partidos p2 ON p2.id = m.partido_id WHERE m.jugador_id = j.id AND m.estado IN ('pendiente_aprobacion', 'aprobada') AND COALESCE(m.pagada, false) = false AND p2.estado = 'finalizado' AND p2.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1))
         OR EXISTS(SELECT 1 FROM sport_control.invitados_asistencia ia JOIN sport_control.partidos p3 ON p3.id = ia.partido_id WHERE ia.jugador_anfitrion_id = j.id AND ia.estado = 'confirmado' AND COALESCE(ia.pagado, false) = false AND p3.estado = 'finalizado' AND p3.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)))
     ) ORDER BY j.nombres), '[]'::json) AS jugadores
     FROM sport_control.jugadores j
     WHERE ($1 = '' OR j.nombres ILIKE '%' || $1 || '%' OR j.apellidos ILIKE '%' || $1 || '%' OR j.telefono ILIKE '%' || $1 || '%')`,
    [busqueda]
  );
  return { success: true, data: r.rows[0].jugadores };
}

async function actualizarJugador(pool, body) {
  const sets = [];
  const vals = [];
  let i = 1;
  const campo = (col, val) => { sets.push(`${col} = $${i}`); vals.push(val); i++; };
  if (body.nombres !== undefined) campo('nombres', body.nombres);
  if (body.apellidos !== undefined) campo('apellidos', body.apellidos);
  if (body.cedula !== undefined) campo('cedula', body.cedula);
  if (body.correo !== undefined) campo('correo', body.correo);
  if (body.telefono !== undefined) campo('telefono', body.telefono);
  if (body.estado !== undefined) campo('estado', body.estado);
  if (body.es_admin !== undefined) campo('es_admin', !!body.es_admin);
  if (body.es_controlador !== undefined) campo('es_controlador', !!body.es_controlador);
  if (body.autorizado_excepcion_pago !== undefined) campo('autorizado_excepcion_pago', !!body.autorizado_excepcion_pago);

  if (sets.length === 0 || !body.id) return { success: false, error: 'Datos invalidos: falta id o ningun campo a actualizar.' };
  vals.push(body.id);
  const r = await pool.query(
    `UPDATE sport_control.jugadores SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, nombres, apellidos, telefono, cedula, correo, estado, es_admin, es_controlador, autorizado_excepcion_pago`,
    vals
  );
  return { success: true, data: r.rows[0] };
}

async function verDetalleJugador(pool, body) {
  const r = await pool.query(
    `SELECT j.id, j.nombres, j.apellidos, j.telefono, j.cedula, j.correo, j.estado, j.es_admin, j.es_controlador, j.autorizado_excepcion_pago, j.creado_en,
       sport_control.meses_atraso(j.id) AS meses_atraso,
       sport_control.meses_atraso(j.id) * COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0) AS deuda_estimada,
       (SELECT COALESCE(SUM(pg.monto), 0) FROM sport_control.pagos pg WHERE pg.jugador_id = j.id AND pg.estado = 'confirmado') AS total_pagado,
       (SELECT COALESCE(SUM(m.monto), 0) FROM sport_control.multas m JOIN sport_control.partidos p ON p.id = m.partido_id WHERE m.jugador_id = j.id AND m.estado = 'pendiente_aprobacion' AND COALESCE(m.pagada, false) = false AND p.estado = 'finalizado' AND p.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)) AS multas_pendientes,
       (SELECT COALESCE(SUM(m.monto), 0) FROM sport_control.multas m WHERE m.jugador_id = j.id AND m.estado = 'aprobada') AS multas_aprobadas,
       (SELECT COUNT(*) FROM sport_control.confirmaciones_partido cp WHERE cp.jugador_id = j.id AND cp.estado = 'confirmado') AS partidos_confirmados,
       (SELECT COUNT(*) FROM sport_control.codigos_asistencia ca WHERE ca.jugador_id = j.id AND ca.invitado_asistencia_id IS NULL AND ca.usado = true) AS partidos_asistidos,
       (SELECT json_build_object('fecha', pg3.creado_en, 'tipo', tc.tipo, 'monto', pg3.monto, 'metodo', pg3.metodo_pago) FROM sport_control.pagos pg3 JOIN sport_control.catalogo_cobros tc ON tc.id = pg3.tipo_cobro_id WHERE pg3.jugador_id = j.id AND pg3.estado = 'confirmado' ORDER BY pg3.creado_en DESC LIMIT 1) AS ultimo_pago
     FROM sport_control.jugadores j WHERE j.id = $1`,
    [body.jugadorId]
  );
  return { success: true, data: r.rows[0] };
}

async function verPendientesJugador(pool, body) {
  const r = await pool.query(
    `WITH multas_pend AS (
       SELECT m.id, m.partido_id, t.nombre AS motivo, m.monto, 'multa' AS tipo
       FROM sport_control.multas m JOIN sport_control.tipos_multa t ON t.id = m.tipo_multa_id JOIN sport_control.partidos p ON p.id = m.partido_id
       WHERE m.jugador_id = $1 AND m.estado IN ('pendiente_aprobacion', 'aprobada') AND COALESCE(m.pagada, false) = false AND p.estado = 'finalizado' AND p.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)
     ), invitados_pend AS (
       SELECT ia.id, ia.partido_id, ia.nombre AS motivo, COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'invitado' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0) AS monto, 'invitado' AS tipo
       FROM sport_control.invitados_asistencia ia JOIN sport_control.partidos p2 ON p2.id = ia.partido_id
       WHERE ia.jugador_anfitrion_id = $1 AND ia.estado = 'confirmado' AND COALESCE(ia.pagado, false) = false AND p2.estado = 'finalizado' AND p2.fecha >= (SELECT fecha_inicio_recaudacion FROM sport_control.configuracion_club WHERE id = 1)
     ), todos AS (SELECT * FROM multas_pend UNION ALL SELECT * FROM invitados_pend)
     SELECT COALESCE(json_agg(json_build_object('partidoId', p.id, 'alias', p.alias, 'fecha', p.fecha, 'items', (SELECT json_agg(json_build_object('tipo', t.tipo, 'id', t.id, 'motivo', t.motivo, 'monto', t.monto)) FROM todos t WHERE t.partido_id = p.id)) ORDER BY p.fecha DESC), '[]'::json) AS partidos
     FROM sport_control.partidos p WHERE p.id IN (SELECT DISTINCT partido_id FROM todos)`,
    [body.jugadorId]
  );
  return { success: true, data: r.rows[0].partidos };
}

async function verPagosJugador(pool, body) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(t.*), '[]'::json) AS pagos FROM (
       SELECT * FROM (
         SELECT pg.creado_en AS fecha, pg.monto,
           CASE WHEN cc.tipo = 'mensualidad' THEN 'Mensualidad'
                WHEN cc.tipo = 'invitado' THEN 'Invitado' || (CASE WHEN pg.cantidad_invitados > 1 THEN ' (x' || pg.cantidad_invitados || ')' ELSE '' END)
                WHEN pg.partido_id IS NOT NULL THEN 'Partido especial' || (CASE WHEN p.alias IS NOT NULL THEN ': ' || p.alias ELSE '' END)
                ELSE 'Pago' END AS motivo
         FROM sport_control.pagos pg LEFT JOIN sport_control.catalogo_cobros cc ON cc.id = pg.tipo_cobro_id LEFT JOIN sport_control.partidos p ON p.id = pg.partido_id
         WHERE pg.jugador_id = $1 AND pg.estado = 'confirmado'
         UNION ALL
         SELECT COALESCE(m.pagada_en, m.aprobada_en) AS fecha, m.monto, 'Multa: ' || tm.nombre AS motivo
         FROM sport_control.multas m JOIN sport_control.tipos_multa tm ON tm.id = m.tipo_multa_id WHERE m.jugador_id = $1 AND m.pagada = true
       ) sub ORDER BY fecha DESC LIMIT 10
     ) t`,
    [body.jugadorId]
  );
  return { success: true, data: r.rows[0].pagos };
}

async function crearJugadorManual(pool, body) {
  const dup = await pool.query(
    `SELECT (SELECT COUNT(*) FROM sport_control.jugadores WHERE telefono = $1) AS existe_telefono,
            (SELECT COUNT(*) FROM sport_control.jugadores WHERE cedula = $2 AND cedula IS NOT NULL AND cedula != '') AS existe_cedula`,
    [body.telefono, body.cedula]
  );
  const existeTelefono = Number(dup.rows[0].existe_telefono) > 0;
  const existeCedula = Number(dup.rows[0].existe_cedula) > 0;
  if (existeTelefono || existeCedula) {
    let error = 'Ya existe un jugador registrado con esos datos.';
    if (existeTelefono && existeCedula) error = 'Ya existe un jugador con ese teléfono y con esa cédula.';
    else if (existeTelefono) error = 'Ya existe un jugador con ese número de teléfono.';
    else if (existeCedula) error = 'Ya existe un jugador con esa cédula.';
    return { success: false, error };
  }
  const ins = await pool.query(
    `INSERT INTO sport_control.jugadores (nombres, apellidos, cedula, correo, telefono, estado, creado_en) VALUES ($1, $2, $3, $4, $5, 'activo', NOW()) RETURNING id`,
    [body.nombres, body.apellidos, body.cedula, body.correo, body.telefono]
  );
  return { success: true, data: { id: ins.rows[0].id } };
}

async function verConfirmadosPartido(pool, body) {
  const r = await pool.query(
    `WITH entradas AS (
       SELECT 'jugador' AS tipo, cp.jugador_id AS "jugadorId", j.nombres || ' ' || j.apellidos AS nombre, NULL::text AS anfitrion, cp.timestamp_confirmacion AS orden,
         CASE WHEN p.costo_inscripcion IS NOT NULL THEN EXISTS(SELECT 1 FROM sport_control.pagos pg WHERE pg.partido_id = p.id AND pg.jugador_id = cp.jugador_id AND pg.estado = 'confirmado')
              ELSE EXISTS(SELECT 1 FROM sport_control.pagos pg WHERE pg.jugador_id = cp.jugador_id AND pg.tipo_cobro_id IN (SELECT id FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad') AND pg.estado = 'confirmado' AND date_trunc('month', pg.creado_en) = date_trunc('month', CURRENT_DATE)) END AS pagado,
         sport_control.meses_atraso(j.id) AS "mesesAtraso"
       FROM sport_control.confirmaciones_partido cp JOIN sport_control.jugadores j ON j.id = cp.jugador_id JOIN sport_control.partidos p ON p.id = cp.partido_id
       WHERE cp.partido_id = $1 AND cp.estado = 'confirmado'
       UNION ALL
       SELECT 'invitado' AS tipo, NULL AS "jugadorId", ia.nombre, j2.nombres || ' ' || j2.apellidos AS anfitrion, ia.creado_en AS orden, NULL AS pagado, NULL AS "mesesAtraso"
       FROM sport_control.invitados_asistencia ia JOIN sport_control.jugadores j2 ON j2.id = ia.jugador_anfitrion_id
       WHERE ia.partido_id = $1 AND ia.estado = 'confirmado'
     )
     SELECT COALESCE(json_agg(json_build_object('tipo', tipo, 'jugadorId', "jugadorId", 'nombre', nombre, 'anfitrion', anfitrion, 'pagado', pagado, 'mesesAtraso', "mesesAtraso") ORDER BY orden), '[]'::json) AS lista FROM entradas`,
    [body.partidoId]
  );
  return { success: true, data: r.rows[0].lista };
}

async function verCheckinPartido(pool, body) {
  const r = await pool.query(
    `WITH entradas AS (
       SELECT 'jugador' AS tipo, cp.jugador_id AS id, j.nombres || ' ' || j.apellidos AS nombre, NULL::text AS anfitrion, cp.timestamp_confirmacion AS orden,
         COALESCE((SELECT ca.usado FROM sport_control.codigos_asistencia ca WHERE ca.jugador_id = cp.jugador_id AND ca.partido_id = cp.partido_id AND ca.invitado_asistencia_id IS NULL LIMIT 1), false) AS presente
       FROM sport_control.confirmaciones_partido cp JOIN sport_control.jugadores j ON j.id = cp.jugador_id
       WHERE cp.partido_id = $1 AND cp.estado = 'confirmado'
       UNION ALL
       SELECT 'invitado' AS tipo, ia.id AS id, ia.nombre, j2.nombres || ' ' || j2.apellidos AS anfitrion, ia.creado_en AS orden,
         COALESCE((SELECT ca2.usado FROM sport_control.codigos_asistencia ca2 WHERE ca2.invitado_asistencia_id = ia.id LIMIT 1), false) AS presente
       FROM sport_control.invitados_asistencia ia JOIN sport_control.jugadores j2 ON j2.id = ia.jugador_anfitrion_id
       WHERE ia.partido_id = $1 AND ia.estado = 'confirmado'
     )
     SELECT COALESCE(json_agg(json_build_object('tipo', tipo, 'id', id, 'nombre', nombre, 'anfitrion', anfitrion, 'presente', presente) ORDER BY orden), '[]'::json) AS lista FROM entradas`,
    [body.partidoId]
  );
  return { success: true, data: r.rows[0].lista };
}

async function verInvitadosPartido(pool, body) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('id', ia.id, 'anfitrion', j.nombres || ' ' || j.apellidos, 'nombre', ia.nombre, 'presente', COALESCE(ca.usado, false), 'pagado', ia.pagado) ORDER BY j.nombres, ia.id), '[]'::json) AS invitados
     FROM sport_control.invitados_asistencia ia JOIN sport_control.jugadores j ON j.id = ia.jugador_anfitrion_id LEFT JOIN sport_control.codigos_asistencia ca ON ca.invitado_asistencia_id = ia.id
     WHERE ia.partido_id = $1 AND ia.estado = 'confirmado'`,
    [body.partidoId]
  );
  return { success: true, data: r.rows[0].invitados };
}

module.exports = {
  listarJugadores, actualizarJugador, verDetalleJugador, verPendientesJugador, verPagosJugador, crearJugadorManual,
  verConfirmadosPartido, verCheckinPartido, verInvitadosPartido,
};
