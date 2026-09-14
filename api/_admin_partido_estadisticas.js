// api/_admin_partido_estadisticas.js
// Pantalla generica de captura de estadisticas de un partido -- se
// arma sola segun el catalogo de la disciplina del partido, sin
// importar cual sea (futbol, baloncesto, o lo que se agregue despues).

async function verEstadisticasPartidoAdmin(pool, body) {
  const { partidoId } = body;

  const partidoR = await pool.query(
    `SELECT p.id, p.alias, p.fecha, p.hora, p.lugar, p.rival_nombre, p.marcador_propio, p.marcador_rival,
            p.notas, p.jugador_destacado_id, p.disciplina_id,
            (p.foto_equipo_base64 IS NOT NULL) AS "tieneFotoEquipo",
            (p.foto_planilla_base64 IS NOT NULL) AS "tieneFotoPlanilla",
            d.nombre AS "disciplinaNombre", d.icono AS "disciplinaIcono"
     FROM sport_control.partidos p
     LEFT JOIN sport_control.disciplinas d ON d.id = p.disciplina_id
     WHERE p.id = $1`,
    [partidoId]
  );
  const partido = partidoR.rows[0];
  if (!partido) return { success: false, error: 'Partido no encontrado.' };
  if (!partido.disciplina_id) return { success: false, error: 'Este partido no tiene una disciplina asignada. Revisa Catálogos → Disciplinas.' };

  const tipos = await pool.query(
    `SELECT id, nombre, clave, nivel FROM sport_control.tipos_estadistica WHERE disciplina_id = $1 AND activo = true ORDER BY orden, nombre`,
    [partido.disciplina_id]
  );

  const jugadores = await pool.query(
    `SELECT j.id, j.nombres || ' ' || j.apellidos AS nombre
     FROM sport_control.confirmaciones_partido cp
     JOIN sport_control.jugadores j ON j.id = cp.jugador_id
     WHERE cp.partido_id = $1 AND cp.estado = 'confirmado'
     ORDER BY j.nombres`,
    [partidoId]
  );

  const valores = await pool.query(
    `SELECT tipo_estadistica_id AS "tipoEstadisticaId", jugador_id AS "jugadorId", valor
     FROM sport_control.partido_estadisticas WHERE partido_id = $1`,
    [partidoId]
  );

  return {
    success: true,
    data: {
      partido,
      tipos: tipos.rows,
      jugadores: jugadores.rows,
      valores: valores.rows,
    },
  };
}

async function guardarEstadisticasPartidoAdmin(pool, body) {
  const {
    partidoId, marcadorPropio, marcadorRival, rivalNombre, notas, jugadorDestacadoId,
    fotoEquipoBase64, fotoPlanillaBase64, valoresJugador, valoresEquipo,
  } = body;

  await pool.query(
    `UPDATE sport_control.partidos
     SET marcador_propio = $1, marcador_rival = $2, rival_nombre = $3, notas = $4, jugador_destacado_id = $5
     WHERE id = $6`,
    [marcadorPropio ?? null, marcadorRival ?? null, rivalNombre || null, notas || null, jugadorDestacadoId || null, partidoId]
  );

  if (fotoEquipoBase64) {
    await pool.query(`UPDATE sport_control.partidos SET foto_equipo_base64 = $1 WHERE id = $2`, [fotoEquipoBase64, partidoId]);
  }
  if (fotoPlanillaBase64) {
    await pool.query(`UPDATE sport_control.partidos SET foto_planilla_base64 = $1 WHERE id = $2`, [fotoPlanillaBase64, partidoId]);
  }

  for (const v of (valoresJugador || [])) {
    await pool.query(
      `INSERT INTO sport_control.partido_estadisticas (partido_id, tipo_estadistica_id, jugador_id, valor, actualizado_en)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (partido_id, tipo_estadistica_id, jugador_id) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [partidoId, v.tipoEstadisticaId, v.jugadorId, v.valor || 0]
    );
  }
  for (const v of (valoresEquipo || [])) {
    await pool.query(
      `INSERT INTO sport_control.partido_estadisticas (partido_id, tipo_estadistica_id, jugador_id, valor, actualizado_en)
       VALUES ($1, $2, NULL, $3, NOW())
       ON CONFLICT (partido_id, tipo_estadistica_id) WHERE jugador_id IS NULL DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [partidoId, v.tipoEstadisticaId, v.valor || 0]
    );
  }

  return { success: true };
}

async function verFotoPartidoAdmin(pool, body) {
  const { partidoId, tipo } = body;
  const columna = tipo === 'planilla' ? 'foto_planilla_base64' : 'foto_equipo_base64';
  const r = await pool.query(`SELECT ${columna} AS foto FROM sport_control.partidos WHERE id = $1`, [partidoId]);
  return { success: true, data: { foto: r.rows[0] ? r.rows[0].foto : null } };
}

module.exports = { verEstadisticasPartidoAdmin, guardarEstadisticasPartidoAdmin, verFotoPartidoAdmin };
