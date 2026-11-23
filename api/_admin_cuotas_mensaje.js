// api/_admin_cuotas_mensaje.js
// Mensaje de estado de cuotas de un evento: vista previa, envio al grupo
// de WhatsApp del club y push a los representantes de quienes deben.
// Respeta los interruptores maestros (_notificaciones.js).

const { enviarPushRepresentantes } = require('./_notificaciones');

const fmt = (n) => {
  const x = Math.round(Number(n || 0) * 100) / 100;
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
};

function fechaHoyCorta() {
  const d = new Date(Date.now() - 5 * 3600 * 1000); // Ecuador UTC-5
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
}

// Una fila por jugador (suma sus cuotas si el evento tiene varias fechas).
async function cargarEstadoCuotas(pool, eventoId) {
  const ev = await pool.query(`SELECT id, nombre FROM sport_control.eventos WHERE id = $1`, [eventoId]);
  if (!ev.rows[0]) return null;
  const r = await pool.query(
    `SELECT ec.jugador_id AS "jugadorId",
        COALESCE(j.alias, j.nombres || ' ' || j.apellidos) AS nombre,
        MIN(COALESCE(ec.numero_camiseta, j.numero_camiseta)::text) AS numero,
        SUM(ec.monto_cuota) AS esperado,
        COALESCE(SUM((SELECT COALESCE(SUM(m.monto),0) FROM sport_control.evento_movimientos m
           WHERE m.evento_id = ec.evento_id AND m.jugador_id = ec.jugador_id
             AND m.evento_fecha_id IS NOT DISTINCT FROM ec.evento_fecha_id)), 0) AS pagado
     FROM sport_control.evento_cuota_jugador ec
     JOIN sport_control.jugadores j ON j.id = ec.jugador_id
     WHERE ec.evento_id = $1
     GROUP BY ec.jugador_id, j.alias, j.nombres, j.apellidos
     HAVING SUM(ec.monto_cuota) > 0
     ORDER BY 2`,
    [eventoId]
  );
  const jugadores = r.rows.map((x) => ({
    jugadorId: x.jugadorId, nombre: x.nombre, numero: x.numero,
    esperado: Number(x.esperado), pagado: Number(x.pagado),
  }));
  return { evento: ev.rows[0], jugadores };
}

function construirTexto(evento, jugadores, soloDeudores) {
  const linea = (j, icono) => `${icono} ${j.numero ? '#' + j.numero + ' ' : ''}${j.nombre} — ${fmt(j.esperado)}/${fmt(j.pagado)}`
    + (j.pagado < j.esperado ? ` (debe $${fmt(j.esperado - j.pagado)})` : '');
  const sinPagar = jugadores.filter((j) => j.pagado <= 0);
  const parcial = jugadores.filter((j) => j.pagado > 0 && j.pagado < j.esperado);
  const alDia = jugadores.filter((j) => j.pagado >= j.esperado);
  const totEsp = jugadores.reduce((s, j) => s + j.esperado, 0);
  const totPag = jugadores.reduce((s, j) => s + Math.min(j.pagado, j.esperado), 0);

  let t = `💰 *Cuotas – ${evento.nombre}*\n📅 Actualizado: ${fechaHoyCorta()}\n_(formato: esperado/pagado en USD)_\n`;
  if (sinPagar.length || parcial.length) {
    t += '\n⚠️ *Con saldo pendiente*\n' + [...sinPagar.map((j) => linea(j, '🔴')), ...parcial.map((j) => linea(j, '🟡'))].join('\n') + '\n';
  } else {
    t += '\n🎉 ¡Todos están al día!\n';
  }
  if (!soloDeudores && alDia.length) t += '\n✅ *Al día*\n' + alDia.map((j) => linea(j, '🟢')).join('\n') + '\n';
  t += `\n📊 *Resumen*\nEsperado: $${fmt(totEsp)} · Pagado: $${fmt(totPag)} · Pendiente: $${fmt(totEsp - totPag)}\nAl día: ${alDia.length} de ${jugadores.length}`;
  return t;
}

async function vistaPreviaCuotasEvento(pool, body) {
  const est = await cargarEstadoCuotas(pool, body.eventoId);
  if (!est) return { success: false, error: 'No se encontró el evento.' };
  if (est.jugadores.length === 0) return { success: false, error: 'Este evento no tiene cuotas con valor mayor a $0.' };
  return { success: true, data: { texto: construirTexto(est.evento, est.jugadores, !!body.soloDeudores), cantidad: est.jugadores.length } };
}

// Push: un aviso por representante con SUS jugadores que deben.
async function pushDeudoresEvento(pool, est) {
  const deudores = est.jugadores.filter((j) => j.pagado < j.esperado);
  if (deudores.length === 0) return { enviado: false, motivo: 'Nadie debe nada.' };
  const rel = await pool.query(
    `SELECT jugador_id, representante_id FROM sport_control.jugador_representante WHERE jugador_id = ANY($1::bigint[])`,
    [deudores.map((d) => d.jugadorId)]
  );
  const porRep = {};
  rel.rows.forEach((x) => {
    const d = deudores.find((j) => j.jugadorId === x.jugador_id);
    if (!d) return;
    (porRep[x.representante_id] = porRep[x.representante_id] || []).push(d);
  });
  const reps = Object.keys(porRep);
  if (reps.length === 0) return { enviado: false, motivo: 'Los jugadores con saldo no tienen representante vinculado.' };
  let ok = 0, omitido = false, ultimo = null;
  for (const rep of reps) {
    const items = porRep[rep];
    const cuerpo = items.map((j) => `${j.nombre}: debe $${fmt(j.esperado - j.pagado)} (${fmt(j.esperado)}/${fmt(j.pagado)})`).join(' · ');
    const r = await enviarPushRepresentantes(pool, { representanteIds: [Number(rep)], titulo: `🔴 Cuota pendiente – ${est.evento.nombre}`, cuerpo });
    if (r.omitido) { omitido = true; break; }
    if (r.enviado) ok++; else ultimo = r;
  }
  if (omitido) return { enviado: false, omitido: true, motivo: 'Push a representantes desactivado (Parámetros → Notificaciones).' };
  return { enviado: ok > 0, representantes: ok, de: reps.length, detalle: ok > 0 ? null : ultimo };
}

async function enviarCuotasEvento(pool, config, body) {
  const est = await cargarEstadoCuotas(pool, body.eventoId);
  if (!est) return { success: false, error: 'No se encontró el evento.' };
  if (est.jugadores.length === 0) return { success: false, error: 'Este evento no tiene cuotas con valor mayor a $0.' };
  const out = {};
  if (body.whatsapp !== false) {
    const { enviarWhatsAppGrupo } = require('./_admin_partidos');
    const texto = (body.texto && String(body.texto).trim()) || construirTexto(est.evento, est.jugadores, !!body.soloDeudores);
    const wa = await enviarWhatsAppGrupo(config, texto);
    out.whatsapp = wa.enviado ? 'enviado' : (wa.omitido ? 'desactivado' : 'error');
    if (!wa.enviado && !wa.omitido) out.detalleWhatsApp = wa;
  }
  if (body.push) {
    const p = await pushDeudoresEvento(pool, est);
    out.push = p.enviado ? `enviado (${p.representantes} de ${p.de} representantes)` : (p.omitido ? 'desactivado' : 'sin_envio: ' + (p.motivo || (p.detalle && p.detalle.motivo) || 'falló'));
  }
  if (!out.whatsapp && !out.push) return { success: false, error: 'Elige al menos un canal.' };
  const huboEnvio = out.whatsapp === 'enviado' || (out.push || '').startsWith('enviado');
  if (!huboEnvio) return { success: false, error: 'No se envió nada. WhatsApp: ' + (out.whatsapp || '-') + ' · Push: ' + (out.push || '-'), data: out };
  return { success: true, data: out };
}

module.exports = { vistaPreviaCuotasEvento, enviarCuotasEvento, construirTexto, cargarEstadoCuotas };
