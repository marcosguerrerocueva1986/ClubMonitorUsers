// api/_admin_estadisticas.js
// Cuantos usuarios ha "activado" cada app (jugador/representante) --
// activado = ya entro al menos una vez, no solo que este registrado.

async function obtenerEstadisticasApps(pool) {
  const jug = await pool.query(`
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM sport_control.sesiones_pwa s WHERE s.jugador_id = j.id)) AS activos
    FROM sport_control.jugadores j WHERE j.estado = 'activo'
  `);
  const rep = await pool.query(`
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE clave_hash IS NOT NULL) AS activos
    FROM sport_control.representantes
  `);
  return {
    success: true,
    data: {
      jugadores: { total: Number(jug.rows[0].total), activos: Number(jug.rows[0].activos) },
      representantes: { total: Number(rep.rows[0].total), activos: Number(rep.rows[0].activos) },
    },
  };
}

async function listarUsuariosJugadoresAdmin(pool) {
  const r = await pool.query(`
    SELECT j.id, j.nombres, j.apellidos,
      EXISTS(SELECT 1 FROM sport_control.sesiones_pwa s WHERE s.jugador_id = j.id) AS "tieneApp",
      (SELECT MAX(creado_en) FROM sport_control.sesiones_pwa s WHERE s.jugador_id = j.id) AS "ultimaConexion"
    FROM sport_control.jugadores j
    WHERE j.estado = 'activo'
    ORDER BY "tieneApp" ASC, j.nombres ASC
  `);
  return { success: true, data: r.rows };
}

async function listarUsuariosRepresentantesAdmin(pool) {
  const r = await pool.query(`
    SELECT r.id, r.nombres, r.apellidos, r.cedula,
      (r.clave_hash IS NOT NULL) AS "tieneApp",
      (SELECT MAX(creado_en) FROM sport_control.sesiones_representante s WHERE s.representante_id = r.id) AS "ultimaConexion",
      (SELECT STRING_AGG(j.nombres || ' ' || j.apellidos, ', ' ORDER BY j.nombres)
       FROM sport_control.jugador_representante jr JOIN sport_control.jugadores j ON j.id = jr.jugador_id
       WHERE jr.representante_id = r.id) AS "jugadoresVinculados"
    FROM sport_control.representantes r
    ORDER BY "tieneApp" ASC, r.nombres ASC
  `);
  return { success: true, data: r.rows };
}

module.exports = { obtenerEstadisticasApps, listarUsuariosJugadoresAdmin, listarUsuariosRepresentantesAdmin };
