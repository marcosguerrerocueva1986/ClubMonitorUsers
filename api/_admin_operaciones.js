// api/_admin_operaciones.js

async function obtenerParametros(pool) {
  const r = await pool.query(
    `SELECT (SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1) AS cuota_mensual,
            (SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'invitado' AND activo = true ORDER BY prioridad ASC LIMIT 1) AS costo_invitado,
            valor_multa_inasistencia, valor_multa_invitado_no_show, meses_maximo_atraso, numero_admin,
            to_char(fecha_inicio_recaudacion, 'DD/MM/YYYY') AS fecha_inicio_recaudacion, meses_retener_codigos,
            to_char(fecha_inicio_mensualidades, 'DD/MM/YYYY') AS fecha_inicio_mensualidades,
            eventos_habilitado_jugador, representantes_habilitado, icono_deporte,
            mis_exentos_habilitado_jugador, mi_cuenta_habilitado_jugador, movimientos_evento_solo_propios
     FROM sport_control.configuracion_club WHERE id = 1`
  );
  return { success: true, data: r.rows[0] };
}

async function actualizarParametro(pool, body) {
  const { campo, valor } = body;

  // cuota_mensual y costo_invitado dependen de que YA exista una fila
  // activa con ese "tipo" en catalogo_cobros -- si no existe, el UPDATE
  // no actualiza nada (0 filas) SIN avisar, y el admin cree que quedo
  // guardado cuando en realidad nunca se toco nada. Aqui se detecta ese
  // caso y se crea la fila si hace falta, en vez de fallar en silencio.
  if (campo === 'cuota_mensual' || campo === 'costo_invitado') {
    const tipo = campo === 'cuota_mensual' ? 'mensualidad' : 'invitado';
    const upd = await pool.query(
      `UPDATE sport_control.catalogo_cobros SET valor = $1 WHERE tipo = $2 AND activo = true`,
      [valor, tipo]
    );
    if (upd.rowCount === 0) {
      try {
        await pool.query(
          `INSERT INTO sport_control.catalogo_cobros (tipo, valor, activo, prioridad) VALUES ($1, $2, true, 1)`,
          [tipo, valor]
        );
      } catch (err) {
        return { success: false, error: `No existía una fila activa de tipo "${tipo}" en catalogo_cobros y no se pudo crear una nueva (${err.message}). Revisa esa tabla directamente.` };
      }
    }
    return { success: true };
  }

  const map = {
    multa_inasistencia: { sql: `UPDATE sport_control.configuracion_club SET valor_multa_inasistencia = $1 WHERE id = 1`, val: valor },
    multa_invitado_no_show: { sql: `UPDATE sport_control.configuracion_club SET valor_multa_invitado_no_show = $1 WHERE id = 1`, val: valor },
    meses_maximo_atraso: { sql: `UPDATE sport_control.configuracion_club SET meses_maximo_atraso = $1 WHERE id = 1`, val: valor },
    numero_admin: { sql: `UPDATE sport_control.configuracion_club SET numero_admin = $1 WHERE id = 1`, val: valor },
    meses_retener_codigos: { sql: `UPDATE sport_control.configuracion_club SET meses_retener_codigos = $1 WHERE id = 1`, val: valor },
    icono_deporte: { sql: `UPDATE sport_control.configuracion_club SET icono_deporte = $1 WHERE id = 1`, val: valor },
  };
  if (campo === 'fecha_inicio_recaudacion' || campo === 'fecha_inicio_mensualidades') {
    const partes = String(valor).trim().split('/');
    if (partes.length !== 3) return { success: false, error: 'Usa el formato DD/MM/AAAA.' };
    const iso = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
    await pool.query(`UPDATE sport_control.configuracion_club SET ${campo} = $1::date WHERE id = 1`, [iso]);
    return { success: true };
  }
  const entry = map[campo];
  if (!entry) return { success: false, error: 'Campo de parametro no reconocido.' };
  await pool.query(entry.sql, [entry.val]);
  return { success: true };
}

async function diagnosticoCatalogoCobros(pool) {
  const r = await pool.query(`SELECT id, tipo, valor, activo, prioridad FROM sport_control.catalogo_cobros ORDER BY tipo, prioridad`);
  return { success: true, data: r.rows };
}

// Historial de vigencias -- en vez de sobreescribir el valor de un
// cobro, se agrega una fila nueva con la fecha desde la que rige.
// Los meses anteriores a esa fecha siguen calculandose con el valor
// que tenian antes; nada se pierde ni se recalcula mal.
async function listarVigenciasCobro(pool, body) {
  const { tipo } = body; // 'mensualidad' | 'invitado'
  const cobro = await pool.query(`SELECT id, valor FROM sport_control.catalogo_cobros WHERE tipo = $1 AND activo = true ORDER BY prioridad ASC LIMIT 1`, [tipo]);
  if (!cobro.rows[0]) return { success: true, data: { catalogoCobroId: null, vigencias: [] } };
  const vigencias = await pool.query(
    `SELECT id, valor, to_char(vigente_desde, 'DD/MM/YYYY') AS "vigenteDesde" FROM sport_control.catalogo_cobros_historial
     WHERE catalogo_cobro_id = $1 ORDER BY vigente_desde DESC`,
    [cobro.rows[0].id]
  );
  return { success: true, data: { catalogoCobroId: cobro.rows[0].id, vigencias: vigencias.rows } };
}

async function agregarVigenciaCobro(pool, body) {
  const { tipo, valor, vigenteDesde } = body;
  const partes = String(vigenteDesde || '').trim().split('/');
  if (partes.length !== 3) return { success: false, error: 'Usa el formato DD/MM/AAAA para la fecha.' };
  const iso = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
  if (!valor || Number(valor) <= 0) return { success: false, error: 'Escribe un valor válido.' };

  let cobro = await pool.query(`SELECT id FROM sport_control.catalogo_cobros WHERE tipo = $1 AND activo = true ORDER BY prioridad ASC LIMIT 1`, [tipo]);
  let catalogoCobroId;
  if (cobro.rows[0]) {
    catalogoCobroId = cobro.rows[0].id;
  } else {
    const nuevo = await pool.query(`INSERT INTO sport_control.catalogo_cobros (tipo, valor, activo, prioridad) VALUES ($1, $2, true, 1) RETURNING id`, [tipo, valor]);
    catalogoCobroId = nuevo.rows[0].id;
  }

  await pool.query(
    `INSERT INTO sport_control.catalogo_cobros_historial (catalogo_cobro_id, valor, vigente_desde) VALUES ($1, $2, $3::date)`,
    [catalogoCobroId, valor, iso]
  );

  // catalogo_cobros.valor se mantiene como un "cache" del valor MAS
  // RECIENTE, para no tener que tocar los otros lugares del sistema
  // que todavia lo leen directo de ahi.
  const masReciente = await pool.query(
    `SELECT valor FROM sport_control.catalogo_cobros_historial WHERE catalogo_cobro_id = $1 ORDER BY vigente_desde DESC LIMIT 1`,
    [catalogoCobroId]
  );
  await pool.query(`UPDATE sport_control.catalogo_cobros SET valor = $1 WHERE id = $2`, [masReciente.rows[0].valor, catalogoCobroId]);

  return { success: true };
}

async function eliminarVigenciaCobro(pool, body) {
  await pool.query(`DELETE FROM sport_control.catalogo_cobros_historial WHERE id = $1`, [body.vigenciaId]);
  return { success: true };
}

async function reenviarQrJugador(pool, config, body) {
  const r = await pool.query(
    `SELECT ca.token, j.telefono, j.nombres, j.apellidos FROM sport_control.codigos_asistencia ca JOIN sport_control.jugadores j ON j.id = ca.jugador_id
     WHERE ca.partido_id = $1 AND ca.jugador_id = $2 AND ca.invitado_asistencia_id IS NULL LIMIT 1`,
    [body.partidoId, body.jugadorId]
  );
  const row = r.rows[0];
  if (!row || !row.token) return { success: false, error: 'Este jugador todavia no tiene un codigo QR generado.' };
  const waLink = `https://wa.me/${config.whatsapp_checkin_numero}?text=ASISTIO-` + row.token;
  const mediaUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=20&ecc=M&data=' + encodeURIComponent(waLink);
  const { enviarWhatsAppMedia } = require('./_admin_partidos');
  await enviarWhatsAppMedia(config, row.telefono, mediaUrl, 'Tu codigo de asistencia para el partido.');
  return { success: true };
}

async function anularMulta(pool, body) {
  const { partidoId, todas, ids } = body;
  let r;
  if (todas) {
    r = await pool.query(`UPDATE sport_control.multas SET estado = 'anulada', anulada_en = NOW() WHERE partido_id = $1 AND estado = 'pendiente_aprobacion'`, [partidoId]);
  } else {
    const idsLimpios = (ids || []).filter((id) => Number.isInteger(id) || /^\d+$/.test(id)).map(Number);
    if (idsLimpios.length === 0) return { success: false, error: 'No se especificaron multas validas para anular.' };
    r = await pool.query(`UPDATE sport_control.multas SET estado = 'anulada', anulada_en = NOW() WHERE partido_id = $1 AND estado = 'pendiente_aprobacion' AND id = ANY($2::int[])`, [partidoId, idsLimpios]);
  }
  const resumen = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('id', m.id, 'nombre', j.nombres || ' ' || j.apellidos, 'motivo', t.nombre, 'monto', m.monto)), '[]'::json) AS multas, COALESCE(SUM(m.monto), 0) AS total
     FROM sport_control.multas m JOIN sport_control.jugadores j ON j.id = m.jugador_id JOIN sport_control.tipos_multa t ON t.id = m.tipo_multa_id
     WHERE m.partido_id = $1 AND m.estado = 'pendiente_aprobacion'`,
    [partidoId]
  );
  return { success: true, data: { multas: resumen.rows[0].multas, total: resumen.rows[0].total } };
}

async function confirmarMultas(pool, config, body) {
  await pool.query(`UPDATE sport_control.multas SET estado = 'aprobada', aprobada_en = NOW() WHERE partido_id = $1 AND estado = 'pendiente_aprobacion'`, [body.partidoId]);
  const resumen = await pool.query(
    `SELECT COALESCE(json_agg(json_build_object('nombre', nombre, 'total', total)), '[]'::json) AS jugadores, COALESCE(SUM(total), 0) AS "granTotal"
     FROM (SELECT j.nombres || ' ' || j.apellidos AS nombre, SUM(m.monto) AS total FROM sport_control.multas m JOIN sport_control.jugadores j ON j.id = m.jugador_id WHERE m.partido_id = $1 AND m.estado = 'aprobada' GROUP BY j.id, j.nombres, j.apellidos) sub`,
    [body.partidoId]
  );
  const jugadores = resumen.rows[0].jugadores;
  const granTotal = Number(resumen.rows[0].granTotal);
  if (granTotal > 0) {
    const lineas = jugadores.map((j) => '• ' + j.nombre + ': $' + j.total);
    await enviarWhatsAppGrupoConfig(config, '💰 *Multas del partido*\n\n' + lineas.join('\n') + '\n\nTotal: $' + granTotal);
  }
  return { success: true, data: { jugadores, granTotal } };
}
async function enviarWhatsAppGrupoConfig(config, texto) {
  const { enviarWhatsAppGrupo } = require('./_admin_partidos');
  await enviarWhatsAppGrupo(config, texto);
}

async function toggleAsistencia(pool, body) {
  const { tipo, id, partidoId, presente } = body;
  const where = tipo === 'invitado' ? `invitado_asistencia_id = $2` : `jugador_id = $2 AND invitado_asistencia_id IS NULL`;
  const buscar = await pool.query(`SELECT id FROM sport_control.codigos_asistencia WHERE partido_id = $1 AND ${where} LIMIT 1`, [partidoId, id]);
  const existente = buscar.rows[0];

  if (existente) {
    await pool.query(`UPDATE sport_control.codigos_asistencia SET usado = $1, escaneado_en = ${presente ? 'NOW()' : 'NULL'} WHERE id = $2`, [!!presente, existente.id]);
    return { success: true };
  }

  if (presente) {
    const token = Math.random().toString(36).substring(2, 8).toUpperCase();
    if (tipo === 'invitado') {
      await pool.query(
        `INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, invitado_asistencia_id, token, usado, escaneado_en)
         SELECT $1, jugador_anfitrion_id, $2, $3, true, NOW() FROM sport_control.invitados_asistencia WHERE id = $2`,
        [partidoId, id, token]
      );
    } else {
      await pool.query(
        `INSERT INTO sport_control.codigos_asistencia (partido_id, jugador_id, token, usado, escaneado_en) VALUES ($1, $2, $3, true, NOW())`,
        [partidoId, id, token]
      );
    }
  }
  return { success: true };
}

async function enviarRecordatorioPartido(pool, config, body) {
  const r = await pool.query(
    `SELECT p.id, p.alias, p.fecha, p.hora, p.lugar, p.estado, sport_control.lista_confirmados_partido(p.id) AS lista FROM sport_control.partidos p WHERE p.id = $1`,
    [body.partidoId]
  );
  const p = r.rows[0];
  if (!p) return { success: false, error: 'No se encontro el partido (partidoId=' + body.partidoId + ')' };
  const titulo = p.alias ? p.alias : 'Partido';
  const lista = p.lista || [];
  const lineas = lista.map((item, i) => item.tipo === 'invitado' ? `${i + 1}. 🎟️ ${item.nombre} (invitado de ${item.anfitrion})` : `${i + 1}. ${item.nombre}`);
  const { fechaCorta, enviarWhatsAppGrupo } = require('./_admin_partidos');
  const texto = '⏰ *Recordatorio: ' + titulo + '*\n📅 ' + fechaCorta(p.fecha) + '  🕐 ' + (p.hora || '') + '\n📍 ' + (p.lugar || '') + '\n\nConfirmados (' + lista.length + '):\n\n' + (lineas.length > 0 ? lineas.join('\n') : 'Nadie confirmado todavía.') + '\n\nResponde *voy* o *no voy* para confirmar tu asistencia.';
  const diagnostico = await enviarWhatsAppGrupo(config, texto);
  if (!diagnostico.enviado) {
    // Temporal: devolvemos el motivo real en vez de fallar en silencio,
    // para diagnosticar por que no llegaba el mensaje.
    return { success: false, error: 'No se pudo enviar al grupo: ' + JSON.stringify(diagnostico) };
  }
  return { success: true };
}

async function enviarRecordatorioMorosos(pool, config) {
  const r = await pool.query(
    `SELECT j.id, j.telefono, j.nombres, sport_control.meses_atraso(j.id) AS meses_atraso,
            sport_control.meses_atraso(j.id) * COALESCE((SELECT valor FROM sport_control.catalogo_cobros WHERE tipo = 'mensualidad' AND activo = true ORDER BY prioridad ASC LIMIT 1), 0) AS deuda
     FROM sport_control.jugadores j WHERE j.estado = 'activo' AND sport_control.meses_atraso(j.id) > (SELECT meses_maximo_atraso FROM sport_control.configuracion_club WHERE id = 1) AND NOT j.autorizado_excepcion_pago`
  );
  const { enviarWhatsAppPrivado } = require('./_admin_partidos');
  for (const j of r.rows) {
    const texto = `⚠️ Hola ${j.nombres}, este es un recordatorio de pago. Tienes ${j.meses_atraso} mes(es) de mensualidad pendiente (aprox. $${j.deuda}). Por favor regulariza tu pago cuando puedas. ¡Gracias! ⚽`;
    await enviarWhatsAppPrivado(config, j.telefono, texto);
  }
  return { success: true, data: { enviados: r.rows.length } };
}

async function marcarPagoInvitado(pool, body) {
  await pool.query(`UPDATE sport_control.invitados_asistencia SET pagado = $1 WHERE id = $2`, [!!body.pagado, body.invitadoId]);
  return { success: true };
}

async function marcarMultaPagada(pool, body) {
  await pool.query(`UPDATE sport_control.multas SET pagada = $1, pagada_en = CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id = $2`, [!!body.pagada, body.multaId]);
  return { success: true };
}

async function toggleEventosJugador(pool, body) {
  await pool.query(`UPDATE sport_control.configuracion_club SET eventos_habilitado_jugador = $1 WHERE id = 1`, [!!body.habilitado]);
  return { success: true };
}

async function toggleRepresentantesClub(pool, body) {
  await pool.query(`UPDATE sport_control.configuracion_club SET representantes_habilitado = $1 WHERE id = 1`, [!!body.habilitado]);
  return { success: true };
}

async function toggleMisExentosJugador(pool, body) {
  await pool.query(`UPDATE sport_control.configuracion_club SET mis_exentos_habilitado_jugador = $1 WHERE id = 1`, [!!body.habilitado]);
  return { success: true };
}

async function toggleMiCuentaJugador(pool, body) {
  await pool.query(`UPDATE sport_control.configuracion_club SET mi_cuenta_habilitado_jugador = $1 WHERE id = 1`, [!!body.habilitado]);
  return { success: true };
}

async function toggleMovimientosSoloPropios(pool, body) {
  await pool.query(`UPDATE sport_control.configuracion_club SET movimientos_evento_solo_propios = $1 WHERE id = 1`, [!!body.habilitado]);
  return { success: true };
}

async function listarPermisosPantallas(pool) {
  const r = await pool.query(`SELECT funcionalidad, rol, habilitado FROM sport_control.permisos_pantallas ORDER BY funcionalidad, rol`);
  return { success: true, data: r.rows };
}

async function togglePermisoPantalla(pool, body) {
  const { funcionalidad, rol, habilitado } = body;
  await pool.query(
    `INSERT INTO sport_control.permisos_pantallas (funcionalidad, rol, habilitado) VALUES ($1, $2, $3)
     ON CONFLICT (funcionalidad, rol) DO UPDATE SET habilitado = EXCLUDED.habilitado`,
    [funcionalidad, rol, !!habilitado]
  );
  return { success: true };
}

async function actualizarLogoClub(pool, body) {
  const { logoBase64 } = body;
  if (!logoBase64) return { success: false, error: 'No se recibió ninguna imagen.' };
  await pool.query(`UPDATE sport_control.configuracion_club SET logo_base64 = $1 WHERE id = 1`, [logoBase64]);
  return { success: true };
}

module.exports = {
  obtenerParametros, actualizarParametro, reenviarQrJugador, anularMulta, confirmarMultas,
  toggleAsistencia, enviarRecordatorioPartido, enviarRecordatorioMorosos, marcarPagoInvitado, marcarMultaPagada,
  toggleEventosJugador, actualizarLogoClub, toggleRepresentantesClub,
  toggleMisExentosJugador, toggleMiCuentaJugador, toggleMovimientosSoloPropios,
  listarPermisosPantallas, togglePermisoPantalla, diagnosticoCatalogoCobros,
  listarVigenciasCobro, agregarVigenciaCobro, eliminarVigenciaCobro,
};
