// config/database.js — Connexion PostgreSQL
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
    await runMigrations();
  } catch (err) {
    console.error('[DB] Échec connexion:', err.message);
    throw err;
  }
}

async function runMigrations() {
  try {
    // ── Users : colonnes auth ────────────────────────────
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS reset_token TEXT,
      ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'basic';
    `);

    // ── Users : colonnes crédits et abonnement ───────────
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS abonnement TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS abonnement_quota INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS abonnement_fournisseurs_restants INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS abonnement_reset_date DATE DEFAULT NULL;
    `);

    // ── Refresh tokens ───────────────────────────────────
    await pool.query(`
      ALTER TABLE refresh_tokens
      ADD COLUMN IF NOT EXISTS token TEXT,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS user_id UUID;
    `);

    // ── Audit files : colonne paid ───────────────────────
    await pool.query(`
      ALTER TABLE audit_files
      ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT false;
    `);

    console.log('[DB] Migrations OK');
  } catch (err) {
    console.error('[DB] Erreur migration:', err.message);
  }
}

async function queryWithTenant(tenantId, text, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
