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
  verDetallePartidoStatsJugador, verFotoPartidoAdmin,
} = require('./jugador');

async function actualizarPerfilRepresentante(pool, representanteId, body) {
  await pool.query(
    `UPDATE sport_control.representantes SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`,
    [body.nombres, body.apellidos, body.telefono, representanteId]
  );
  return { success: true, data: true };
}

async function listarNovedadesVisiblesJugador(pool, representanteId, body) {
  const r = await pool.query(
    `SELECT n.id, n.creado_en AS "creadoEn", n.tipo, n.descripcion,
       e.nombres || ' ' || e.apellidos AS "entrenadorNombre",
       g.nombre AS "grupoNombre"
     FROM sport_control.novedades_jugador n
     LEFT JOIN sport_control.entrenadores e ON e.id = n.entrenador_id
     LEFT JOIN sport_control.jugadores j ON j.id = n.jugador_id
     LEFT JOIN sport_control.grupos g ON g.id = j.grupo_id
     WHERE n.jugador_id = $1 AND n.visible_representante = true
       AND NOT EXISTS (SELECT 1 FROM sport_control.novedades_leidas nl WHERE nl.novedad_id = n.id AND nl.representante_id = $2)
     ORDER BY n.creado_en DESC`,
    [body.jugadorId, representanteId]
  );
  return { success: true, data: r.rows };
}

async function marcarNovedadLeidaRepresentante(pool, representanteId, body) {
  await pool.query(
    `INSERT INTO sport_control.novedades_leidas (novedad_id, representante_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [body.novedadId, representanteId]
  );
  return { success: true };
}

async function obtenerPerfilRepresentante(pool, representanteId) {
  const r = await pool.query(`SELECT id, nombres, apellidos, telefono, cedula FROM sport_control.representantes WHERE id = $1`, [representanteId]);
  const permisos = await pool.query(`SELECT funcionalidad, habilitado FROM sport_control.permisos_pantallas WHERE rol = 'representante'`);
  const mapa = {};
  permisos.rows.forEach(p => { mapa[p.funcionalidad] = p.habilitado; });
  return { success: true, data: {
    ...r.rows[0],
    miCuentaHabilitado: mapa.mi_cuenta !== undefined ? mapa.mi_cuenta : true,
    partidosHabilitado: mapa.partidos !== undefined ? mapa.partidos : true,
  }};
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

const bcrypt = require('bcryptjs');
const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

// Paso 1: solo cedula. Dice si existe, y si ya tiene clave creada o no.
async function loginRepresentante(pool, body) {
  const cedula = String(body.cedula || '').trim();
  if (!cedula) return { success: false, error: 'Ingresa tu cédula.' };
  const r = await pool.query(`SELECT id, nombres, clave_hash, bloqueado_hasta FROM sport_control.representantes WHERE cedula = $1`, [cedula]);
  if (!r.rows[0]) return { success: true, data: { registrado: false } };
  if (r.rows[0].bloqueado_hasta && new Date(r.rows[0].bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }
  return { success: true, data: { registrado: true, tieneClave: !!r.rows[0].clave_hash, nombres: r.rows[0].nombres } };
}

// Paso 2a: primera vez -- crea su clave (no existia clave_hash todavia).
async function crearClaveRepresentante(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();
  if (!/^\d{6}$/.test(clave)) return { success: false, error: 'La clave debe ser de exactamente 6 números.' };
  const r = await pool.query(`SELECT id, nombres, clave_hash FROM sport_control.representantes WHERE cedula = $1`, [cedula]);
  if (!r.rows[0]) return { success: false, error: 'No se encontró esa cédula.' };
  if (r.rows[0].clave_hash) return { success: false, error: 'Ya tienes una clave creada. Ingrésala para entrar.' };
  const hash = await bcrypt.hash(clave, 10);
  await pool.query(`UPDATE sport_control.representantes SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, r.rows[0].id]);
  const token = await crearSesionRepresentante(pool, r.rows[0].id);
  return { success: true, data: { token, nombres: r.rows[0].nombres, representanteId: r.rows[0].id } };
}

// Paso 2b: ya tenia clave -- la verifica.
async function verificarClaveRepresentante(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();
  const r = await pool.query(
    `SELECT id, nombres, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.representantes WHERE cedula = $1`,
    [cedula]
  );
  if (!r.rows[0]) return { success: false, error: 'No se encontró esa cédula.' };
  const rep = r.rows[0];

  if (rep.bloqueado_hasta && new Date(rep.bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }
  if (rep.debe_cambiar_clave && rep.clave_reset_expira && new Date(rep.clave_reset_expira) < new Date()) {
    return { success: false, error: 'Tu clave temporal ya venció. Pídele al Admin que te genere una nueva.' };
  }

  const coincide = rep.clave_hash && await bcrypt.compare(clave, rep.clave_hash);
  if (!coincide) {
    const intentos = rep.intentos_fallidos + 1;
    if (intentos >= MAX_INTENTOS) {
      await pool.query(
        `UPDATE sport_control.representantes SET intentos_fallidos = 0, bloqueado_hasta = NOW() + ($1 || ' minutes')::interval WHERE id = $2`,
        [MINUTOS_BLOQUEO, rep.id]
      );
      return { success: false, error: `Demasiados intentos fallidos. Espera ${MINUTOS_BLOQUEO} minutos o pide al Admin que te resetee la clave.` };
    }
    await pool.query(`UPDATE sport_control.representantes SET intentos_fallidos = $1 WHERE id = $2`, [intentos, rep.id]);
    return { success: false, error: 'Clave incorrecta.' };
  }

  await pool.query(`UPDATE sport_control.representantes SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`, [rep.id]);
  const token = await crearSesionRepresentante(pool, rep.id);
  return { success: true, data: { token, nombres: rep.nombres, debeCambiarClave: rep.debe_cambiar_clave, representanteId: rep.id } };
}

// Cambiar clave estando logeado (uso normal, o para completar un reseteo).
async function cambiarClaveRepresentante(pool, representanteId, body) {
  const claveActual = String(body.claveActual || '').trim();
  const claveNueva = String(body.claveNueva || '').trim();
  if (!/^\d{6}$/.test(claveNueva)) return { success: false, error: 'La clave nueva debe ser de exactamente 6 números.' };
  const r = await pool.query(`SELECT clave_hash FROM sport_control.representantes WHERE id = $1`, [representanteId]);
  const coincide = r.rows[0] && r.rows[0].clave_hash && await bcrypt.compare(claveActual, r.rows[0].clave_hash);
  if (!coincide) return { success: false, error: 'Tu clave actual no es correcta.' };
  const hash = await bcrypt.hash(claveNueva, 10);
  await pool.query(`UPDATE sport_control.representantes SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, representanteId]);
  return { success: true };
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
    if (accion === 'crear_clave_representante') return res.status(200).json(await crearClaveRepresentante(pool, body));
    if (accion === 'verificar_clave_representante') return res.status(200).json(await verificarClaveRepresentante(pool, body));

    const representanteId = await resolverSesionRepresentante(pool, token);
    if (!representanteId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    if (accion === 'listar_mis_jugadores_representante') {
      return res.status(200).json(await listarMisJugadoresRepresentante(pool, representanteId));
    }
    if (accion === 'actualizar_perfil_representante') {
      return res.status(200).json(await actualizarPerfilRepresentante(pool, representanteId, body));
    }
    if (accion === 'cambiar_clave_representante') {
      return res.status(200).json(await cambiarClaveRepresentante(pool, representanteId, body));
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
      case 'ver_detalle_partido_stats_representante': return res.status(200).json(await verDetallePartidoStatsJugador(pool, body));
      case 'ver_foto_partido_representante': return res.status(200).json(await verFotoPartidoAdmin(pool, body));
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
      case 'listar_novedades_visibles_jugador_representante': return res.status(200).json(await listarNovedadesVisiblesJugador(pool, representanteId, body));
      case 'marcar_novedad_leida_representante': return res.status(200).json(await marcarNovedadLeidaRepresentante(pool, representanteId, body));
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
    // Temporal: devolvemos el mensaje real del error para diagnosticar.
    return res.status(200).json({ success: false, error: 'Error interno: ' + (err && err.message ? err.message : String(err)) });
  }
};
