// ─── BetaPlays — Supabase DB (server/db.js) ───────────────────────────────────
// Standard PostgreSQL via Supabase — using the `pg` package over TCP.
// Connects through Supabase's PgBouncer transaction pooler (port 6543).
// 200 max client connections vs Neon's 5 — no more timeout storms.
//
// Exports:
//   db.init()   — creates tables if they don't exist (called at boot)
//   db.query()  — thin wrapper around pool.query with error logging
//   db.pool     — raw Pool instance (for transactions if ever needed)
// ─────────────────────────────────────────────────────────────────────────────

const { Pool } = require('pg')

if (!process.env.DATABASE_URL) {
  console.warn('[DB] WARNING: DATABASE_URL not set — database features disabled')
}

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     20,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 8_000,
  ssl: process.env.DATABASE_URL?.includes('supabase')
    ? { rejectUnauthorized: false }
    : false,
})

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message)
})

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tokens (
    address      TEXT PRIMARY KEY,
    symbol       TEXT NOT NULL,
    name         TEXT,
    logo_url     TEXT,
    first_seen   TIMESTAMPTZ DEFAULT NOW(),
    last_seen    TIMESTAMPTZ DEFAULT NOW(),
    peak_mcap    NUMERIC DEFAULT 0,
    chain        TEXT DEFAULT 'solana'
  );

  CREATE TABLE IF NOT EXISTS alpha_runs (
    id               SERIAL PRIMARY KEY,
    token_address    TEXT NOT NULL,
    timestamp        TIMESTAMPTZ DEFAULT NOW(),
    mcap             NUMERIC,
    volume_24h       NUMERIC,
    price_change_24h NUMERIC,
    source           TEXT,
    price            NUMERIC
  );

  CREATE TABLE IF NOT EXISTS beta_relations (
    id                       SERIAL PRIMARY KEY,
    alpha_address            TEXT NOT NULL,
    beta_address             TEXT NOT NULL,
    signals                  TEXT[],
    score                    NUMERIC,
    relationship_type        TEXT,
    first_seen               TIMESTAMPTZ DEFAULT NOW(),
    last_seen                TIMESTAMPTZ DEFAULT NOW(),
    confirmed_count          INTEGER DEFAULT 1,
    beta_price_at_detection  NUMERIC,
    alpha_price_at_detection NUMERIC,
    beta_mcap_at_detection   NUMERIC,
    UNIQUE (alpha_address, beta_address)
  );

  CREATE TABLE IF NOT EXISTS narratives (
    id           SERIAL PRIMARY KEY,
    key          TEXT NOT NULL,
    label        TEXT NOT NULL,
    tokens       JSONB,
    total_volume NUMERIC,
    score        INTEGER,
    timestamp    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS telegram_signals (
    id            SERIAL PRIMARY KEY,
    alpha_symbol  TEXT,
    beta_symbol   TEXT,
    beta_address  TEXT,
    channel       TEXT,
    message_ts    TIMESTAMPTZ,
    confidence    NUMERIC DEFAULT 1.0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS server_cache (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    ttl_hours  NUMERIC DEFAULT 6
  );

  CREATE INDEX IF NOT EXISTS idx_server_cache_created ON server_cache(created_at);
  CREATE INDEX IF NOT EXISTS idx_alpha_runs_token     ON alpha_runs(token_address);
  CREATE INDEX IF NOT EXISTS idx_alpha_runs_ts        ON alpha_runs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_beta_alpha           ON beta_relations(alpha_address);
  CREATE INDEX IF NOT EXISTS idx_beta_last_seen       ON beta_relations(last_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_telegram_alpha       ON telegram_signals(alpha_symbol);
`

const MIGRATIONS = [
  `ALTER TABLE beta_relations ADD COLUMN IF NOT EXISTS beta_price_at_detection  NUMERIC`,
  `ALTER TABLE beta_relations ADD COLUMN IF NOT EXISTS alpha_price_at_detection NUMERIC`,
  `ALTER TABLE beta_relations ADD COLUMN IF NOT EXISTS beta_mcap_at_detection   NUMERIC`,
  `ALTER TABLE tokens         ADD COLUMN IF NOT EXISTS category                 TEXT`,
]

async function init () {
  if (!process.env.DATABASE_URL) return
  try {
    await pool.query(SCHEMA)
    for (const m of MIGRATIONS) {
      await pool.query(m)
    }
    console.log('[DB] Schema initialised (Supabase)')
  } catch (err) {
    console.error('[DB] Schema init failed:', err.message)
  }
}

async function query (text, params) {
  try {
    return await pool.query(text, params)
  } catch (err) {
    console.error('[DB] Query error:', err.message, '|', text.slice(0, 80))
    throw err
  }
}

async function cacheGet (key) {
  if (!process.env.DATABASE_URL) return null
  try {
    const result = await pool.query(
      `SELECT value FROM server_cache
       WHERE key = $1
         AND NOW() < created_at + (ttl_hours || ' hours')::INTERVAL`,
      [key]
    )
    return result.rows[0]?.value ?? null
  } catch { return null }
}

async function cacheSet (key, value, ttlHours = 6) {
  if (!process.env.DATABASE_URL) return
  try {
    await pool.query(
      `INSERT INTO server_cache (key, value, ttl_hours)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         value      = EXCLUDED.value,
         created_at = NOW(),
         ttl_hours  = EXCLUDED.ttl_hours`,
      [key, JSON.stringify(value), ttlHours]
    )
  } catch { /* non-fatal */ }
}

async function loadExpansionCache (expansionCache) {
  if (!process.env.DATABASE_URL) return 0
  try {
    const result = await pool.query(
      `SELECT key, value, created_at FROM server_cache
       WHERE key LIKE 'expansion:%'
         AND NOW() < created_at + (ttl_hours || ' hours')::INTERVAL`
    )
    let loaded = 0
    for (const row of result.rows) {
      const address = row.key.replace('expansion:', '')
      expansionCache.set(address, {
        data:      row.value,
        timestamp: new Date(row.created_at).getTime(),
        mcap:      row.value.mcap || 0,
      })
      loaded++
    }
    if (loaded > 0) console.log(`[DB] Loaded ${loaded} expansion entries from Supabase`)
    return loaded
  } catch (err) {
    console.error('[DB] loadExpansionCache failed:', err.message)
    return 0
  }
}

module.exports = { pool, init, query, cacheGet, cacheSet, loadExpansionCache }