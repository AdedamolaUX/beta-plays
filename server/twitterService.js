// ─── BetaPlays — Twitter/X Service (Vector 11) ────────────────────
// Social Signal Intelligence — Twitter/X beta signal
//
// STATUS: STUB ONLY — returns [] until credentials added to .env
//
// Same architecture as telegramService (Vector 10).
// Activates automatically when any of these are added to server/.env:
//
//   Option A — X API Basic ($100/mo):
//     TWITTER_BEARER_TOKEN=your_bearer_token
//
//   Option B — twscrape Python sidecar (free, grey area):
//     TWITTER_SCRAPER_MODE=true
//
//   Option C — Playwright browser automation (last resort):
//     TWITTER_PLAYWRIGHT_MODE=true
//
// Until then, /api/twitter-betas returns { symbol, results: [] }
// and the frontend simply gets no Twitter signal — no errors, no crashes.
//
// When activated, extraction logic mirrors Vector 10 exactly:
//   - $ prefix required for beta identification
//   - Known alpha list for alpha identification (no $ needed)
//   - Same quality filters (liq, mint, freeze, txns, age)
//   - Same concept grouping + runner selection
//   - Same momentum score formula
//   - Signal tag: twitter_signal
//   - Badge: 🐦 TWITTER (pulsing blue)
// ──────────────────────────────────────────────────────────────────

// ─── Activation check ────────────────────────────────────────────
function isActivated () {
  return !!(
    process.env.TWITTER_BEARER_TOKEN ||
    process.env.TWITTER_SCRAPER_MODE ||
    process.env.TWITTER_PLAYWRIGHT_MODE
  )
}

// ─── Stub state ───────────────────────────────────────────────────
let knownAlphas = []

// ─── Public interface (mirrors telegramService exactly) ───────────

function updateKnownAlphas (alphas) {
  if (!Array.isArray(alphas)) return
  knownAlphas = alphas
  // When activated: feed alpha list to whichever scraper/API is running
}

function getTwitterBetas (symbol) {
  if (!symbol) return []
  if (!isActivated()) return []
  // When activated: read from in-memory cache, same pattern as telegramService
  return []
}

async function init () {
  if (!isActivated()) {
    console.log('[TwitterService] No credentials found — Vector 11 standing by (stub mode)')
    console.log('[TwitterService] To activate, add one of these to server/.env:')
    console.log('  TWITTER_BEARER_TOKEN=...  (X API Basic — $100/mo)')
    console.log('  TWITTER_SCRAPER_MODE=true (twscrape — free, grey area)')
    return
  }

  // Placeholder for when credentials are added
  console.log('[TwitterService] Credentials detected — activation logic not yet implemented')
  console.log('[TwitterService] Build out the scraper/API integration here when ready')
}

async function shutdown () {
  // Nothing to clean up in stub mode
}

module.exports = {
  init,
  shutdown,
  getTwitterBetas,
  updateKnownAlphas,
}