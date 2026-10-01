// api/_reloj_partido.js
// ============================================================
// RELOJ DE JUEGO (cronometro que SUMA, no cuenta regresiva),
// EN CANCHA / BANCA, y MINUTOS JUGADOS.
//
// El reloj se guarda como "segundos_acumulados" (congelado) + si esta
// corriendo, desde cuando (iniciado_en). El tiempo transcurrido se
// calcula al vuelo con la expresion SQL_ELAPSED, nunca hay que mandar
// un tick cada segundo al servidor.
//
// Los minutos de cada jugadora se acumulan en TIEMPO DE RELOJ, no en
// tiempo real: cuando entra se anota en que segundo del reloj entro
// (segundos_al_entrar); cuando sale, se le suma la diferencia a su
// acumulado. Como el reloj se pausa entre jugadas, si esta pausado no
// se le suma nada a nadie -- no hace falta logica especial para eso,
// sale solo de la formula.
// ============================================================

const SQL_ELAPSED = `(pr.segundos_acumulados + CASE WHEN pr.corriendo THEN GREATEST(0, EXTRACT(EPOCH FROM NOW() - pr.iniciado_en))::int ELSE 0 END)`;

async function asegurarReloj(pool, partidoId) {
  await pool.query(
    `INSERT INTO sport_control.partido_reloj (partido_id) VALUES ($1) ON CONFLICT (partido_id) DO NOTHING`,
    [partidoId]
  );
}

async function obtenerEstadoReloj(pool, partidoId) {
  await asegurarReloj(pool, partidoId);
  const r = await pool.query(
    `SELECT pr.periodo, pr.corriendo, ${SQL_ELAPSED} AS "segundosTranscurridos"
     FROM sport_control.partido_reloj pr WHERE pr.partido_id = $1`,
    [partidoId]
  );
  return r.rows[0];
}

async function obtenerJugadoresEnCancha(pool, partidoId) {
  const r = await pool.query(
    `SELECT pjt.jugador_id AS "jugadorId", pjt.en_cancha AS "enCancha"
     FROM sport_control.partido_jugador_tiempo pjt WHERE pjt.partido_id = $1 AND pjt.en_cancha = true`,
    [partidoId]
  );
  return r.rows.map((x) => x.jugadorId);
}

async function iniciarReloj(pool, body) {
  const { partidoId } = body;
  await asegurarReloj(pool, partidoId);
  await pool.query(
    `UPDATE sport_control.partido_reloj SET corriendo = true, iniciado_en = NOW() WHERE partido_id = $1 AND corriendo = false`,
    [partidoId]
  );
  return { success: true, data: await obtenerEstadoReloj(pool, partidoId) };
}

async function pausarReloj(pool, body) {
  const { partidoId } = body;
  await asegurarReloj(pool, partidoId);
  await pool.query(
    `UPDATE sport_control.partido_reloj pr SET
       segundos_acumulados = ${SQL_ELAPSED}, corriendo = false, iniciado_en = NULL
     WHERE pr.partido_id = $1 AND pr.corriendo = true`,
    [partidoId]
  );
  return { success: true, data: await obtenerEstadoReloj(pool, partidoId) };
}

async function avanzarPeriodo(pool, body) {
  const { partidoId } = body;
  await asegurarReloj(pool, partidoId);
  await pool.query(`UPDATE sport_control.partido_reloj SET periodo = periodo + 1 WHERE partido_id = $1`, [partidoId]);
  return { success: true, data: await obtenerEstadoReloj(pool, partidoId) };
}

// Ajuste manual del reloj (minutos:segundos y/o periodo). Si hay
// jugadoras en cancha, se "cierra y reabre" su turno en el momento del
// ajuste para no romper los minutos que ya llevaban ganados.
async function ajustarReloj(pool, body) {
  const { partidoId, segundos, periodo } = body;
  await asegurarReloj(pool, partidoId);

  await pool.query(
    `UPDATE sport_control.partido_jugador_tiempo pjt SET
       segundos_acumulados = pjt.segundos_acumulados + GREATEST(0, ${SQL_ELAPSED} - pjt.segundos_al_entrar),
       segundos_al_entrar = $2
     FROM sport_control.partido_reloj pr
     WHERE pjt.partido_id = $1 AND pr.partido_id = $1 AND pjt.en_cancha = true`,
    [partidoId, Number(segundos) || 0]
  );

  const sets = [`segundos_acumulados = $2`];
  const vals = [partidoId, Math.max(0, Number(segundos) || 0)];
  let i = 3;
  if (periodo !== undefined && periodo !== null) { sets.push(`periodo = $${i++}`); vals.push(Math.max(1, Number(periodo) || 1)); }
  // Si estaba corriendo, se re-ancla desde ahora para que siga sumando desde el nuevo valor.
  sets.push(`iniciado_en = CASE WHEN corriendo THEN NOW() ELSE iniciado_en END`);
  await pool.query(`UPDATE sport_control.partido_reloj SET ${sets.join(', ')} WHERE partido_id = $1`, vals);

  return { success: true, data: await obtenerEstadoReloj(pool, partidoId) };
}

// Entra / sale una jugadora de la cancha. Devuelve ademas cuantas
// quedan en cancha, para el aviso informativo (nunca bloquea).
async function toggleJugadorCancha(pool, body) {
  const { partidoId, jugadorId } = body;
  await asegurarReloj(pool, partidoId);
  await pool.query(
    `INSERT INTO sport_control.partido_jugador_tiempo (partido_id, jugador_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [partidoId, jugadorId]
  );

  const actual = await pool.query(
    `SELECT en_cancha AS "enCancha" FROM sport_control.partido_jugador_tiempo WHERE partido_id = $1 AND jugador_id = $2`,
    [partidoId, jugadorId]
  );
  const entrando = !actual.rows[0].enCancha;

  if (entrando) {
    await pool.query(
      `UPDATE sport_control.partido_jugador_tiempo pjt SET en_cancha = true, segundos_al_entrar = ${SQL_ELAPSED}
       FROM sport_control.partido_reloj pr WHERE pjt.partido_id = $1 AND pr.partido_id = $1 AND pjt.jugador_id = $2`,
      [partidoId, jugadorId]
    );
  } else {
    await pool.query(
      `UPDATE sport_control.partido_jugador_tiempo pjt SET
         en_cancha = false,
         segundos_acumulados = pjt.segundos_acumulados + GREATEST(0, ${SQL_ELAPSED} - pjt.segundos_al_entrar),
         segundos_al_entrar = NULL
       FROM sport_control.partido_reloj pr WHERE pjt.partido_id = $1 AND pr.partido_id = $1 AND pjt.jugador_id = $2`,
      [partidoId, jugadorId]
    );
  }

  const reloj = await obtenerEstadoReloj(pool, partidoId);
  await pool.query(
    `INSERT INTO sport_control.partido_cambios_log (partido_id, jugador_id, entro, periodo, segundos_reloj)
     VALUES ($1, $2, $3, $4, $5)`,
    [partidoId, jugadorId, entrando, reloj.periodo, reloj.segundosTranscurridos]
  );

  const enCancha = await obtenerJugadoresEnCancha(pool, partidoId);
  return { success: true, data: { jugadorId, enCancha: entrando, totalEnCancha: enCancha.length, enCanchaIds: enCancha } };
}

// Minutos jugados de cada jugadora de un partido (incluye el turno
// actual si sigue en cancha). Para usar en valoracion y en pantallas
// de detalle.
async function minutosJugadosPartido(pool, partidoId) {
  const r = await pool.query(
    `SELECT pjt.jugador_id AS "jugadorId",
       (pjt.segundos_acumulados + CASE WHEN pjt.en_cancha THEN GREATEST(0, ${SQL_ELAPSED} - pjt.segundos_al_entrar) ELSE 0 END) AS "segundos"
     FROM sport_control.partido_jugador_tiempo pjt
     JOIN sport_control.partido_reloj pr ON pr.partido_id = pjt.partido_id
     WHERE pjt.partido_id = $1`,
    [partidoId]
  );
  const mapa = new Map();
  r.rows.forEach((row) => mapa.set(row.jugadorId, Number(row.segundos)));
  return mapa;
}

module.exports = {
  obtenerEstadoReloj, obtenerJugadoresEnCancha, iniciarReloj, pausarReloj,
  avanzarPeriodo, ajustarReloj, toggleJugadorCancha, minutosJugadosPartido,
};
