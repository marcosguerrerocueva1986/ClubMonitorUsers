// api/_valoracion.js
// ============================================================
// METODO GENERICO DE VALORACION (Performance Index Rating, FIBA)
//
//   VAL = (puntos + rebotes + asistencias + recuperaciones + tapones)
//         - (tiros fallados + perdidas + faltas cometidas)
//
// No hay nombres fijos en este archivo: cada estadistica del catalogo
// (tipos_estadistica) trae su propio `peso_valoracion`, editable desde
// Admin. Si un tipo no tiene peso configurado, se usa como respaldo
// los puntos que suma al marcador (asi TLC/Doble/Triple valen 1/2/3
// aunque nadie haya tocado el catalogo) y 0 para el resto.
//
// TODA pantalla que necesite una valoracion (un partido, un torneo,
// el historico de un grupo) debe pasar por aqui -- una sola formula.
// ============================================================

const { minutosJugadosPartido } = require('./_reloj_partido');
function pesoDeTipo(t) {
  if (t.pesoValoracion !== null && t.pesoValoracion !== undefined) return Number(t.pesoValoracion);
  return Number(t.puntos) > 0 ? Number(t.puntos) : 0;
}

// filas: [{ nombre, puntos, pesoValoracion, valor }]
// Devuelve la valoracion total y el desglose (para mostrar "de donde sale").
function calcularValoracion(filas) {
  let valoracion = 0;
  let puntosAnotados = 0;
  const desglose = [];
  for (const f of filas) {
    const valor = Number(f.valor) || 0;
    if (valor === 0) continue;
    const peso = pesoDeTipo(f);
    const aporte = valor * peso;
    valoracion += aporte;
    if (Number(f.puntos) > 0) puntosAnotados += valor * Number(f.puntos);
    desglose.push({ nombre: f.nombre, valor, peso, aporte });
  }
  return { valoracion, puntosAnotados, desglose };
}

const SQL_SELECT_TIPO = `te.nombre, te.puntos, te.peso_valoracion AS "pesoValoracion"`;

// Arma el ranking a partir de filas ya agrupadas por jugador y tipo:
// [{ jugadorId, nombre, puntos, pesoValoracion, valor }]
async function armarRanking(pool, filas, partidosPorJugador, minutosMap) {
  const porJugador = new Map();
  for (const f of filas) {
    if (!porJugador.has(f.jugadorId)) porJugador.set(f.jugadorId, []);
    porJugador.get(f.jugadorId).push(f);
  }
  const ids = [...porJugador.keys()];
  if (ids.length === 0) return [];

  const info = await pool.query(
    `SELECT id, nombres || ' ' || apellidos AS nombre, COALESCE(alias, nombres) AS "nombreCorto",
            numero_camiseta AS "numeroCamiseta", foto_carnet AS "fotoCarnet"
     FROM sport_control.jugadores WHERE id = ANY($1::int[])`,
    [ids]
  );

  const ranking = info.rows.map((j) => {
    const r = calcularValoracion(porJugador.get(j.id) || []);
    const partidos = partidosPorJugador ? (partidosPorJugador.get(j.id) || 0) : null;
    const segundos = minutosMap ? (minutosMap.get(j.id) || 0) : null;
    return {
      jugadorId: j.id,
      nombre: j.nombre,
      nombreCorto: j.nombreCorto,
      numeroCamiseta: j.numeroCamiseta,
      fotoCarnet: j.fotoCarnet,
      valoracion: r.valoracion,
      puntos: r.puntosAnotados,
      partidosJugados: partidos,
      promedio: partidos ? r.valoracion / partidos : null,
      desglose: r.desglose,
      minutosJugados: segundos === null ? null : Math.round(segundos / 60),
      minutosFormato: segundos === null ? null : `${Math.floor(segundos / 60)}:${String(Math.floor(segundos % 60)).padStart(2, '0')}`,
    };
  });
  ranking.sort((a, b) => b.valoracion - a.valoracion || a.nombreCorto.localeCompare(b.nombreCorto));
  return ranking;
}

// ---- Un partido ----
async function valoracionPartido(pool, partidoId) {
  const f = await pool.query(
    `SELECT pe.jugador_id AS "jugadorId", ${SQL_SELECT_TIPO}, pe.valor
     FROM sport_control.partido_estadisticas pe
     JOIN sport_control.tipos_estadistica te ON te.id = pe.tipo_estadistica_id
     WHERE pe.partido_id = $1 AND pe.jugador_id IS NOT NULL AND te.nivel = 'jugador'`,
    [partidoId]
  );
  const minutosMap = await minutosJugadosPartido(pool, partidoId);
  return armarRanking(pool, f.rows, null, minutosMap);
}

// ---- Un torneo (evento), opcionalmente solo un grupo ----
async function valoracionEvento(pool, eventoId, grupoId) {
  const f = await pool.query(
    `SELECT pe.jugador_id AS "jugadorId", ${SQL_SELECT_TIPO}, SUM(pe.valor) AS valor
     FROM sport_control.partido_estadisticas pe
     JOIN sport_control.tipos_estadistica te ON te.id = pe.tipo_estadistica_id
     JOIN sport_control.partidos p ON p.id = pe.partido_id
     JOIN sport_control.jugadores j ON j.id = pe.jugador_id
     WHERE p.evento_id = $1 AND pe.jugador_id IS NOT NULL AND te.nivel = 'jugador'
       AND ($2::int IS NULL OR j.grupo_id = $2::int)
     GROUP BY pe.jugador_id, te.id, te.nombre, te.puntos, te.peso_valoracion`,
    [eventoId, grupoId || null]
  );

  // Partidos jugados = partidos del torneo ya disputados en los que la
  // jugadora estaba confirmada (para poder sacar la valoracion promedio).
  const pj = await pool.query(
    `SELECT cp.jugador_id AS "jugadorId", COUNT(DISTINCT cp.partido_id)::int AS n
     FROM sport_control.confirmaciones_partido cp
     JOIN sport_control.partidos p ON p.id = cp.partido_id
     WHERE p.evento_id = $1 AND cp.estado = 'confirmado'
       AND (p.estado = 'finalizado' OR EXISTS (SELECT 1 FROM sport_control.partido_estadisticas x WHERE x.partido_id = p.id))
     GROUP BY cp.jugador_id`,
    [eventoId]
  );
  const partidosPorJugador = new Map(pj.rows.map((r) => [r.jugadorId, r.n]));
  const ranking = await armarRanking(pool, f.rows, partidosPorJugador);
  const totalPartidos = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sport_control.partidos p
     WHERE p.evento_id = $1 AND (p.estado = 'finalizado' OR EXISTS (SELECT 1 FROM sport_control.partido_estadisticas x WHERE x.partido_id = p.id))`,
    [eventoId]
  );
  return { ranking, totalPartidos: totalPartidos.rows[0].n };
}

module.exports = { pesoDeTipo, calcularValoracion, valoracionPartido, valoracionEvento };
