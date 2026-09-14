// api/representante.js
//
// Backend del rol "Representante" (padre/madre/tutor). Login unicamente
// por cedula -- un representante puede estar vinculado a varios
// jugadores (jugador_representante), y cada peticion (salvo login y
// listar_mis_jugadores) debe indicar CUAL jugador se quiere consultar.
//
// Reutiliza las funciones de SOLO LECTURA ya construidas en jugador.js
// (exportadas ahi para este proposito exacto) -- nunca se duplica
// logica. El representante NUNCA puede tomar acciones (confirmar
// partidos, pagar, agregar invitados) -- solo consulta, tal como se
// definio. La unica pieza nueva aqui es el login y la verificacion de
// que el jugador solicitado realmente le pertenece a este representante.

const { getPool } = require('./_db');
const {
  obtenerMiPerfil, verMisPartidos, verPendientesPago, verMiQr, verMisUltimosPagos,
  verMisInvitados, listarMisEventos, verEventoPublico, verMovimientosEventoJugador,
  verComprobanteMovimientoJugador, actualizarMisDatos, analizarComprobante,
  registrarPagoComprobante, aplicarPago, aplicarPagoEvento, guardarSaldoFavor,
} = require('./jugador');

async function actualizarPerfilRepresentante(pool, representanteId, body) {
  await pool.query(
    `UPDATE sport_control.representantes SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`,
    [body.nombres, body.apellidos, body.telefono, representanteId]
  );
  return { success: true, data: true };
}

async function obtenerPerfilRepresentante(pool, representanteId) {
  const r = await pool.query(`SELECT nombres, apellidos, telefono, cedula FROM sport_control.representantes WHERE id = $1`, [representanteId]);
  return { success: true, data: r.rows[0] };
}

async function resolverSesionRepresentante(pool, token) {
  const r = await pool.query(
    `SELECT s.representante_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_representante s ON s.token = $1 LIMIT 1`,
    [token || '']
  );
  return r.rows[0] && r.rows[0].representante_id;
}

async function crearSesionRepresentante(pool, representanteId) {
  const r = await pool.query(
    `INSERT INTO sport_control.sesiones_representante (representante_id, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
    [representanteId]
  );
  return r.rows[0].token;
}

async function loginRepresentante(pool, body) {
  const cedula = String(body.cedula || '').trim();
  if (!cedula) return { success: false, error: 'Ingresa tu cédula.' };
  const r = await pool.query(`SELECT id, nombres FROM sport_control.representantes WHERE cedula = $1`, [cedula]);
  if (!r.rows[0]) return { success: true, data: { registrado: false } };
  const token = await crearSesionRepresentante(pool, r.rows[0].id);
  return { success: true, data: { registrado: true, token, nombres: r.rows[0].nombres } };
}

async function listarMisJugadoresRepresentante(pool, representanteId) {
  const r = await pool.query(
    `SELECT j.id, j.nombres, j.apellidos, j.estado, jr.descripcion
     FROM sport_control.jugador_representante jr
     JOIN sport_control.jugadores j ON j.id = jr.jugador_id
     WHERE jr.representante_id = $1 ORDER BY j.nombres`,
    [representanteId]
  );
  return { success: true, data: r.rows };
}

// Verifica que el jugadorId solicitado realmente le pertenezca a este
// representante -- barrera de seguridad obligatoria antes de reusar
// cualquier funcion de jugador.js. Sin esto, cualquier representante
// podria pedir informacion de CUALQUIER jugador con solo adivinar su id.
async function verificarVinculo(pool, representanteId, jugadorId) {
  const r = await pool.query(
    `SELECT 1 FROM sport_control.jugador_representante WHERE representante_id = $1 AND jugador_id = $2`,
    [representanteId, jugadorId]
  );
  return !!r.rows[0];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  const body = req.body || {};
  const { accion, token } = body;
  const pool = getPool();

  try {
    if (accion === 'login_representante') return res.status(200).json(await loginRepresentante(pool, body));

    const representanteId = await resolverSesionRepresentante(pool, token);
    if (!representanteId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    if (accion === 'listar_mis_jugadores_representante') {
      return res.status(200).json(await listarMisJugadoresRepresentante(pool, representanteId));
    }
    if (accion === 'actualizar_perfil_representante') {
      return res.status(200).json(await actualizarPerfilRepresentante(pool, representanteId, body));
    }
    if (accion === 'obtener_perfil_representante') {
      return res.status(200).json(await obtenerPerfilRepresentante(pool, representanteId));
    }
    if (accion === 'analizar_comprobante_representante') {
      return res.status(200).json(await analizarComprobante(pool, body));
    }

    // Todas las demas acciones necesitan saber de que jugador se trata,
    // y se verifica el vinculo antes de reutilizar la funcion del jugador.
    const jugadorId = body.jugadorId ? parseInt(body.jugadorId) : null;
    if (jugadorId) {
      const vinculado = await verificarVinculo(pool, representanteId, jugadorId);
      if (!vinculado) return res.status(200).json({ success: false, error: 'Ese jugador no está vinculado a tu cuenta.' });
    }

    switch (accion) {
      case 'obtener_perfil_jugador_representante': return res.status(200).json(await obtenerMiPerfil(pool, jugadorId));
      case 'ver_partidos_jugador_representante': return res.status(200).json(await verMisPartidos(pool, jugadorId));
      case 'ver_deuda_jugador_representante': return res.status(200).json(await verPendientesPago(pool, jugadorId));
      case 'ver_qr_jugador_representante': return res.status(200).json(await verMiQr(pool, jugadorId, body.partidoId));
      case 'ver_pagos_jugador_representante': return res.status(200).json(await verMisUltimosPagos(pool, jugadorId));
      case 'ver_invitados_partido_representante': return res.status(200).json(await verMisInvitados(pool, jugadorId, body));
      case 'listar_eventos_jugador_representante': return res.status(200).json(await listarMisEventos(pool, jugadorId));
      case 'ver_evento_publico_representante': return res.status(200).json(await verEventoPublico(pool, jugadorId, body));
      // Estas dos no dependen de un jugador especifico (transparencia
      // financiera abierta, igual que ya funciona para cualquier jugador
      // logeado) -- no necesitan jugadorId ni la verificacion de vinculo.
      case 'ver_movimientos_evento_representante': return res.status(200).json(await verMovimientosEventoJugador(pool, body));
      case 'ver_comprobante_movimiento_representante': return res.status(200).json(await verComprobanteMovimientoJugador(pool, body));
      case 'actualizar_datos_jugador_representante': return res.status(200).json(await actualizarMisDatos(pool, jugadorId, body));
      case 'registrar_pago_comprobante_representante': return res.status(200).json(await registrarPagoComprobante(pool, jugadorId, body));
      case 'aplicar_pago_representante': return res.status(200).json(await aplicarPago(pool, jugadorId, body));
      case 'aplicar_pago_evento_representante': return res.status(200).json(await aplicarPagoEvento(pool, jugadorId, body));
      case 'guardar_saldo_favor_representante': return res.status(200).json(await guardarSaldoFavor(pool, jugadorId, body));
      default:
        return res.status(200).json({ success: false, error: 'Accion no reconocida' });
    }
  } catch (err) {
    console.error(`Error en /api/representante (accion=${accion}):`, err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
