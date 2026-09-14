// api/jugador.js
// TODAS las acciones del jugador viven en ESTE UNICO archivo (una sola
// funcion serverless), a proposito. El plan Hobby de Vercel permite un
// maximo de 12 funciones serverless por despliegue -- si cada accion
// fuera su propio archivo (como se hizo al principio), se superaba ese
// limite facilmente. Aqui, igual que en el router de n8n, se lee el
// campo 'accion' del body y se despacha internamente.
//
// Variables de entorno necesarias en Vercel (Settings -> Environment Variables):
//   DATABASE_URL            - conexion a Postgres (la misma que usa n8n)
//   OPENAI_API_KEY           - para el analisis de comprobantes con IA
//   ONESIGNAL_REST_API_KEY   - para el push de saldo a favor

const { getPool } = require('./_db');
const { verFotoPartidoAdmin } = require('./_admin_partido_estadisticas');

// ============================================================
// Helper: normaliza y valida el telefono (0983309625 -> 593983309625)
// ============================================================
function normalizarTelefono(raw) {
  const soloDigitos = String(raw || '').replace(/\D/g, '');
  if (soloDigitos.length === 10 && soloDigitos.startsWith('0')) {
    return { valido: true, telefono: '593' + soloDigitos.substring(1) };
  }
  if (soloDigitos.length === 12 && soloDigitos.startsWith('593')) {
    return { valido: true, telefono: soloDigitos };
  }
  return { valido: false, error: 'El numero debe tener 10 digitos, solo numeros, sin espacios ni letras. Ejemplo: 0983309625' };
}

// ============================================================
// Helper: resuelve el jugador_id a partir del token de sesion
// ============================================================
async function resolverSesion(pool, token) {
  const r = await pool.query(
    `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
    [token || '']
  );
  return r.rows[0] && r.rows[0].jugador_id;
}

// ============================================================
// Helper: avisa al grupo de WhatsApp con la lista actualizada
// (best-effort, nunca bloquea la accion principal)
// ============================================================
async function avisarGrupo(pool, partidoId) {
  try {
    const info = await pool.query(
      `SELECT p.alias, p.fecha, p.hora, p.lugar, p.estado,
              sport_control.lista_confirmados_partido(p.id) AS lista,
              (SELECT grupo_jid FROM sport_control.configuracion_club WHERE id = 1) AS grupo_jid,
              (SELECT instance_evolutionapi FROM sport_control.configuracion_club WHERE id = 1) AS instance_evolutionapi,
              (SELECT evolution_api_base_url FROM sport_control.configuracion_club WHERE id = 1) AS evolution_api_base_url
       FROM sport_control.partidos p WHERE p.id = $1`,
      [partidoId]
    );
    const p = info.rows[0];
    if (!p || !p.grupo_jid || !p.instance_evolutionapi || !p.evolution_api_base_url) return;

    const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const d = new Date(p.fecha);
    const fechaCorta = dias[d.getUTCDay()] + ' ' + String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
    const titulo = p.alias || 'Partido';
    const lista = p.lista || [];
    const lineas = lista.map((item, i) => item.tipo === 'invitado' ? `${i + 1}. 🎟️ ${item.nombre} (invitado de ${item.anfitrion})` : `${i + 1}. ${item.nombre}`);
    const texto = '⚽ *' + titulo + '* (' + p.estado + ')\n📅 ' + fechaCorta + '  🕐 ' + (p.hora || '') + '\n📍 ' + (p.lugar || '') + '\n\nConfirmados (' + lista.length + '):\n\n' + (lineas.length > 0 ? lineas.join('\n') : 'Nadie confirmado todavía.');

    await fetch(`${p.evolution_api_base_url}/message/sendText/${p.instance_evolutionapi}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: p.grupo_jid, text: texto }),
    });
  } catch (e) {
    console.error('Aviso al grupo fallo (no bloquea la accion principal):', e);
  }
}

// ============================================================
// Helper: push de OneSignal cuando se guarda saldo a favor
// ============================================================
async function enviarPushSaldoFavor(pool, jugadorId, monto) {
  try {
    const cfg = await pool.query(`SELECT onesignal_app_id, sitio_url_jugador FROM sport_control.configuracion_club WHERE id = 1`);
    const c = cfg.rows[0];
    if (!c || !c.onesignal_app_id) return;
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic Key ${process.env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: c.onesignal_app_id,
        include_aliases: { external_id: [String(jugadorId)] },
        target_channel: 'push',
        headings: { en: '💰 Tienes saldo sin distribuir' },
        contents: { en: `Guardamos $${Number(monto).toFixed(2)} como saldo a favor. Toca para asignarlo a una deuda.` },
        url: c.sitio_url_jugador || '',
      }),
    });
  } catch (e) {
    console.error('Push de saldo a favor fallo (no bloquea el guardado):', e);
  }
}

async function enviarPushAdmin(pool, titulo, mensaje) {
  try {
    const cfg = await pool.query(`SELECT onesignal_app_id, sitio_url_admin FROM sport_control.configuracion_club WHERE id = 1`);
    const c = cfg.rows[0];
    if (!c || !c.onesignal_app_id) return;
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic Key ${process.env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: c.onesignal_app_id,
        include_aliases: { external_id: ['admin_club'] },
        target_channel: 'push',
        headings: { en: titulo },
        contents: { en: mensaje },
        url: c.sitio_url_admin || '',
      }),
    });
  } catch (e) {
    console.error('Push al admin fallo (no bloquea la accion principal):', e);
  }
}

// ============================================================
// Handlers por accion
// ============================================================

async function crearSesion(pool, jugadorId) {
  const r = await pool.query(
    `INSERT INTO sport_control.sesiones_pwa (jugador_id, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
    [jugadorId]
  );
  return r.rows[0].token;
}

async function loginJugador(pool, body) {
  const inputRaw = String(body.telefono || '').trim();

  // 1. Intento por cedula: coincidencia EXACTA, sin transformar nada.
  // Se prueba primero porque cedula y telefono local pueden tener el
  // mismo largo (10 digitos) en Ecuador -- no hay forma segura de
  // "adivinar" cual es cual por longitud/prefijo, asi que se revisa
  // en un orden fijo y sin ambiguedad.
  if (inputRaw) {
    const porCedula = await pool.query(
      `SELECT id FROM sport_control.jugadores WHERE cedula = $1 AND estado = 'activo' LIMIT 1`,
      [inputRaw]
    );
    if (porCedula.rows[0]) {
      const token = await crearSesion(pool, porCedula.rows[0].id);
      return { success: true, data: { registrado: true, token } };
    }
  }

  // 2. Si no hubo coincidencia por cedula, se intenta como telefono
  // (con la misma normalizacion de siempre).
  const norm = normalizarTelefono(inputRaw);
  if (!norm.valido) return { success: false, error: norm.error };
  const r = await pool.query(
    `SELECT id FROM sport_control.jugadores WHERE telefono = $1 AND estado = 'activo' LIMIT 1`,
    [norm.telefono]
  );
  if (r.rows[0]) {
    const token = await crearSesion(pool, r.rows[0].id);
    return { success: true, data: { registrado: true, token } };
  }
  return { success: true, data: { registrado: false } };
}

async function registrarJugadorPwa(pool, body) {
  const norm = normalizarTelefono(body.telefono);
  if (!norm.valido) return { success: false, error: norm.error };
  const r = await pool.query(
    `WITH nuevo AS (INSERT INTO sport_control.jugadores (nombres, apellidos, cedula, correo, telefono, estado, creado_en) VALUES ($1, $2, $3, $4, $5, 'activo', NOW()) RETURNING id),
     sesion AS (INSERT INTO sport_control.sesiones_pwa (jugador_id, token) SELECT id, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico() FROM nuevo RETURNING jugador_id, token)
     SELECT jugador_id, token FROM sesion`,
    [body.nombres, body.apellidos, body.cedula, body.correo, norm.telefono]
  );
  const row = r.rows[0];
  return { success: true, data: { jugadorId: row.jugador_id, token: row.token } };
}

async function obtenerMiPerfil(pool, jugadorId) {
  const r = await pool.query(
    `SELECT j.id AS jugador_id, j.nombres, j.apellidos, j.telefono, j.cedula, j.correo,
            (SELECT eventos_habilitado_jugador FROM sport_control.configuracion_club WHERE id = 1) AS eventos_habilitado,
            (SELECT whatsapp_checkin_numero FROM sport_control.configuracion_club WHERE id = 1) AS whatsapp_checkin_numero,
            (SELECT representantes_habilitado FROM sport_control.configuracion_club WHERE id = 1) AS representantes_habilitado,
            (SELECT mis_exentos_habilitado_jugador FROM sport_control.configuracion_club WHERE id = 1) AS mis_exentos_habilitado,
            (SELECT COALESCE((SELECT habilitado FROM sport_control.permisos_pantallas WHERE funcionalidad = 'mi_cuenta' AND rol = 'jugador'), true)) AS mi_cuenta_habilitado,
            (SELECT COALESCE((SELECT habilitado FROM sport_control.permisos_pantallas WHERE funcionalidad = 'partidos' AND rol = 'jugador'), true)) AS partidos_habilitado
     FROM sport_control.jugadores j WHERE j.id = $1`,
    [jugadorId]
  );
  const row = r.rows[0];
  return { success: true, data: { jugadorId: row.jugador_id, nombres: row.nombres, apellidos: row.apellidos, telefono: row.telefono, cedula: row.cedula, correo: row.correo, eventosHabilitado: row.eventos_habilitado, whatsappCheckinNumero: row.whatsapp_checkin_numero, representantesHabilitado: row.representantes_habilitado, misExentosHabilitado: row.mis_exentos_habilitado, miCuentaHabilitado: row.mi_cuenta_habilitado, partidosHabilitado: row.partidos_habilitado } };
}

async function listarMisRepresentantes(pool, jugadorId) {
  const r = await pool.query(
    `SELECT jr.id, r.nombres, r.apellidos, r.telefono, r.cedula, jr.descripcion
     FROM sport_control.jugador_representante jr
     JOIN sport_control.representantes r ON r.id = jr.representante_id
     WHERE jr.jugador_id = $1 ORDER BY jr.creado_en ASC`,
    [jugadorId]
  );
  return { success: true, data: r.rows };
}

async function agregarRepresentante(pool, jugadorId, body) {
  const { nombres, apellidos, telefono, cedula, descripcion } = body;
  if (!nombres || !apellidos) return { success: false, error: 'Completa nombres y apellidos.' };
  if (!cedula || !cedula.trim()) return { success: false, error: 'La cédula es obligatoria (la necesitará para poder ingresar a su propia app más adelante).' };

  // Si ya existe una persona con esa cedula (porque representa a otro
  // jugador tambien), se reutiliza -- nunca se duplica a la misma persona.
  let representanteId;
  const existente = await pool.query(`SELECT id FROM sport_control.representantes WHERE cedula = $1`, [cedula.trim()]);
  if (existente.rows[0]) {
    representanteId = existente.rows[0].id;
  } else {
    const nuevo = await pool.query(
      `INSERT INTO sport_control.representantes (cedula, nombres, apellidos, telefono, creado_en) VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [cedula.trim(), nombres, apellidos, telefono || null]
    );
    representanteId = nuevo.rows[0].id;
  }

  const yaVinculado = await pool.query(
    `SELECT id FROM sport_control.jugador_representante WHERE jugador_id = $1 AND representante_id = $2`,
    [jugadorId, representanteId]
  );
  if (yaVinculado.rows[0]) return { success: false, error: 'Esa persona ya está registrada como tu representante.' };

  const link = await pool.query(
    `INSERT INTO sport_control.jugador_representante (jugador_id, representante_id, descripcion, creado_en) VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [jugadorId, representanteId, descripcion || null]
  );
  return { success: true, data: { id: link.rows[0].id } };
}

async function editarRepresentante(pool, jugadorId, body) {
  const { representanteId: linkId, nombres, apellidos, telefono, cedula, descripcion } = body;
  const check = await pool.query(
    `SELECT jr.id, jr.representante_id FROM sport_control.jugador_representante jr WHERE jr.id = $1 AND jr.jugador_id = $2`,
    [linkId, jugadorId]
  );
  if (!check.rows[0]) return { success: false, error: 'No se encontró ese representante.' };

  try {
    await pool.query(
      `UPDATE sport_control.representantes SET nombres = $1, apellidos = $2, telefono = $3, cedula = $4 WHERE id = $5`,
      [nombres, apellidos, telefono || null, cedula || null, check.rows[0].representante_id]
    );
  } catch (err) {
    if (err.code === '23505') return { success: false, error: 'Esa cédula ya está registrada para otro representante.' };
    throw err;
  }
  await pool.query(`UPDATE sport_control.jugador_representante SET descripcion = $1 WHERE id = $2`, [descripcion || null, linkId]);
  return { success: true };
}

async function eliminarRepresentante(pool, jugadorId, body) {
  const { representanteId: linkId } = body;
  const check = await pool.query(
    `SELECT jr.id, jr.representante_id FROM sport_control.jugador_representante jr WHERE jr.id = $1 AND jr.jugador_id = $2`,
    [linkId, jugadorId]
  );
  if (!check.rows[0]) return { success: false, error: 'No se encontró ese representante.' };
  await pool.query(`DELETE FROM sport_control.jugador_representante WHERE id = $1`, [linkId]);
  // Si esa persona no quedo vinculada a ningun otro jugador, se limpia el
  // registro huerfano (no afecta a nadie mas, ya no representa a nadie).
  await pool.query(
    `DELETE FROM sport_control.representantes WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sport_control.jugador_representante WHERE representante_id = $1)`,
    [check.rows[0].representante_id]
  );
  return { success: true };
}

async function verMisPartidos(pool, jugadorId) {
  const r = await pool.query(
    `SELECT p.id, p.alias, p.fecha, p.hora, p.lugar, p.estado,
            COALESCE(cp.estado, 'sin_confirmar') AS "miEstado",
            (SELECT COUNT(*) FROM sport_control.invitados_asistencia ia WHERE ia.partido_id = p.id AND ia.jugador_anfitrion_id = $1 AND ia.estado = 'confirmado') AS "cantidadInvitados",
            d.icono AS "disciplinaIcono",
            (p.marcador_propio IS NOT NULL OR EXISTS(SELECT 1 FROM sport_control.partido_estadisticas pe WHERE pe.partido_id = p.id)) AS "tieneEstadisticas"
     FROM sport_control.partidos p
     LEFT JOIN sport_control.confirmaciones_partido cp ON cp.partido_id = p.id AND cp.jugador_id = $1
     LEFT JOIN sport_control.disciplinas d ON d.id = p.disciplina_id
     WHERE p.estado IN ('confirmando', 'cerrado', 'en_juego', 'finalizado')
     ORDER BY (p.estado = 'finalizado') ASC,
              CASE WHEN p.estado != 'finalizado' THEN p.fecha END ASC,
              CASE WHEN p.estado = 'finalizado' THEN p.fecha END DESC
     LIMIT 30`,
    [jugadorId]
  );
  const data = r.rows.map((p) => ({ ...p, cantidadInvitados: Number(p.cantidadInvitados) }));
  return { success: true, data };
}

async function verDetallePartidoStatsJugador(pool, body) {
  const { partidoId } = body;
  const partidoR = await pool.query(
    `SELECT p.id, p.alias, p.fecha, p.rival_nombre, p.marcador_propio, p.marcador_rival, p.notas,
            (p.foto_equipo_base64 IS NOT NULL) AS "tieneFotoEquipo",
            (p.foto_planilla_base64 IS NOT NULL) AS "tieneFotoPlanilla",
            d.nombre AS "disciplinaNombre", d.icono AS "disciplinaIcono",
            (jd.nombres || ' ' || jd.apellidos) AS "jugadorDestacado",
            e.nombre AS "eventoNombre"
     FROM sport_control.partidos p
     LEFT JOIN sport_control.disciplinas d ON d.id = p.disciplina_id
     LEFT JOIN sport_control.jugadores jd ON jd.id = p.jugador_destacado_id
     LEFT JOIN sport_control.eventos e ON e.id = p.evento_id
     WHERE p.id = $1`,
    [partidoId]
  );
  const partido = partidoR.rows[0];
  if (!partido) return { success: false, error: 'Partido no encontrado.' };

  const valores = await pool.query(
    `SELECT te.nombre, te.nivel, pe.valor, j.nombres || ' ' || j.apellidos AS jugador
     FROM sport_control.partido_estadisticas pe
     JOIN sport_control.tipos_estadistica te ON te.id = pe.tipo_estadistica_id
     LEFT JOIN sport_control.jugadores j ON j.id = pe.jugador_id
     WHERE pe.partido_id = $1 AND pe.valor != 0
     ORDER BY te.orden, j.nombres`,
    [partidoId]
  );

  return { success: true, data: { partido, valores: valores.rows } };
}

async function verPendientesPago(pool, jugadorId) {
  const r = await pool.query(
    `SELECT sport_control.pendientes_jugador($1) AS pendientes,
            COALESCE((SELECT SUM(monto) FROM sport_control.saldo_a_favor WHERE jugador_id = $1 AND usado = false), 0) AS saldo_a_favor`,
    [jugadorId]
  );
  const row = r.rows[0];
  const pendientes = row.pendientes;

  // Cuotas de eventos pendientes -- se calculan aparte (tabla independiente,
  // evento_cuota_jugador/evento_movimientos, nada que ver con pendientes_jugador())
  // y se agregan al mismo objeto para que la pantalla de deuda las muestre juntas.
  const eventosCuota = await pool.query(
    `SELECT e.id AS "eventoId", e.nombre AS "eventoNombre", ec.monto_cuota AS "montoCuota",
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m WHERE m.evento_id = e.id AND m.jugador_id = $1), 0) AS "montoPagado"
     FROM sport_control.evento_cuota_jugador ec
     JOIN sport_control.eventos e ON e.id = ec.evento_id
     WHERE ec.jugador_id = $1 AND e.estado != 'cancelado'`,
    [jugadorId]
  );
  pendientes.eventos_pendientes = eventosCuota.rows
    .map(e => ({ eventoId: e.eventoId, eventoNombre: e.eventoNombre, montoCuota: Number(e.montoCuota), montoPagado: Number(e.montoPagado), pendiente: Math.max(Number(e.montoCuota) - Number(e.montoPagado), 0) }))
    .filter(e => e.pendiente > 0.009);

  return { success: true, data: { pendientes, saldoAFavor: Number(row.saldo_a_favor) } };
}

async function verMiQr(pool, jugadorId, partidoId) {
  const r = await pool.query(
    `SELECT token FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND jugador_id = $2 AND invitado_asistencia_id IS NULL LIMIT 1`,
    [partidoId, jugadorId]
  );
  return { success: true, data: { token: r.rows[0] ? r.rows[0].token : null } };
}

async function actualizarMisDatos(pool, jugadorId, body) {
  await pool.query(
    `UPDATE sport_control.jugadores SET nombres = $1, apellidos = $2, cedula = $3, correo = $4 WHERE id = $5`,
    [body.nombres, body.apellidos, body.cedula, body.correo, jugadorId]
  );
  return { success: true, data: true };
}

async function confirmarMiPartido(pool, jugadorId, body) {
  const { partidoId } = body;
  await pool.query(
    `INSERT INTO sport_control.confirmaciones_partido (partido_id, jugador_id, estado, timestamp_confirmacion, cantidad_invitados)
     VALUES ($1, $2, 'confirmado', NOW(), COALESCE((SELECT cantidad_invitados FROM sport_control.confirmaciones_partido WHERE partido_id = $1 AND jugador_id = $2), 0))
     ON CONFLICT (partido_id, jugador_id) DO UPDATE SET estado = 'confirmado', timestamp_confirmacion = NOW()`,
    [partidoId, jugadorId]
  );
  await pool.query(`DELETE FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND jugador_id = $2 AND invitado_asistencia_id IS NULL`, [partidoId, jugadorId]);
  const tokenRow = await pool.query(`SELECT sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico() AS token`);
  const nuevoToken = tokenRow.rows[0].token;
  await pool.query(`INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, token) VALUES ($1, $2, $3)`, [partidoId, jugadorId, nuevoToken]);
  await avisarGrupo(pool, partidoId);
  return { success: true, data: { token: nuevoToken } };
}

async function cancelarMiPartido(pool, jugadorId, body) {
  const { partidoId } = body;
  await pool.query(`UPDATE sport_control.confirmaciones_partido SET estado = 'cancelado', timestamp_cancelacion = NOW() WHERE partido_id = $1 AND jugador_id = $2`, [partidoId, jugadorId]);
  await pool.query(`DELETE FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND jugador_id = $2 AND invitado_asistencia_id IS NULL`, [partidoId, jugadorId]);
  await avisarGrupo(pool, partidoId);
  return { success: true, data: true };
}

async function verDocumento(pool, body) {
  const r = await pool.query(`SELECT filename, contenido_base64 FROM sport_control.documentos_club WHERE slug = $1 LIMIT 1`, [body.slug]);
  const row = r.rows[0] || {};
  return { success: true, data: { filename: row.filename || null, contenido_base64: row.contenido_base64 || null } };
}

async function marcarPushHabilitado(pool, jugadorId) {
  await pool.query(`UPDATE sport_control.jugadores SET push_habilitado = true WHERE id = $1`, [jugadorId]);
  return { success: true, data: true };
}

async function verMisUltimosPagos(pool, jugadorId) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(t.*), '[]'::json) AS pagos FROM (
       SELECT * FROM (
         SELECT pg.creado_en AS fecha, pg.monto,
           CASE WHEN cc.tipo = 'mensualidad' THEN 'Mensualidad'
                WHEN cc.tipo = 'invitado' THEN 'Invitado' || (CASE WHEN pg.cantidad_invitados > 1 THEN ' (x' || pg.cantidad_invitados || ')' ELSE '' END)
                WHEN pg.partido_id IS NOT NULL THEN 'Partido especial' || (CASE WHEN p.alias IS NOT NULL THEN ': ' || p.alias ELSE '' END)
                ELSE 'Pago' END AS motivo
         FROM sport_control.pagos pg
         LEFT JOIN sport_control.catalogo_cobros cc ON cc.id = pg.tipo_cobro_id
         LEFT JOIN sport_control.partidos p ON p.id = pg.partido_id
         WHERE pg.jugador_id = $1 AND pg.estado = 'confirmado'
         UNION ALL
         SELECT COALESCE(m.pagada_en, m.aprobada_en) AS fecha, m.monto, 'Multa: ' || tm.nombre AS motivo
         FROM sport_control.multas m JOIN sport_control.tipos_multa tm ON tm.id = m.tipo_multa_id
         WHERE m.jugador_id = $1 AND m.pagada = true
         UNION ALL
         SELECT em.creado_en AS fecha, em.monto, 'Cuota evento: ' || e.nombre AS motivo
         FROM sport_control.evento_movimientos em
         JOIN sport_control.eventos e ON e.id = em.evento_id
         JOIN sport_control.tipos_movimiento_evento t ON t.id = em.tipo_movimiento_id
         WHERE em.jugador_id = $1 AND t.tipo = 'ingreso'
       ) sub ORDER BY fecha DESC LIMIT 8
     ) t`,
    [jugadorId]
  );
  return { success: true, data: r.rows[0].pagos };
}

async function verMisInvitados(pool, jugadorId, body) {
  const r = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('id', ia.id, 'nombre', ia.nombre, 'token', ca.token, 'exento', ia.exento_id IS NOT NULL) ORDER BY ia.id), '[]'::json) AS invitados
     FROM sport_control.invitados_asistencia ia LEFT JOIN sport_control.codigos_asistencia ca ON ca.invitado_asistencia_id = ia.id
     WHERE ia.partido_id = $1 AND ia.jugador_anfitrion_id = $2 AND ia.estado = 'confirmado'`,
    [body.partidoId, jugadorId]
  );
  return { success: true, data: r.rows[0].invitados };
}

async function agregarInvitado(pool, jugadorId, body) {
  const { partidoId, exentoId } = body;
  let nombre = body.nombre;
  let exentoIdFinal = null;

  if (exentoId) {
    const ex = await pool.query(
      `SELECT id, nombres, apellidos FROM sport_control.jugador_exentos WHERE id = $1 AND jugador_id = $2 AND estado = 'aprobado'`,
      [exentoId, jugadorId]
    );
    if (!ex.rows[0]) return { success: false, error: 'Ese exento no existe o todavía no está aprobado por el club.' };
    nombre = ex.rows[0].nombres + ' ' + ex.rows[0].apellidos;
    exentoIdFinal = exentoId;
  }

  if (!nombre || !nombre.trim()) return { success: false, error: 'Falta el nombre del invitado.' };

  const nuevo = await pool.query(
    `INSERT INTO sport_control.invitados_asistencia (partido_id, jugador_anfitrion_id, nombre, estado, creado_en, exento_id) VALUES ($1, $2, $3, 'confirmado', NOW(), $4) RETURNING id`,
    [partidoId, jugadorId, nombre, exentoIdFinal]
  );
  const invitadoId = nuevo.rows[0].id;
  const codigo = await pool.query(
    `INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, invitado_asistencia_id, token) VALUES ($1, $2, $3, sport_control.generar_token_alfanumerico()) RETURNING token`,
    [partidoId, jugadorId, invitadoId]
  );
  await avisarGrupo(pool, partidoId);
  return { success: true, data: { id: invitadoId, token: codigo.rows[0].token } };
}

async function listarTiposRelacionExento(pool) {
  const r = await pool.query(`SELECT id, nombre FROM sport_control.tipos_relacion_exento WHERE activo = true ORDER BY nombre`);
  return { success: true, data: r.rows };
}

async function listarMisExentos(pool, jugadorId) {
  const r = await pool.query(
    `SELECT je.id, je.nombres, je.apellidos, je.estado, tr.nombre AS relacion
     FROM sport_control.jugador_exentos je
     JOIN sport_control.tipos_relacion_exento tr ON tr.id = je.tipo_relacion_id
     WHERE je.jugador_id = $1 AND je.estado != 'revocado' ORDER BY je.creado_en DESC`,
    [jugadorId]
  );
  return { success: true, data: r.rows };
}

async function agregarExento(pool, jugadorId, body) {
  const { nombres, apellidos, tipoRelacionId } = body;
  if (!nombres || !apellidos || !tipoRelacionId) return { success: false, error: 'Completa nombres, apellidos y el tipo de relación.' };
  const r = await pool.query(
    `INSERT INTO sport_control.jugador_exentos (jugador_id, nombres, apellidos, tipo_relacion_id, estado, creado_en)
     VALUES ($1, $2, $3, $4, 'pendiente_aprobacion', NOW()) RETURNING id`,
    [jugadorId, nombres, apellidos, tipoRelacionId]
  );

  const j = await pool.query(`SELECT nombres, apellidos FROM sport_control.jugadores WHERE id = $1`, [jugadorId]);
  const nombreJugador = j.rows[0] ? (j.rows[0].nombres + ' ' + j.rows[0].apellidos) : 'Un jugador';
  await enviarPushAdmin(pool, '👨‍👩‍👧 Nuevo exento por aprobar', `${nombreJugador} registró a ${nombres} ${apellidos} como exento. Revísalo en Parámetros.`);

  return { success: true, data: { id: r.rows[0].id } };
}

async function eliminarExento(pool, jugadorId, body) {
  const { exentoId } = body;
  const check = await pool.query(`SELECT id FROM sport_control.jugador_exentos WHERE id = $1 AND jugador_id = $2`, [exentoId, jugadorId]);
  if (!check.rows[0]) return { success: false, error: 'No se encontró ese registro.' };

  try {
    // Intento 1: borrado completo (solo funciona si nunca se uso en ningun partido)
    await pool.query(`DELETE FROM sport_control.jugador_exentos WHERE id = $1`, [exentoId]);
    return { success: true, data: { eliminadoCompleto: true } };
  } catch (err) {
    if (err.code === '23503') {
      // Ya fue usado como invitado en algun partido -- no se puede borrar sin
      // perder ese historial. Se marca como eliminado (deja de ser seleccionable).
      await pool.query(`UPDATE sport_control.jugador_exentos SET estado = 'revocado', revisado_en = NOW() WHERE id = $1`, [exentoId]);
      return { success: true, data: { eliminadoCompleto: false } };
    }
    throw err;
  }
}

async function quitarInvitado(pool, jugadorId, body) {
  const { invitadoId } = body;
  const result = await pool.query(
    `WITH invitado_info AS (SELECT ia.id, ia.partido_id, p.estado AS partido_estado FROM sport_control.invitados_asistencia ia JOIN sport_control.partidos p ON p.id = ia.partido_id WHERE ia.id = $1 AND ia.jugador_anfitrion_id = $2),
     borrar_codigos AS (DELETE FROM sport_control.codigos_asistencia WHERE invitado_asistencia_id = (SELECT id FROM invitado_info) AND usado = false RETURNING id),
     hard_delete AS (DELETE FROM sport_control.invitados_asistencia WHERE id IN (SELECT id FROM invitado_info WHERE partido_estado = 'confirmando') RETURNING id, partido_id),
     soft_cancel AS (UPDATE sport_control.invitados_asistencia SET estado = 'cancelado' WHERE id IN (SELECT id FROM invitado_info WHERE partido_estado != 'confirmando') RETURNING id, partido_id)
     SELECT COALESCE((SELECT partido_id FROM hard_delete LIMIT 1), (SELECT partido_id FROM soft_cancel LIMIT 1)) AS partido_id FROM (SELECT 1 AS ancla) d`,
    [invitadoId, jugadorId]
  );
  const partidoId = result.rows[0] && result.rows[0].partido_id;
  if (partidoId) await avisarGrupo(pool, partidoId);
  return { success: true, data: true };
}

async function analizarComprobante(pool, body) {
  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'Eres un asistente que extrae datos de comprobantes de pago bancarios (transferencias) de Ecuador. Devuelve SOLO un JSON con las claves: esComprobante (boolean), numeroComprobante (string), monto (number), banco (string), fechaComprobante (string formato YYYY-MM-DD), titular (string), confianza (number 0-1). Si la imagen no es un comprobante de pago, esComprobante debe ser false.' },
        { role: 'user', content: [{ type: 'text', text: 'Extrae los datos de este comprobante de pago.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${body.imagenBase64}` } }] },
      ],
    }),
  });
  const openaiJson = await openaiRes.json();
  let datos = { esComprobante: false };
  try { datos = JSON.parse(openaiJson.choices[0].message.content); } catch (e) { datos = { esComprobante: false }; }
  const numeroComprobante = datos.numeroComprobante || '';
  const dup = await pool.query(`SELECT COUNT(*) AS existe FROM sport_control.pagos WHERE numero_comprobante = $1`, [numeroComprobante]);
  return {
    success: true,
    data: {
      esComprobante: datos.esComprobante === true,
      numeroComprobante,
      monto: datos.monto || 0,
      banco: datos.banco || '',
      fechaComprobante: datos.fechaComprobante || '',
      duplicado: Number(dup.rows[0].existe) > 0,
    },
  };
}

async function registrarPagoComprobante(pool, jugadorId, body) {
  const { monto, banco, numeroComprobante, fecha } = body;
  const result = await pool.query(
    `INSERT INTO sport_control.pagos (jugador_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, creado_en) VALUES ($1, $2, $3, $4, $5::date, 'transferencia', 'confirmado', NOW()) RETURNING id`,
    [jugadorId, monto, numeroComprobante, banco, fecha]
  );

  const j = await pool.query(`SELECT nombres, apellidos FROM sport_control.jugadores WHERE id = $1`, [jugadorId]);
  const nombreJugador = j.rows[0] ? (j.rows[0].nombres + ' ' + j.rows[0].apellidos) : 'Un jugador';
  await enviarPushAdmin(pool, '💵 Nuevo pago registrado', `${nombreJugador} registró un pago de $${Number(monto).toFixed(2)}.`);

  return { success: true, data: { pagoId: result.rows[0].id, monto } };
}

async function aplicarPago(pool, jugadorId, body) {
  const { tipoConcepto, monto, origenSaldoFavor, pagoId: pagoIdBody, conceptoMonto } = body;
  let pagoId = pagoIdBody;
  let montoFinal = monto;

  if (origenSaldoFavor) {
    const r = await pool.query(
      `WITH usado AS (SELECT sport_control.usar_saldo_favor($1, $2) AS monto_usado),
       nuevo_pago AS (INSERT INTO sport_control.pagos (jugador_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, creado_en)
         SELECT $1, monto_usado, 'SALDOFAVOR-' || $1 || '-' || extract(epoch from now())::bigint, 'Saldo a favor', CURRENT_DATE, 'saldo_a_favor', 'confirmado', NOW() FROM usado WHERE monto_usado > 0 RETURNING id, monto)
       SELECT np.id AS pago_id, np.monto AS monto_final FROM (SELECT 1 AS ancla) d LEFT JOIN nuevo_pago np ON true`,
      [jugadorId, monto]
    );
    pagoId = r.rows[0].pago_id;
    montoFinal = r.rows[0].monto_final;
  }

  let resultado;
  if (tipoConcepto === 'mensualidad') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_mensualidad($1, $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal])).rows[0].resultado;
  } else if (tipoConcepto === 'invitado') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_invitados($1, $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal])).rows[0].resultado;
  } else if (tipoConcepto === 'multas_propias') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'propia', $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal])).rows[0].resultado;
  } else if (tipoConcepto === 'multas_invitados') {
    resultado = (await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'invitado', $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal])).rows[0].resultado;
  } else if (tipoConcepto === 'partido_especial') {
    resultado = { restante: Math.max(Number(montoFinal) - Number(conceptoMonto), 0) };
  } else {
    return { success: false, error: 'Concepto de pago no reconocido' };
  }

  let mensaje = '';
  let restanteFinal = 0;
  if (tipoConcepto === 'mensualidad') {
    mensaje = resultado.meses_cubiertos > 0 ? 'Se aplicaron ' + resultado.meses_cubiertos + ' mes(es) de mensualidad.' : 'El monto no alcanza para cubrir un mes completo.';
    restanteFinal = Number(resultado.restante);
  } else if (tipoConcepto === 'invitado') {
    mensaje = resultado.cubiertos > 0 ? 'Se cubrieron ' + resultado.cubiertos + ' invitado(s) (mas antiguo primero).' : 'El monto no alcanza para cubrir un invitado.';
    if (resultado.pendientes > 0) mensaje += ' Quedan ' + resultado.pendientes + ' pendiente(s).';
    restanteFinal = Number(resultado.restante);
  } else if (tipoConcepto === 'multas_propias' || tipoConcepto === 'multas_invitados') {
    mensaje = resultado.cubiertas > 0 ? 'Se cubrieron ' + resultado.cubiertas + ' multa(s).' : 'El monto no alcanza para cubrir una multa.';
    if (resultado.pendientes > 0) mensaje += ' Quedan ' + resultado.pendientes + ' pendiente(s).';
    restanteFinal = Number(resultado.restante);
  } else if (tipoConcepto === 'partido_especial') {
    mensaje = 'Pago de partido especial registrado.';
    restanteFinal = Number(resultado.restante);
  }

  return { success: true, data: { mensaje, restante: restanteFinal, pagoId: origenSaldoFavor ? null : pagoId } };
}

async function guardarSaldoFavor(pool, jugadorId, body) {
  const { monto, pagoId } = body;
  await pool.query(`SELECT sport_control.crear_saldo_favor($1, $2, $3) AS saldo_id`, [jugadorId, monto, pagoId]);
  await enviarPushSaldoFavor(pool, jugadorId, monto);
  return { success: true, data: true };
}

// ============================================================
// Eventos (torneos, viajes especiales) -- oculto hasta que
// configuracion_club.eventos_habilitado_jugador = true
// ============================================================

async function listarMisEventos(pool, jugadorId) {
  const r = await pool.query(
    `SELECT e.id, e.nombre, e.lugar, e.fecha_inicio, e.fecha_fin, e.estado,
       ec.monto_cuota AS "montoCuota",
       COALESCE((SELECT SUM(m.monto) FROM sport_control.evento_movimientos m WHERE m.evento_id = e.id AND m.jugador_id = $1), 0) AS "montoPagado"
     FROM sport_control.evento_cuota_jugador ec
     JOIN sport_control.eventos e ON e.id = ec.evento_id
     WHERE ec.jugador_id = $1 AND e.estado != 'cancelado'
     ORDER BY e.fecha_inicio DESC NULLS LAST`,
    [jugadorId]
  );
  return { success: true, data: r.rows };
}

async function verEventoPublico(pool, jugadorId, body) {
  const { eventoId } = body;
  const evento = await pool.query(`SELECT id, nombre, descripcion, lugar, fecha_inicio, fecha_fin, estado FROM sport_control.eventos WHERE id = $1`, [eventoId]);
  if (!evento.rows[0]) return { success: false, error: 'Evento no encontrado.' };

  const miCuota = await pool.query(
    `SELECT monto_cuota AS "montoCuota" FROM sport_control.evento_cuota_jugador WHERE evento_id = $1 AND jugador_id = $2`,
    [eventoId, jugadorId]
  );
  const miPagado = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total FROM sport_control.evento_movimientos WHERE evento_id = $1 AND jugador_id = $2`,
    [eventoId, jugadorId]
  );

  // Info PUBLICA: solo totales agregados, sin nombres ni montos individuales de otros jugadores.
  const totalRecaudado = await pool.query(
    `SELECT COALESCE(SUM(m.monto), 0) AS total FROM sport_control.evento_movimientos m JOIN sport_control.tipos_movimiento_evento t ON t.id = m.tipo_movimiento_id WHERE m.evento_id = $1 AND t.tipo = 'ingreso'`,
    [eventoId]
  );
  const totalEsperadoCuotas = await pool.query(
    `SELECT COALESCE(SUM(monto_cuota), 0) AS total FROM sport_control.evento_cuota_jugador WHERE evento_id = $1`,
    [eventoId]
  );
  const gastosPorRubro = await pool.query(
    `SELECT t.nombre AS rubro, COALESCE(SUM(m.monto), 0) AS gastado, COALESCE(p.monto_proyectado, 0) AS proyectado
     FROM sport_control.tipos_movimiento_evento t
     LEFT JOIN sport_control.evento_movimientos m ON m.tipo_movimiento_id = t.id AND m.evento_id = $1
     LEFT JOIN sport_control.evento_presupuesto p ON p.tipo_movimiento_id = t.id AND p.evento_id = $1
     WHERE t.tipo = 'gasto' AND (m.id IS NOT NULL OR p.monto_proyectado > 0)
     GROUP BY t.nombre, p.monto_proyectado ORDER BY t.nombre`,
    [eventoId]
  );

  const fechas = await pool.query(
    `SELECT id, fecha, lugar, descripcion FROM sport_control.evento_fechas WHERE evento_id = $1 ORDER BY fecha ASC`,
    [eventoId]
  );

  return {
    success: true,
    data: {
      evento: evento.rows[0],
      fechas: fechas.rows,
      miCuota: miCuota.rows[0] ? Number(miCuota.rows[0].montoCuota) : null,
      miPagado: Number(miPagado.rows[0].total),
      totalRecaudado: Number(totalRecaudado.rows[0].total),
      totalEsperadoCuotas: Number(totalEsperadoCuotas.rows[0].total),
      gastosPorRubro: gastosPorRubro.rows,
    },
  };
}

async function verMovimientosEventoJugador(pool, body, jugadorIdViewer) {
  const { eventoId } = body;
  let soloPropios = false;
  if (jugadorIdViewer) {
    const cfg = await pool.query(`SELECT movimientos_evento_solo_propios FROM sport_control.configuracion_club WHERE id = 1`);
    soloPropios = !!(cfg.rows[0] && cfg.rows[0].movimientos_evento_solo_propios);
  }
  const movimientos = await pool.query(
    `SELECT m.id, m.monto, m.fecha, m.descripcion, m.evento_fecha_id AS "eventoFechaId", m.jugador_id AS "jugadorId", t.nombre AS "tipoMovimiento", t.tipo,
       j.nombres || ' ' || j.apellidos AS jugador, m.comprobante_base64 IS NOT NULL AS "tieneComprobante"
     FROM sport_control.evento_movimientos m
     JOIN sport_control.tipos_movimiento_evento t ON t.id = m.tipo_movimiento_id
     LEFT JOIN sport_control.jugadores j ON j.id = m.jugador_id
     WHERE m.evento_id = $1 ${soloPropios ? 'AND m.jugador_id = $2' : ''}
     ORDER BY m.fecha DESC, m.id DESC`,
    soloPropios ? [eventoId, jugadorIdViewer] : [eventoId]
  );
  return { success: true, data: movimientos.rows };
}

async function verComprobanteMovimientoJugador(pool, body) {
  const r = await pool.query(`SELECT comprobante_base64 FROM sport_control.evento_movimientos WHERE id = $1`, [body.movimientoId]);
  return { success: true, data: { comprobante_base64: r.rows[0] ? r.rows[0].comprobante_base64 : null } };
}

async function aplicarPagoEvento(pool, jugadorId, body) {
  const { pagoId, monto, eventoId } = body;
  const config = await pool.query(`SELECT tipo_movimiento_cuota_jugador_id FROM sport_control.configuracion_club WHERE id = 1`);
  const tipoCuotaId = config.rows[0] && config.rows[0].tipo_movimiento_cuota_jugador_id;
  if (!tipoCuotaId) return { success: false, error: 'No está configurado el rubro de "Cuota jugador". Contacta al administrador.' };

  const miCuota = await pool.query(`SELECT monto_cuota FROM sport_control.evento_cuota_jugador WHERE evento_id = $1 AND jugador_id = $2`, [eventoId, jugadorId]);
  if (!miCuota.rows[0]) return { success: false, error: 'No tienes una cuota asignada para este evento.' };

  const yaPagado = await pool.query(`SELECT COALESCE(SUM(monto), 0) AS total FROM sport_control.evento_movimientos WHERE evento_id = $1 AND jugador_id = $2`, [eventoId, jugadorId]);
  const pendiente = Math.max(Number(miCuota.rows[0].monto_cuota) - Number(yaPagado.rows[0].total), 0);
  const montoAAplicar = Math.min(Number(monto), pendiente);
  const restante = Number(monto) - montoAAplicar;

  if (montoAAplicar > 0) {
    await pool.query(
      `INSERT INTO sport_control.evento_movimientos (evento_id, tipo_movimiento_id, jugador_id, monto, fecha, descripcion, creado_en)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, 'Pago de cuota via app', NOW())`,
      [eventoId, tipoCuotaId, jugadorId, montoAAplicar]
    );
  }

  const mensaje = montoAAplicar > 0 ? `Se aplicaron $${montoAAplicar.toFixed(2)} a tu cuota del evento.` : 'Tu cuota de este evento ya estaba cubierta.';
  return { success: true, data: { mensaje, restante, pagoId } };
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });

  const body = req.body || {};
  const { accion, token } = body;
  const pool = getPool();

  try {
    // Acciones que NO requieren sesion existente
    if (accion === 'login_jugador') return res.status(200).json(await loginJugador(pool, body));
    if (accion === 'registrar_jugador_pwa') return res.status(200).json(await registrarJugadorPwa(pool, body));

    // Todo lo demas requiere una sesion valida
    const jugadorId = await resolverSesion(pool, token);
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    switch (accion) {
      case 'obtener_mi_perfil_jugador': return res.status(200).json(await obtenerMiPerfil(pool, jugadorId));
      case 'ver_mis_partidos_jugador': return res.status(200).json(await verMisPartidos(pool, jugadorId));
      case 'ver_detalle_partido_stats_jugador': return res.status(200).json(await verDetallePartidoStatsJugador(pool, body));
      case 'ver_foto_partido_jugador': return res.status(200).json(await verFotoPartidoAdmin(pool, body));
      case 'ver_pendientes_pago_jugador': return res.status(200).json(await verPendientesPago(pool, jugadorId));
      case 'ver_mi_qr_jugador': return res.status(200).json(await verMiQr(pool, jugadorId, body.partidoId));
      case 'actualizar_mis_datos_jugador': return res.status(200).json(await actualizarMisDatos(pool, jugadorId, body));
      case 'confirmar_mi_partido_jugador': return res.status(200).json(await confirmarMiPartido(pool, jugadorId, body));
      case 'cancelar_mi_partido_jugador': return res.status(200).json(await cancelarMiPartido(pool, jugadorId, body));
      case 'ver_documento_jugador': return res.status(200).json(await verDocumento(pool, body));
      case 'marcar_push_habilitado_jugador': return res.status(200).json(await marcarPushHabilitado(pool, jugadorId));
      case 'ver_mis_ultimos_pagos_jugador': return res.status(200).json(await verMisUltimosPagos(pool, jugadorId));
      case 'ver_mis_invitados_partido_jugador': return res.status(200).json(await verMisInvitados(pool, jugadorId, body));
      case 'listar_tipos_relacion_exento': return res.status(200).json(await listarTiposRelacionExento(pool));
      case 'listar_mis_exentos_jugador': return res.status(200).json(await listarMisExentos(pool, jugadorId));
      case 'agregar_exento_jugador': return res.status(200).json(await agregarExento(pool, jugadorId, body));
      case 'eliminar_exento_jugador': return res.status(200).json(await eliminarExento(pool, jugadorId, body));
      case 'listar_mis_representantes_jugador': return res.status(200).json(await listarMisRepresentantes(pool, jugadorId));
      case 'agregar_representante_jugador': return res.status(200).json(await agregarRepresentante(pool, jugadorId, body));
      case 'editar_representante_jugador': return res.status(200).json(await editarRepresentante(pool, jugadorId, body));
      case 'eliminar_representante_jugador': return res.status(200).json(await eliminarRepresentante(pool, jugadorId, body));
      case 'agregar_invitado_partido_jugador': return res.status(200).json(await agregarInvitado(pool, jugadorId, body));
      case 'quitar_invitado_partido_jugador': return res.status(200).json(await quitarInvitado(pool, jugadorId, body));
      case 'analizar_comprobante_jugador': return res.status(200).json(await analizarComprobante(pool, body));
      case 'registrar_pago_comprobante_jugador': return res.status(200).json(await registrarPagoComprobante(pool, jugadorId, body));
      case 'aplicar_pago_jugador': return res.status(200).json(await aplicarPago(pool, jugadorId, body));
      case 'guardar_restante_saldo_favor_jugador': return res.status(200).json(await guardarSaldoFavor(pool, jugadorId, body));
      case 'listar_mis_eventos_jugador': return res.status(200).json(await listarMisEventos(pool, jugadorId));
      case 'ver_evento_publico_jugador': return res.status(200).json(await verEventoPublico(pool, jugadorId, body));
      case 'ver_movimientos_evento_jugador': return res.status(200).json(await verMovimientosEventoJugador(pool, body, jugadorId));
      case 'ver_comprobante_movimiento_jugador': return res.status(200).json(await verComprobanteMovimientoJugador(pool, body));
      case 'aplicar_pago_evento_jugador': return res.status(200).json(await aplicarPagoEvento(pool, jugadorId, body));
      default:
        return res.status(200).json({ success: false, error: 'Accion no reconocida' });
    }
  } catch (err) {
    console.error(`Error en /api/jugador (accion=${accion}):`, err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};

// ============================================================
// Exportaciones adicionales (solo lectura) para que api/representante.js
// pueda reutilizar exactamente la misma logica, sin duplicar codigo.
// Esto NO cambia en nada el comportamiento de este archivo como
// funcion serverless -- module.exports sigue siendo el mismo handler
// de siempre, solo se le agregan propiedades adicionales.
// ============================================================
module.exports.obtenerMiPerfil = obtenerMiPerfil;
module.exports.verMisPartidos = verMisPartidos;
module.exports.verDetallePartidoStatsJugador = verDetallePartidoStatsJugador;
module.exports.verFotoPartidoAdmin = verFotoPartidoAdmin;
module.exports.verPendientesPago = verPendientesPago;
module.exports.verMiQr = verMiQr;
module.exports.verMisUltimosPagos = verMisUltimosPagos;
module.exports.verMisInvitados = verMisInvitados;
module.exports.listarMisEventos = listarMisEventos;
module.exports.verEventoPublico = verEventoPublico;
module.exports.verMovimientosEventoJugador = verMovimientosEventoJugador;
module.exports.verComprobanteMovimientoJugador = verComprobanteMovimientoJugador;
module.exports.actualizarMisDatos = actualizarMisDatos;
module.exports.analizarComprobante = analizarComprobante;
module.exports.registrarPagoComprobante = registrarPagoComprobante;
module.exports.aplicarPago = aplicarPago;
module.exports.aplicarPagoEvento = aplicarPagoEvento;
module.exports.guardarSaldoFavor = guardarSaldoFavor;
