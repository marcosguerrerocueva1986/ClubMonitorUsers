// api/aplicar-pago.js
// Reemplaza 'aplicar_pago_jugador'. Replica la misma logica de n8n:
//   1. Si origenSaldoFavor=true, primero descuenta del saldo a favor
//      (funcion SQL usar_saldo_favor) y crea un pago nuevo con ese monto.
//   2. Segun tipoConcepto, llama a la funcion SQL correspondiente
//      (todas ya viven en Postgres, se reutilizan tal cual).
//   3. Formatea el mensaje de resultado igual que antes.

const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  try {
    const body = req.body || {};
    const { token, tipoConcepto, monto, origenSaldoFavor, pagoId: pagoIdBody, partidoId, conceptoMonto } = body;
    const pool = getPool();

    const sesion = await pool.query(
      `SELECT s.jugador_id FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_pwa s ON s.token = $1 LIMIT 1`,
      [token || '']
    );
    const jugadorId = sesion.rows[0] && sesion.rows[0].jugador_id;
    if (!jugadorId) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    let pagoId = pagoIdBody;
    let montoFinal = monto;

    if (origenSaldoFavor) {
      const r = await pool.query(
        `WITH usado AS (
           SELECT sport_control.usar_saldo_favor($1, $2) AS monto_usado
         ),
         nuevo_pago AS (
           INSERT INTO sport_control.pagos (jugador_id, monto, numero_comprobante, banco, fecha_comprobante, metodo_pago, estado, creado_en)
           SELECT $1, monto_usado, 'SALDOFAVOR-' || $1 || '-' || extract(epoch from now())::bigint, 'Saldo a favor', CURRENT_DATE, 'saldo_a_favor', 'confirmado', NOW()
           FROM usado WHERE monto_usado > 0 RETURNING id, monto
         )
         SELECT np.id AS pago_id, np.monto AS monto_final FROM (SELECT 1 AS ancla) d LEFT JOIN nuevo_pago np ON true`,
        [jugadorId, monto]
      );
      pagoId = r.rows[0].pago_id;
      montoFinal = r.rows[0].monto_final;
    }

    let resultado;
    if (tipoConcepto === 'mensualidad') {
      const r = await pool.query(`SELECT sport_control.aplicar_pago_mensualidad($1, $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal]);
      resultado = r.rows[0].resultado;
    } else if (tipoConcepto === 'invitado') {
      const r = await pool.query(`SELECT sport_control.aplicar_pago_invitados($1, $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal]);
      resultado = r.rows[0].resultado;
    } else if (tipoConcepto === 'multas_propias') {
      const r = await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'propia', $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal]);
      resultado = r.rows[0].resultado;
    } else if (tipoConcepto === 'multas_invitados') {
      const r = await pool.query(`SELECT sport_control.aplicar_pago_multas($1, 'invitado', $2, $3) AS resultado`, [jugadorId, pagoId, montoFinal]);
      resultado = r.rows[0].resultado;
    } else if (tipoConcepto === 'partido_especial') {
      const restante = Math.max(Number(montoFinal) - Number(conceptoMonto), 0);
      resultado = { restante };
    } else {
      return res.status(200).json({ success: false, error: 'Concepto de pago no reconocido' });
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

    return res.status(200).json({
      success: true,
      data: { mensaje, restante: restanteFinal, pagoId: origenSaldoFavor ? null : pagoId },
    });
  } catch (err) {
    console.error('Error en /api/aplicar-pago:', err);
    return res.status(200).json({ success: false, error: 'Error interno del servidor' });
  }
};
