// api/admin.js
// Router principal del panel Admin. TODAS las acciones (46) se resuelven
// aqui, importando helpers de los archivos _admin_*.js (que no cuentan
// como funciones serverless independientes por la misma razon que en
// api/jugador.js: mantenerse muy por debajo del limite de 12 del plan
// Hobby de Vercel).
//
// Autenticacion: clave compartida (no hay sesion por token). Se compara
// body.clave contra configuracion_club.clave_admin_app en cada peticion,
// igual que hacia n8n con el nodo 'Clave Correcta App'.

const { getPool, cargarConfig, listarPartidos, crearPartido, cancelarPartido, eliminarPartido, editarPartido, finalizarPartido, marcarEnJuego, cerrarPartido, reabrirPartido, listarTiposPartido } = require('./_admin_partidos');
const { listarJugadores, actualizarJugador, verDetalleJugador, verPendientesJugador, verPagosJugador, crearJugadorManual, verConfirmadosPartido, verCheckinPartido, verInvitadosPartido } = require('./_admin_jugadores');
const { obtenerParametros, actualizarParametro, reenviarQrJugador, anularMulta, confirmarMultas, toggleAsistencia, enviarRecordatorioPartido, enviarRecordatorioMorosos, marcarPagoInvitado, marcarMultaPagada } = require('./_admin_operaciones');
const { registrarPagoEfectivo, marcarMesesPagados, registrarPagoCategorizado, verRecaudadoMes, listarInformeCompleto, obtenerDashboard, listarEstadoPagos, analizarComprobanteAdmin, registrarPagoComprobanteAdmin, aplicarPagoComprobanteAdmin, guardarSaldoFavorAdmin, verPendientesCategorizado } = require('./_admin_pagos');
const { listarJugadoresDisponibles, agregarJugadorPartido, listarConfirmadosRemovibles, quitarJugadorPartido, quitarInvitadoPartido } = require('./_admin_gestion_partido');
const { revisarMultasPartido, enviarMultasJugadoresApp, enviarResumenMultasGrupoApp } = require('./_admin_multas_revision');
const { listarExentosPendientes, aprobarExento, rechazarExento, listarExentosAprobados, revocarExento, listarCatalogo, crearItemCatalogo, toggleItemCatalogo } = require('./_admin_exentos_catalogos');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });

  const body = req.body || {};
  const { accion, clave } = body;
  const pool = getPool();

  try {
    const config = await cargarConfig(pool);
    if (!config || clave !== config.clave_admin_app) {
      return res.status(200).json({ success: false, error: 'Clave incorrecta' });
    }

    switch (accion) {
      case 'listar_partidos': return res.status(200).json(await listarPartidos(pool));
      case 'crear_partido': return res.status(200).json(await crearPartido(pool, config, body));
      case 'cancelar_partido': return res.status(200).json(await cancelarPartido(pool, config, body));
      case 'eliminar_partido': return res.status(200).json(await eliminarPartido(pool, body));
      case 'editar_partido': return res.status(200).json(await editarPartido(pool, config, body));
      case 'listar_tipos_partido': return res.status(200).json(await listarTiposPartido(pool));
      case 'listar_jugadores': return res.status(200).json(await listarJugadores(pool, body));
      case 'actualizar_jugador': return res.status(200).json(await actualizarJugador(pool, body));
      case 'obtener_parametros': return res.status(200).json(await obtenerParametros(pool));
      case 'actualizar_parametro': return res.status(200).json(await actualizarParametro(pool, body));
      case 'finalizar_partido': return res.status(200).json(await finalizarPartido(pool, config, body));
      case 'ver_confirmados_partido': return res.status(200).json(await verConfirmadosPartido(pool, body));
      case 'ver_checkin_partido': return res.status(200).json(await verCheckinPartido(pool, body));
      case 'ver_invitados_partido': return res.status(200).json(await verInvitadosPartido(pool, body));
      case 'marcar_en_juego': return res.status(200).json(await marcarEnJuego(pool, body));
      case 'reenviar_qr_jugador': return res.status(200).json(await reenviarQrJugador(pool, config, body));
      case 'anular_multa_app': return res.status(200).json(await anularMulta(pool, body));
      case 'confirmar_multas_app': return res.status(200).json(await confirmarMultas(pool, config, body));
      case 'toggle_asistencia_app': return res.status(200).json(await toggleAsistencia(pool, body));
      case 'enviar_recordatorio_app': return res.status(200).json(await enviarRecordatorioPartido(pool, config, body));
      case 'marcar_pago_invitado_app': return res.status(200).json(await marcarPagoInvitado(pool, body));
      case 'registrar_pago_efectivo_app': return res.status(200).json(await registrarPagoEfectivo(pool, body));
      case 'obtener_dashboard_app': return res.status(200).json(await obtenerDashboard(pool));
      case 'listar_estado_pagos_app': return res.status(200).json(await listarEstadoPagos(pool));
      case 'enviar_recordatorio_morosos_app': return res.status(200).json(await enviarRecordatorioMorosos(pool, config));
      case 'ver_detalle_jugador_app': return res.status(200).json(await verDetalleJugador(pool, body));
      case 'ver_pendientes_jugador_app': return res.status(200).json(await verPendientesJugador(pool, body));
      case 'marcar_multa_pagada_app': return res.status(200).json(await marcarMultaPagada(pool, body));
      case 'marcar_meses_pagados_app': return res.status(200).json(await marcarMesesPagados(pool, body));
      case 'ver_pagos_jugador_app': return res.status(200).json(await verPagosJugador(pool, body));
      case 'ver_pendientes_categorizado_app': return res.status(200).json(await verPendientesCategorizado(pool, body));
      case 'registrar_pago_categorizado_app': return res.status(200).json(await registrarPagoCategorizado(pool, body));
      case 'ver_recaudado_mes_app': return res.status(200).json(await verRecaudadoMes(pool));
      case 'listar_informe_completo_app': return res.status(200).json(await listarInformeCompleto(pool));
      case 'cerrar_partido_app': return res.status(200).json(await cerrarPartido(pool, body));
      case 'reabrir_partido_app': return res.status(200).json(await reabrirPartido(pool, body));
      case 'listar_jugadores_disponibles_partido_app': return res.status(200).json(await listarJugadoresDisponibles(pool, body));
      case 'agregar_jugador_partido_app': return res.status(200).json(await agregarJugadorPartido(pool, body));
      case 'listar_confirmados_removibles_partido_app': return res.status(200).json(await listarConfirmadosRemovibles(pool, body));
      case 'quitar_jugador_partido_app': return res.status(200).json(await quitarJugadorPartido(pool, body));
      case 'quitar_invitado_partido_app': return res.status(200).json(await quitarInvitadoPartido(pool, body));
      case 'revisar_multas_partido': return res.status(200).json(await revisarMultasPartido(pool, config, body));
      case 'enviar_multas_jugadores_app': return res.status(200).json(await enviarMultasJugadoresApp(pool, config, body));
      case 'enviar_resumen_multas_grupo_app': return res.status(200).json(await enviarResumenMultasGrupoApp(pool, config, body));
      case 'listar_exentos_pendientes_app': return res.status(200).json(await listarExentosPendientes(pool));
      case 'aprobar_exento_app': return res.status(200).json(await aprobarExento(pool, body));
      case 'rechazar_exento_app': return res.status(200).json(await rechazarExento(pool, body));
      case 'listar_exentos_aprobados_app': return res.status(200).json(await listarExentosAprobados(pool));
      case 'revocar_exento_app': return res.status(200).json(await revocarExento(pool, body));
      case 'listar_catalogo_app': return res.status(200).json(await listarCatalogo(pool, body));
      case 'crear_item_catalogo_app': return res.status(200).json(await crearItemCatalogo(pool, body));
      case 'toggle_item_catalogo_app': return res.status(200).json(await toggleItemCatalogo(pool, body));
      case 'crear_jugador_manual_app': return res.status(200).json(await crearJugadorManual(pool, body));
      case 'analizar_comprobante_admin_app': return res.status(200).json(await analizarComprobanteAdmin(pool, body));
      case 'registrar_pago_comprobante_admin_app': return res.status(200).json(await registrarPagoComprobanteAdmin(pool, body));
      case 'aplicar_pago_comprobante_admin_app': return res.status(200).json(await aplicarPagoComprobanteAdmin(pool, body));
      case 'guardar_restante_saldo_favor_admin_app': return res.status(200).json(await guardarSaldoFavorAdmin(pool, body));
      default:
        return res.status(200).json({ success: false, error: 'Accion no reconocida' });
    }
  } catch (err) {
    console.error(`Error en /api/admin (accion=${accion}):`, err);
    // Temporal: devolvemos el mensaje real del error para diagnosticar.
    return res.status(200).json({ success: false, error: 'Error interno: ' + (err && err.message ? err.message : String(err)) });
  }
};
