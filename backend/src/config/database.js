// config/database.js — Connexion PostgreSQL (Supabase)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Erreur pool inattendue:', err.message);
});

async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('[DB] Connexion PostgreSQL OK');
  } catch (err) {
    console.error('[DB] Échec connexion:', err.message);
    throw err;
  }
}

// Helper : exécuter une requête avec le tenant_id injecté dans la session
// Cela active les politiques Row-Level Security de PostgreSQL
async function queryWithTenant(tenantId, text, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Injection du tenant pour les politiques RLS
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, testConnection, queryWithTenant };
