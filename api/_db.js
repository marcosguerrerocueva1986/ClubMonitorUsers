// api/_db.js
// Conexion compartida a Postgres para las funciones serverless de Vercel.
//
// IMPORTANTE: en Vercel, cada funcion serverless puede arrancar en una
// instancia "fria" nueva, asi que usamos un pool con max:1 (una sola
// conexion por instancia) para no agotar el limite de conexiones de
// Postgres si hay muchas funciones corriendo a la vez. Es el patron
// recomendado para bases de datos tradicionales (no serverless-native)
// usadas desde funciones serverless.
//
// La variable de entorno DATABASE_URL se configura en:
// Vercel Dashboard -> tu proyecto -> Settings -> Environment Variables
// Valor: el mismo connection string de Postgres que ya usa n8n
// (ej: postgres://usuario:password@host:puerto/sport_control)

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

module.exports = { getPool };
