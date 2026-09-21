// api/_admin_planilleros.js
// Gestion de planilleros -- mismo patron de seguridad ya probado con
// representantes/entrenadores (cedula + clave de 6 digitos).

const bcrypt = require('bcryptjs');

async function listarPlanilleros(pool) {
  const r = await pool.query(
    `SELECT id, nombres, apellidos, cedula, telefono, activo, (clave_hash IS NOT NULL) AS "tieneClave"
     FROM sport_control.planilleros ORDER BY nombres`
  );
  return { success: true, data: r.rows };
}

async function crearPlanillero(pool, body) {
  const nombres = (body.nombres || '').trim();
  const apellidos = (body.apellidos || '').trim();
  const cedula = (body.cedula || '').trim();
  if (!nombres || !apellidos) return { success: false, error: 'Completa nombres y apellidos.' };
  if (!cedula) return { success: false, error: 'La cédula es obligatoria.' };
  try {
    const r = await pool.query(
      `INSERT INTO sport_control.planilleros (cedula, nombres, apellidos, telefono) VALUES ($1, $2, $3, $4) RETURNING id`,
      [cedula, nombres, apellidos, body.telefono || null]
    );
    return { success: true, data: { id: r.rows[0].id } };
  } catch (err) {
    if (err.code === '23505') return { success: false, error: 'Ya existe un planillero con esa cédula.' };
    throw err;
  }
}

async function editarPlanillero(pool, body) {
  const { planilleroId, nombres, apellidos, telefono, cedula } = body;
  try {
    await pool.query(
      `UPDATE sport_control.planilleros SET nombres = $1, apellidos = $2, telefono = $3, cedula = $4 WHERE id = $5`,
      [nombres, apellidos, telefono || null, cedula, planilleroId]
    );
    return { success: true };
  } catch (err) {
    if (err.code === '23505') return { success: false, error: 'Ya existe un planillero con esa cédula.' };
    throw err;
  }
}

async function togglePlanillero(pool, body) {
  await pool.query(`UPDATE sport_control.planilleros SET activo = $1 WHERE id = $2`, [!!body.activo, body.planilleroId]);
  return { success: true };
}

async function resetearClavePlanilleroAdmin(pool, body) {
  const { planilleroId } = body;
  const check = await pool.query(`SELECT id, nombres, telefono FROM sport_control.planilleros WHERE id = $1`, [planilleroId]);
  if (!check.rows[0]) return { success: false, error: 'No se encontró ese planillero.' };

  const claveTemporal = String(Math.floor(100000 + Math.random() * 900000));
  const hash = await bcrypt.hash(claveTemporal, 10);
  await pool.query(
    `UPDATE sport_control.planilleros
     SET clave_hash = $1, debe_cambiar_clave = true, clave_reset_expira = NOW() + INTERVAL '24 hours',
         intentos_fallidos = 0, bloqueado_hasta = NULL
     WHERE id = $2`,
    [hash, planilleroId]
  );

  const p = check.rows[0];
  const mensajeWhatsapp = `Hola ${p.nombres}, tu clave temporal para entrar a la app del club como planillero es: ${claveTemporal}\n\nEs válida por 24 horas y solo funciona una vez -- al ingresar con ella, la app te va a pedir crear tu clave definitiva.`;

  return { success: true, data: { claveTemporal, telefono: p.telefono, mensajeWhatsapp } };
}

module.exports = {
  listarPlanilleros, crearPlanillero, editarPlanillero, togglePlanillero, resetearClavePlanilleroAdmin,
};
