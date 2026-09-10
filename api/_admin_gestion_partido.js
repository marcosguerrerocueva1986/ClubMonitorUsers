// api/_admin_gestion_partido.js

async function listarJugadoresDisponibles(pool, body) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('id', j.id, 'nombre', j.nombres || ' ' || j.apellidos) ORDER BY j.nombres), '[]'::json) AS jugadores
     FROM sport_control.jugadores j WHERE j.estado = 'activo' AND NOT EXISTS (SELECT 1 FROM sport_control.confirmaciones_partido cp WHERE cp.partido_id = $1 AND cp.jugador_id = j.id AND cp.estado = 'confirmado')`,
    [body.partidoId]
  );
  return { success: true, data: r.rows[0].jugadores };
}

async function agregarJugadorPartido(pool, body) {
  await pool.query(
    `INSERT INTO sport_control.confirmaciones_partido (partido_id, jugador_id, estado, timestamp_confirmacion, cantidad_invitados) VALUES ($1, $2, 'confirmado', NOW(), 0)
     ON CONFLICT (partido_id, jugador_id) DO UPDATE SET estado = 'confirmado', timestamp_confirmacion = NOW()`,
    [body.partidoId, body.jugadorId]
  );
  return { success: true, data: true };
}

async function listarConfirmadosRemovibles(pool, body) {
  const r = await pool.query(
    `WITH entradas AS (
       SELECT 'jugador' AS tipo, cp.jugador_id AS id, j.nombres || ' ' || j.apellidos AS nombre, NULL::text AS anfitrion, cp.timestamp_confirmacion AS orden
       FROM sport_control.confirmaciones_partido cp JOIN sport_control.jugadores j ON j.id = cp.jugador_id WHERE cp.partido_id = $1 AND cp.estado = 'confirmado'
       UNION ALL
       SELECT 'invitado' AS tipo, ia.id AS id, ia.nombre, j2.nombres || ' ' || j2.apellidos AS anfitrion, ia.creado_en AS orden
       FROM sport_control.invitados_asistencia ia JOIN sport_control.jugadores j2 ON j2.id = ia.jugador_anfitrion_id WHERE ia.partido_id = $1 AND ia.estado = 'confirmado'
     )
     SELECT COALESCE(json_agg(json_build_object('tipo', tipo, 'id', id, 'nombre', nombre, 'anfitrion', anfitrion) ORDER BY orden), '[]'::json) AS lista FROM entradas`,
    [body.partidoId]
  );
  return { success: true, data: r.rows[0].lista };
}

async function quitarJugadorPartido(pool, body) {
  const r = await pool.query(
    `WITH cancelar_conf AS (
       UPDATE sport_control.confirmaciones_partido SET estado = 'cancelado', timestamp_cancelacion = NOW() WHERE partido_id = $1 AND jugador_id = $2 RETURNING partido_id
     ), cancelar_invitados AS (
       UPDATE sport_control.invitados_asistencia SET estado = 'cancelado', timestamp_cancelacion = NOW() WHERE partido_id = $1 AND jugador_anfitrion_id = $2 AND estado = 'confirmado' RETURNING id
     ), limpiar_codigos AS (
       DELETE FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND ((jugador_id = $2 AND invitado_asistencia_id IS NULL) OR invitado_asistencia_id IN (SELECT id FROM cancelar_invitados)) AND usado = false RETURNING id
     )
     SELECT (SELECT COUNT(*) FROM cancelar_conf) AS confirmaciones_canceladas, (SELECT COUNT(*) FROM cancelar_invitados) AS invitados_cancelados`,
    [body.partidoId, body.jugadorId]
  );
  return { success: true, data: r.rows[0] };
}

async function quitarInvitadoPartido(pool, body) {
  await pool.query(
    `WITH invitado_info AS (SELECT ia.id, ia.partido_id, p.estado AS partido_estado FROM sport_control.invitados_asistencia ia JOIN sport_control.partidos p ON p.id = ia.partido_id WHERE ia.id = $1),
     borrar_codigos AS (DELETE FROM sport_control.codigos_asistencia WHERE invitado_asistencia_id = (SELECT id FROM invitado_info) AND usado = false RETURNING id),
     hard_delete AS (DELETE FROM sport_control.invitados_asistencia WHERE id IN (SELECT id FROM invitado_info WHERE partido_estado = 'confirmando') RETURNING id),
     soft_cancel AS (UPDATE sport_control.invitados_asistencia SET estado = 'cancelado' WHERE id IN (SELECT id FROM invitado_info WHERE partido_estado != 'confirmando') RETURNING id)
     SELECT 1`,
    [body.invitadoId]
  );
  return { success: true, data: true };
}

module.exports = {
  listarJugadoresDisponibles, agregarJugadorPartido, listarConfirmadosRemovibles, quitarJugadorPartido, quitarInvitadoPartido,
};
