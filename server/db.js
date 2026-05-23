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
  max:                     3,   // keep low — multiple Render instances share the 200 connection limit
  idleTimeoutMillis:       10_000,
  connectionTimeoutMillis: 5_000,
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
  // Session 30 — parent map
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS parent_address TEXT`,
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS parent_symbol  TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_parent ON tokens(parent_address)`,
  // Session 30 — mcap_at_first_seen column for peakMarketCap accuracy
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mcap_at_first_seen NUMERIC DEFAULT 0`,
  // Session 30 — revival state persistence
  `ALTER TABLE alpha_runs ADD COLUMN IF NOT EXISTS is_revival BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE alpha_runs ADD COLUMN IF NOT EXISTS recovery_pct NUMERIC`,
  // Session 30 — liquidity needed for detectReversal
  `ALTER TABLE alpha_runs ADD COLUMN IF NOT EXISTS liquidity NUMERIC`,
  // Session 30 — permanent historical performance columns on tokens table
  // These survive alpha_runs cleanup — one row per token, updated incrementally.
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS ath_mcap          NUMERIC`,
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS ath_at            TIMESTAMPTZ`,
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS ath_price         NUMERIC`,
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS beta_count_at_ath INTEGER DEFAULT 0`,
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS first_run_at      TIMESTAMPTZ`,
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_run_at       TIMESTAMPTZ`,
  `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS total_run_count   INTEGER DEFAULT 0`,
  // Session 30 — community flags
  `CREATE TABLE IF NOT EXISTS token_flags (
    id         SERIAL PRIMARY KEY,
    address    TEXT NOT NULL,
    symbol     TEXT,
    flag_type  TEXT NOT NULL CHECK (flag_type IN ('rug','honeypot','not_beta')),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flags_address ON token_flags(address)`,
  // Session 30 — nominations
  `CREATE TABLE IF NOT EXISTS nominations (
    id          SERIAL PRIMARY KEY,
    address     TEXT NOT NULL UNIQUE,
    symbol      TEXT,
    name        TEXT,
    note        TEXT,
    status      TEXT DEFAULT 'pending',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )`,
  // Session 31 — wallet auth users
  `CREATE TABLE IF NOT EXISTS users (
    wallet_address TEXT PRIMARY KEY,
    first_seen     TIMESTAMPTZ DEFAULT NOW(),
    last_seen      TIMESTAMPTZ DEFAULT NOW(),
    display_name   TEXT
  )`,
  // Session 31 — watchlist (per wallet, shared across devices)
  `CREATE TABLE IF NOT EXISTS watchlist (
    id             SERIAL PRIMARY KEY,
    wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
    token_address  TEXT NOT NULL,
    symbol         TEXT,
    name           TEXT,
    added_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (wallet_address, token_address)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON watchlist(wallet_address)`,
  // Session 31 — Folios: price tracking + display fields on watchlist
  `ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS price_at_add    NUMERIC`,
  `ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS logo_url        TEXT`,
  `ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS mcap_at_add     NUMERIC`,
  `ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS narrative_tag   TEXT`,
  // Session 31 — Folios: public calls table (separate from private watchlist)
  `CREATE TABLE IF NOT EXISTS folio (
    id               SERIAL PRIMARY KEY,
    wallet_address   TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
    token_address    TEXT NOT NULL,
    symbol           TEXT,
    name             TEXT,
    logo_url         TEXT,
    price_at_call    NUMERIC,
    mcap_at_call     NUMERIC,
    called_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (wallet_address, token_address)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_folio_wallet ON folio(wallet_address)`,
  `CREATE INDEX IF NOT EXISTS idx_folio_called ON folio(called_at DESC)`,
  // Session 31 — narrative tags on folio calls
  `ALTER TABLE folio ADD COLUMN IF NOT EXISTS narrative_tag TEXT`,
  // Session 31 — folio profile fields
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS folio_bio     TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS folio_public  BOOLEAN DEFAULT TRUE`,
]

async function init () {
  if (!process.env.DATABASE_URL) return
  // Retry up to 3 times on connection errors
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query(SCHEMA)
      for (const m of MIGRATIONS) {
        try { await pool.query(m) } catch (me) {
          // Ignore "already exists" errors, log others
          if (!me.message.includes('already exists')) console.warn('[DB] Migration warning:', me.message)
        }
      }
      console.log('[DB] Schema initialised (Supabase)')

      // Cleanup old alpha_runs rows
      try {
        const cleaned = await pool.query(`
          DELETE FROM alpha_runs
          WHERE timestamp < NOW() - INTERVAL '30 days'
            AND id NOT IN (
              SELECT DISTINCT ON (token_address, DATE_TRUNC('month', timestamp))
                id
              FROM alpha_runs
              WHERE timestamp < NOW() - INTERVAL '30 days'
              ORDER BY token_address, DATE_TRUNC('month', timestamp), mcap DESC NULLS LAST
            )
        `)
        if (cleaned.rowCount > 0) {
          console.log(`[DB] Cleaned ${cleaned.rowCount} alpha_runs rows — monthly snapshots preserved`)
        }
      } catch (cleanErr) {
        console.warn('[DB] Cleanup failed (non-fatal):', cleanErr.message)
      }
      return // success
    } catch (err) {
      console.error(`[DB] Schema init failed (attempt ${attempt}/3):`, err.message)
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt))
    }
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