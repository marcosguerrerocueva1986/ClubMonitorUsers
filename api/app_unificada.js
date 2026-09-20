// api/app_unificada.js
//
// Backend de la app unica: login por cedula (una sola vez, sin elegir
// rol de antemano), deteccion de todos los roles que esa cedula tenga
// en el club, y el menu armado a partir del catalogo de pantallas.
//
// Diseño clave: las tablas jugadores/representantes/entrenadores NO
// se tocan ni se fusionan -- se consultan las 3 por cedula en cada
// login, y los roles se resuelven en vivo (nunca se cachean en la
// sesion) para que un cambio de rol se refleje de inmediato.

const bcrypt = require('bcryptjs');
const { getPool } = require('./_db');

const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

async function resolverSesion(pool, token) {
  const r = await pool.query(
    `SELECT s.cedula FROM (SELECT 1 AS ancla) d LEFT JOIN sport_control.sesiones_app s ON s.token = $1 LIMIT 1`,
    [token || '']
  );
  return r.rows[0] && r.rows[0].cedula;
}

async function crearSesion(pool, cedula) {
  const r = await pool.query(
    `INSERT INTO sport_control.sesiones_app (cedula, token) VALUES ($1, sport_control.generar_token_alfanumerico() || sport_control.generar_token_alfanumerico()) RETURNING token`,
    [cedula]
  );
  return r.rows[0].token;
}

// Busca la cedula en las 3 tablas de roles y arma el resumen de que
// roles tiene esa persona en el club. Esta es LA funcion central del
// login unificado -- todo lo demas se apoya en ella.
async function detectarRoles(pool, cedula) {
  const jugador = await pool.query(
    `SELECT id, nombres, apellidos, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.jugadores WHERE cedula = $1 AND estado = 'activo'`,
    [cedula]
  );
  const representante = await pool.query(
    `SELECT id, nombres, apellidos, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.representantes WHERE cedula = $1`,
    [cedula]
  );
  const entrenador = await pool.query(
    `SELECT id, nombres, apellidos, rol, clave_hash, debe_cambiar_clave, clave_reset_expira, intentos_fallidos, bloqueado_hasta
     FROM sport_control.entrenadores WHERE cedula = $1 AND activo = true`,
    [cedula]
  );

  const roles = [];
  if (jugador.rows[0]) roles.push('jugador');
  if (representante.rows[0]) roles.push('representante');
  if (entrenador.rows[0]) {
    roles.push('entrenador');
    if (entrenador.rows[0].rol === 'director') roles.push('director');
  }

  return {
    encontrado: roles.length > 0,
    roles,
    jugador: jugador.rows[0] || null,
    representante: representante.rows[0] || null,
    entrenador: entrenador.rows[0] || null,
    // nombre para el saludo: el primero que se encuentre disponible
    nombres: (jugador.rows[0] || representante.rows[0] || entrenador.rows[0] || {}).nombres,
  };
}

// La clave es UNA sola por persona, aunque tenga varios roles. Si ya
// existe un hash en cualquiera de las 3 tablas, ese es "el oficial".
function encontrarClaveExistente(info) {
  for (const registro of [info.representante, info.entrenador, info.jugador]) {
    if (registro && registro.clave_hash) return registro;
  }
  return null;
}

async function loginUnificado(pool, body) {
  const cedula = String(body.cedula || '').trim();
  if (!cedula) return { success: false, error: 'Ingresa tu cédula.' };

  const info = await detectarRoles(pool, cedula);
  if (!info.encontrado) return { success: true, data: { registrado: false } };

  const claveExistente = encontrarClaveExistente(info);
  if (claveExistente && claveExistente.bloqueado_hasta && new Date(claveExistente.bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }

  return { success: true, data: { registrado: true, tieneClave: !!claveExistente, nombres: info.nombres, roles: info.roles } };
}

async function crearClaveUnificada(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();
  if (!/^\d{6}$/.test(clave)) return { success: false, error: 'La clave debe ser de exactamente 6 números.' };

  const info = await detectarRoles(pool, cedula);
  if (!info.encontrado) return { success: false, error: 'No se encontró esa cédula.' };
  if (encontrarClaveExistente(info)) return { success: false, error: 'Ya tienes una clave creada. Ingrésala para entrar.' };

  const hash = await bcrypt.hash(clave, 10);
  // Se replica el mismo hash a TODAS las tablas donde esta cedula
  // tenga un registro -- una sola clave sirve para todos sus roles.
  if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.jugador.id]);
  if (info.representante) await pool.query(`UPDATE sport_control.representantes SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.representante.id]);
  if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET clave_hash = $1, debe_cambiar_clave = false WHERE id = $2`, [hash, info.entrenador.id]);

  const token = await crearSesion(pool, cedula);
  return { success: true, data: { token, nombres: info.nombres, roles: info.roles } };
}

async function verificarClaveUnificada(pool, body) {
  const cedula = String(body.cedula || '').trim();
  const clave = String(body.clave || '').trim();

  const info = await detectarRoles(pool, cedula);
  if (!info.encontrado) return { success: false, error: 'No se encontró esa cédula.' };

  const registroClave = encontrarClaveExistente(info);
  if (!registroClave) return { success: false, error: 'Todavía no tienes una clave creada.' };

  if (registroClave.bloqueado_hasta && new Date(registroClave.bloqueado_hasta) > new Date()) {
    return { success: false, error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos, o pide al Admin que te resetee la clave.' };
  }
  if (registroClave.debe_cambiar_clave && registroClave.clave_reset_expira && new Date(registroClave.clave_reset_expira) < new Date()) {
    return { success: false, error: 'Tu clave temporal ya venció. Pídele al Admin que te genere una nueva.' };
  }

  const coincide = await bcrypt.compare(clave, registroClave.clave_hash);

  // Los intentos fallidos y el bloqueo se llevan por persona (cedula),
  // asi que se actualizan en TODAS las tablas donde tenga registro,
  // para que quede consistente sin importar por cual rol entro.
  const actualizarIntentos = async (intentos, bloqueadoHasta) => {
    if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.jugador.id]);
    if (info.representante) await pool.query(`UPDATE sport_control.representantes SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.representante.id]);
    if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`, [intentos, bloqueadoHasta, info.entrenador.id]);
  };

  if (!coincide) {
    const intentos = registroClave.intentos_fallidos + 1;
    if (intentos >= MAX_INTENTOS) {
      const bloqueadoHasta = new Date(Date.now() + MINUTOS_BLOQUEO * 60000);
      await actualizarIntentos(0, bloqueadoHasta);
      return { success: false, error: `Demasiados intentos fallidos. Espera ${MINUTOS_BLOQUEO} minutos o pide al Admin que te resetee la clave.` };
    }
    await actualizarIntentos(intentos, null);
    return { success: false, error: 'Clave incorrecta.' };
  }

  await actualizarIntentos(0, null);
  const token = await crearSesion(pool, cedula);
  return { success: true, data: { token, nombres: info.nombres, roles: info.roles, debeCambiarClave: registroClave.debe_cambiar_clave } };
}

async function cambiarClaveUnificada(pool, cedula, body) {
  const claveActual = String(body.claveActual || '').trim();
  const claveNueva = String(body.claveNueva || '').trim();
  if (!/^\d{6}$/.test(claveNueva)) return { success: false, error: 'La clave nueva debe ser de exactamente 6 números.' };

  const info = await detectarRoles(pool, cedula);
  const registroClave = encontrarClaveExistente(info);
  if (!registroClave || !(await bcrypt.compare(claveActual, registroClave.clave_hash))) {
    return { success: false, error: 'Tu clave actual no es correcta.' };
  }

  const hash = await bcrypt.hash(claveNueva, 10);
  if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.jugador.id]);
  if (info.representante) await pool.query(`UPDATE sport_control.representantes SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.representante.id]);
  if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET clave_hash = $1, debe_cambiar_clave = false, clave_reset_expira = NULL WHERE id = $2`, [hash, info.entrenador.id]);

  return { success: true };
}

// Devuelve los roles + IDs vigentes de la sesion actual (se resuelve
// en vivo, nunca se guarda cacheado) y el menu que le corresponde.
async function obtenerSesionYMenu(pool, cedula) {
  const info = await detectarRoles(pool, cedula);
  const roles = info.roles;
  const menu = await listarPantallasParaRoles(pool, roles);
  return {
    success: true,
    data: {
      roles,
      jugadorId: info.jugador ? info.jugador.id : null,
      representanteId: info.representante ? info.representante.id : null,
      entrenadorId: info.entrenador ? info.entrenador.id : null,
      nombres: info.nombres,
      menu: menu.data,
    },
  };
}

async function obtenerPerfilUnificado(pool, cedula) {
  const info = await detectarRoles(pool, cedula);
  const registro = info.representante || info.entrenador || info.jugador;
  const telRow = await pool.query(
    `SELECT telefono FROM sport_control.representantes WHERE cedula = $1
     UNION ALL SELECT telefono FROM sport_control.entrenadores WHERE cedula = $1
     UNION ALL SELECT telefono FROM sport_control.jugadores WHERE cedula = $1
     LIMIT 1`,
    [cedula]
  );
  return {
    success: true,
    data: {
      cedula,
      nombres: registro.nombres,
      apellidos: registro.apellidos,
      telefono: telRow.rows[0] ? telRow.rows[0].telefono : null,
      roles: info.roles,
    },
  };
}

async function actualizarPerfilUnificado(pool, cedula, body) {
  const { nombres, apellidos, telefono } = body;
  const info = await detectarRoles(pool, cedula);
  if (info.jugador) await pool.query(`UPDATE sport_control.jugadores SET nombres = $1, apellidos = $2 WHERE id = $3`, [nombres, apellidos, info.jugador.id]);
  if (info.representante) await pool.query(`UPDATE sport_control.representantes SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [nombres, apellidos, telefono || null, info.representante.id]);
  if (info.entrenador) await pool.query(`UPDATE sport_control.entrenadores SET nombres = $1, apellidos = $2, telefono = $3 WHERE id = $4`, [nombres, apellidos, telefono || null, info.entrenador.id]);
  return { success: true };
}

async function listarPantallasParaRoles(pool, roles) {
  if (!roles || roles.length === 0) return { success: true, data: [] };
  const r = await pool.query(
    `SELECT DISTINCT p.id, p.clave, p.etiqueta, p.icono, p.archivo_pantalla AS "archivoPantalla", p.orden
     FROM sport_control.pantallas_menu p
     JOIN sport_control.pantalla_rol pr ON pr.pantalla_id = p.id
     WHERE p.activa = true AND pr.habilitado = true AND pr.rol = ANY($1::text[])
     ORDER BY p.orden ASC`,
    [roles]
  );
  return { success: true, data: r.rows };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Metodo no permitido' });
  const body = req.body || {};
  const { accion, token } = body;
  const pool = getPool();

  try {
    if (accion === 'login_unificado') return res.status(200).json(await loginUnificado(pool, body));
    if (accion === 'crear_clave_unificada') return res.status(200).json(await crearClaveUnificada(pool, body));
    if (accion === 'verificar_clave_unificada') return res.status(200).json(await verificarClaveUnificada(pool, body));

    const cedula = await resolverSesion(pool, token);
    if (!cedula) return res.status(200).json({ success: false, error: 'Sesion invalida o expirada' });

    if (accion === 'cambiar_clave_unificada') return res.status(200).json(await cambiarClaveUnificada(pool, cedula, body));
    if (accion === 'obtener_sesion_y_menu') return res.status(200).json(await obtenerSesionYMenu(pool, cedula));
    if (accion === 'obtener_perfil_unificado') return res.status(200).json(await obtenerPerfilUnificado(pool, cedula));
    if (accion === 'actualizar_perfil_unificado') return res.status(200).json(await actualizarPerfilUnificado(pool, cedula, body));

    // Endpoint de prueba de la Fase 1 -- se mantiene por compatibilidad
    if (accion === 'listar_pantallas_para_roles_prueba') {
      const roles = Array.isArray(body.roles) ? body.roles : [];
      return res.status(200).json(await listarPantallasParaRoles(pool, roles));
    }

    return res.status(200).json({ success: false, error: 'Accion no reconocida' });
  } catch (err) {
    console.error(`Error en /api/app_unificada (accion=${accion}):`, err);
    return res.status(200).json({ success: false, error: 'Error interno: ' + (err && err.message ? err.message : String(err)) });
  }
};

module.exports.listarPantallasParaRoles = listarPantallasParaRoles;

