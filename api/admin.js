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

const { getPool, cargarConfig, listarPartidos, crearPartido, cancelarPartido, eliminarPartido, editarPartido, finalizarPartido, marcarEnJuego, cerrarPartido, reabrirPartido, listarTiposPartido, verVinculoEventoPartido, vincularPartidoEvento, obtenerDetallePartidoParaEditar, editarPartidoCompleto } = require('./_admin_partidos');
const { obtenerEstadisticasApps, listarUsuariosJugadoresAdmin, listarUsuariosRepresentantesAdmin } = require('./_admin_estadisticas');
const { listarDisciplinas, listarDisciplinasActivas, crearDisciplina, editarDisciplina, toggleDisciplina, listarTiposEstadistica, crearTipoEstadistica, toggleTipoEstadistica, editarPuntosTipoEstadistica } = require('./_admin_disciplinas');
const { verEstadisticasPartidoAdmin, guardarEstadisticasPartidoAdmin, verFotoPartidoAdmin } = require('./_admin_partido_estadisticas');
const {
  listarGrupos, crearGrupo, editarGrupo, toggleGrupo, verDetalleGrupo,
  asignarJugadorGrupo, asignarEntrenadorGrupo, quitarEntrenadorGrupo,
  listarEntrenadores, crearEntrenador, editarEntrenador, toggleEntrenador, resetearClaveEntrenadorAdmin,
  crearHorarioGrupo, eliminarHorarioGrupo,
} = require('./_admin_entrenadores');
const { listarPantallasMenu, togglePantallaRol, toggleActivaPantalla } = require('./_admin_pantallas_menu');
const { listarPlanilleros, crearPlanillero, editarPlanillero, togglePlanillero, resetearClavePlanilleroAdmin } = require('./_admin_planilleros');
const { listarFinancieros, crearFinanciero, editarFinanciero, toggleFinanciero, resetearClaveFinancieroAdmin } = require('./_admin_financieros');
const { listarLugares, listarLugaresAdmin, crearLugar, editarLugar, toggleLugar, obtenerGoogleMapsApiKey } = require('./_admin_lugares');
const { listarRubros, crearRubro, editarRubro, toggleRubro, listarMovimientosClub, registrarMovimientoClub, eliminarMovimientoClub, verMensualidadJugadorAdmin, dashboardMorososMensualidad } = require('./_admin_finanzas_club');
const { listarJugadores, actualizarJugador, verDetalleJugador, verPendientesJugador, verPagosJugador, crearJugadorManual, verConfirmadosPartido, verCheckinPartido, verInvitadosPartido, listarRepresentantesJugadorAdmin, agregarRepresentanteAdmin, editarRepresentanteAdmin, eliminarRepresentanteAdmin, resetearClaveRepresentanteAdmin } = require('./_admin_jugadores');
const { obtenerParametros, actualizarParametro, reenviarQrJugador, anularMulta, confirmarMultas, toggleAsistencia, enviarRecordatorioPartido, enviarRecordatorioMorosos, marcarPagoInvitado, marcarMultaPagada, toggleEventosJugador, actualizarLogoClub, toggleRepresentantesClub, toggleMisExentosJugador, toggleMiCuentaJugador, toggleMovimientosSoloPropios, listarPermisosPantallas, togglePermisoPantalla, diagnosticoCatalogoCobros, listarVigenciasCobro, agregarVigenciaCobro, eliminarVigenciaCobro } = require('./_admin_operaciones');
const { crearEvento, editarEvento, listarEventos, crearEventoFecha, editarEventoFecha, eliminarEventoFecha, verDetalleEvento, guardarPresupuestoItem, eliminarPresupuestoItem, asignarCuotaJugador, aplicarCuotaATodos, quitarCuotaJugador, registrarMovimientoEvento, editarMovimientoEvento, eliminarMovimientoEvento, verComprobanteMovimiento, listarInformeConsolidadoEventos, listarTiposMovimientoEvento, crearTipoMovimientoEvento, toggleTipoMovimientoEvento, listarEventosSelector, listarFechasEventoSelector } = require('./_admin_eventos');
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
      case 'obtener_detalle_partido_editar_admin': return res.status(200).json(await obtenerDetallePartidoParaEditar(pool, body));
      case 'editar_partido_completo_admin': return res.status(200).json(await editarPartidoCompleto(pool, body));
      case 'listar_tipos_partido': return res.status(200).json(await listarTiposPartido(pool));
      case 'listar_jugadores': return res.status(200).json(await listarJugadores(pool, body));
      case 'actualizar_jugador': return res.status(200).json(await actualizarJugador(pool, body));
      case 'obtener_parametros': return res.status(200).json(await obtenerParametros(pool));
      case 'actualizar_parametro': return res.status(200).json(await actualizarParametro(pool, body));
      case 'diagnostico_catalogo_cobros_admin': return res.status(200).json(await diagnosticoCatalogoCobros(pool));
      case 'listar_vigencias_cobro_admin': return res.status(200).json(await listarVigenciasCobro(pool, body));
      case 'agregar_vigencia_cobro_admin': return res.status(200).json(await agregarVigenciaCobro(pool, body));
      case 'eliminar_vigencia_cobro_admin': return res.status(200).json(await eliminarVigenciaCobro(pool, body));
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
      case 'obtener_estadisticas_apps_admin': return res.status(200).json(await obtenerEstadisticasApps(pool));
      case 'listar_usuarios_jugadores_admin': return res.status(200).json(await listarUsuariosJugadoresAdmin(pool));
      case 'listar_usuarios_representantes_admin': return res.status(200).json(await listarUsuariosRepresentantesAdmin(pool));
      case 'listar_disciplinas_admin': return res.status(200).json(await listarDisciplinas(pool));
      case 'listar_disciplinas_activas_admin': return res.status(200).json(await listarDisciplinasActivas(pool));
      case 'crear_disciplina_admin': return res.status(200).json(await crearDisciplina(pool, body));
      case 'editar_disciplina_admin': return res.status(200).json(await editarDisciplina(pool, body));
      case 'toggle_disciplina_admin': return res.status(200).json(await toggleDisciplina(pool, body));
      case 'listar_tipos_estadistica_admin': return res.status(200).json(await listarTiposEstadistica(pool, body));
      case 'crear_tipo_estadistica_admin': return res.status(200).json(await crearTipoEstadistica(pool, body));
      case 'toggle_tipo_estadistica_admin': return res.status(200).json(await toggleTipoEstadistica(pool, body));
      case 'editar_puntos_tipo_estadistica_admin': return res.status(200).json(await editarPuntosTipoEstadistica(pool, body));
      case 'ver_estadisticas_partido_admin': return res.status(200).json(await verEstadisticasPartidoAdmin(pool, body));
      case 'guardar_estadisticas_partido_admin': return res.status(200).json(await guardarEstadisticasPartidoAdmin(pool, body));
      case 'ver_foto_partido_admin': return res.status(200).json(await verFotoPartidoAdmin(pool, body));
      case 'listar_grupos_admin': return res.status(200).json(await listarGrupos(pool));
      case 'crear_grupo_admin': return res.status(200).json(await crearGrupo(pool, body));
      case 'editar_grupo_admin': return res.status(200).json(await editarGrupo(pool, body));
      case 'toggle_grupo_admin': return res.status(200).json(await toggleGrupo(pool, body));
      case 'ver_detalle_grupo_admin': return res.status(200).json(await verDetalleGrupo(pool, body));
      case 'asignar_jugador_grupo_admin': return res.status(200).json(await asignarJugadorGrupo(pool, body));
      case 'asignar_entrenador_grupo_admin': return res.status(200).json(await asignarEntrenadorGrupo(pool, body));
      case 'quitar_entrenador_grupo_admin': return res.status(200).json(await quitarEntrenadorGrupo(pool, body));
      case 'listar_entrenadores_admin': return res.status(200).json(await listarEntrenadores(pool));
      case 'crear_entrenador_admin': return res.status(200).json(await crearEntrenador(pool, body));
      case 'editar_entrenador_admin': return res.status(200).json(await editarEntrenador(pool, body));
      case 'toggle_entrenador_admin': return res.status(200).json(await toggleEntrenador(pool, body));
      case 'resetear_clave_entrenador_admin': return res.status(200).json(await resetearClaveEntrenadorAdmin(pool, body));
      case 'listar_pantallas_menu_admin': return res.status(200).json(await listarPantallasMenu(pool));
      case 'toggle_pantalla_rol_admin': return res.status(200).json(await togglePantallaRol(pool, body));
      case 'toggle_activa_pantalla_admin': return res.status(200).json(await toggleActivaPantalla(pool, body));
      case 'listar_planilleros_admin': return res.status(200).json(await listarPlanilleros(pool));
      case 'crear_planillero_admin': return res.status(200).json(await crearPlanillero(pool, body));
      case 'editar_planillero_admin': return res.status(200).json(await editarPlanillero(pool, body));
      case 'toggle_planillero_admin': return res.status(200).json(await togglePlanillero(pool, body));
      case 'resetear_clave_planillero_admin': return res.status(200).json(await resetearClavePlanilleroAdmin(pool, body));
      case 'listar_financieros_admin': return res.status(200).json(await listarFinancieros(pool));
      case 'crear_financiero_admin': return res.status(200).json(await crearFinanciero(pool, body));
      case 'editar_financiero_admin': return res.status(200).json(await editarFinanciero(pool, body));
      case 'toggle_financiero_admin': return res.status(200).json(await toggleFinanciero(pool, body));
      case 'resetear_clave_financiero_admin': return res.status(200).json(await resetearClaveFinancieroAdmin(pool, body));
      case 'listar_lugares_admin': return res.status(200).json(await listarLugaresAdmin(pool));
      case 'listar_lugares_activos_admin': return res.status(200).json(await listarLugares(pool));
      case 'crear_lugar_admin': return res.status(200).json(await crearLugar(pool, body));
      case 'editar_lugar_admin': return res.status(200).json(await editarLugar(pool, body));
      case 'toggle_lugar_admin': return res.status(200).json(await toggleLugar(pool, body));
      case 'obtener_google_maps_api_key_admin': return res.status(200).json(await obtenerGoogleMapsApiKey(pool));
      case 'listar_rubros_club_admin': return res.status(200).json(await listarRubros(pool));
      case 'crear_rubro_club_admin': return res.status(200).json(await crearRubro(pool, body));
      case 'editar_rubro_club_admin': return res.status(200).json(await editarRubro(pool, body));
      case 'toggle_rubro_club_admin': return res.status(200).json(await toggleRubro(pool, body));
      case 'listar_movimientos_club_admin': return res.status(200).json(await listarMovimientosClub(pool, body));
      case 'registrar_movimiento_club_admin': return res.status(200).json(await registrarMovimientoClub(pool, body));
      case 'eliminar_movimiento_club_admin': return res.status(200).json(await eliminarMovimientoClub(pool, body));
      case 'ver_mensualidad_jugador_admin': return res.status(200).json(await verMensualidadJugadorAdmin(pool, body));
      case 'dashboard_morosos_mensualidad_admin': return res.status(200).json(await dashboardMorososMensualidad(pool));
      case 'crear_horario_grupo_admin': return res.status(200).json(await crearHorarioGrupo(pool, body));
      case 'eliminar_horario_grupo_admin': return res.status(200).json(await eliminarHorarioGrupo(pool, body));
      case 'listar_representantes_jugador_admin': return res.status(200).json(await listarRepresentantesJugadorAdmin(pool, body));
      case 'agregar_representante_admin': return res.status(200).json(await agregarRepresentanteAdmin(pool, body));
      case 'editar_representante_admin': return res.status(200).json(await editarRepresentanteAdmin(pool, body));
      case 'eliminar_representante_admin': return res.status(200).json(await eliminarRepresentanteAdmin(pool, body));
      case 'resetear_clave_representante_admin': return res.status(200).json(await resetearClaveRepresentanteAdmin(pool, body));
      case 'ver_pendientes_jugador_app': return res.status(200).json(await verPendientesJugador(pool, body));
      case 'marcar_multa_pagada_app': return res.status(200).json(await marcarMultaPagada(pool, body));
      case 'toggle_eventos_jugador_app': return res.status(200).json(await toggleEventosJugador(pool, body));
      case 'toggle_representantes_app': return res.status(200).json(await toggleRepresentantesClub(pool, body));
      case 'toggle_mis_exentos_jugador_app': return res.status(200).json(await toggleMisExentosJugador(pool, body));
      case 'toggle_mi_cuenta_jugador_app': return res.status(200).json(await toggleMiCuentaJugador(pool, body));
      case 'toggle_movimientos_solo_propios_app': return res.status(200).json(await toggleMovimientosSoloPropios(pool, body));
      case 'listar_permisos_pantallas_admin': return res.status(200).json(await listarPermisosPantallas(pool));
      case 'toggle_permiso_pantalla_admin': return res.status(200).json(await togglePermisoPantalla(pool, body));
      case 'actualizar_logo_club_app': return res.status(200).json(await actualizarLogoClub(pool, body));
      case 'crear_evento_app': return res.status(200).json(await crearEvento(pool, body));
      case 'editar_evento_app': return res.status(200).json(await editarEvento(pool, body));
      case 'listar_eventos_app': return res.status(200).json(await listarEventos(pool));
      case 'ver_detalle_evento_app': return res.status(200).json(await verDetalleEvento(pool, body));
      case 'crear_evento_fecha_app': return res.status(200).json(await crearEventoFecha(pool, body));
      case 'editar_evento_fecha_app': return res.status(200).json(await editarEventoFecha(pool, body));
      case 'eliminar_evento_fecha_app': return res.status(200).json(await eliminarEventoFecha(pool, body));
      case 'eliminar_presupuesto_item_app': return res.status(200).json(await eliminarPresupuestoItem(pool, body));
      case 'guardar_presupuesto_item_app': return res.status(200).json(await guardarPresupuestoItem(pool, body));
      case 'asignar_cuota_jugador_app': return res.status(200).json(await asignarCuotaJugador(pool, body));
      case 'aplicar_cuota_todos_app': return res.status(200).json(await aplicarCuotaATodos(pool, body));
      case 'quitar_cuota_jugador_app': return res.status(200).json(await quitarCuotaJugador(pool, body));
      case 'registrar_movimiento_evento_app': return res.status(200).json(await registrarMovimientoEvento(pool, body));
      case 'editar_movimiento_evento_app': return res.status(200).json(await editarMovimientoEvento(pool, body));
      case 'eliminar_movimiento_evento_app': return res.status(200).json(await eliminarMovimientoEvento(pool, body));
      case 'ver_comprobante_movimiento_app': return res.status(200).json(await verComprobanteMovimiento(pool, body));
      case 'listar_informe_consolidado_eventos_app': return res.status(200).json(await listarInformeConsolidadoEventos(pool));
      case 'listar_eventos_selector_app': return res.status(200).json(await listarEventosSelector(pool));
      case 'listar_fechas_evento_selector_app': return res.status(200).json(await listarFechasEventoSelector(pool, body));
      case 'ver_vinculo_evento_partido_app': return res.status(200).json(await verVinculoEventoPartido(pool, body));
      case 'vincular_partido_evento_app': return res.status(200).json(await vincularPartidoEvento(pool, body));
      case 'listar_tipos_movimiento_evento_app': return res.status(200).json(await listarTiposMovimientoEvento(pool));
      case 'crear_tipo_movimiento_evento_app': return res.status(200).json(await crearTipoMovimientoEvento(pool, body));
      case 'toggle_tipo_movimiento_evento_app': return res.status(200).json(await toggleTipoMovimientoEvento(pool, body));
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
