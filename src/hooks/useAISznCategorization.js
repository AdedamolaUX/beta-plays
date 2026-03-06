// ─── AI Szn Categorization ────────────────────────────────────────
// Runs AFTER keyword matching. Takes tokens that didn't match any
// known category and asks the backend (Groq / Llama 3.3 70B) to:
//
//   1. Match to existing narrative categories (semantic understanding)
//      e.g. $WHISKERS → cats, $BARK → dogs
//
//   2. Detect novel narratives worth surfacing as a new Szn
//      e.g. $GORK + $GORKFUND → 🦕 Gork Szn
//
// Architecture:
//   - Calls backend /api/categorize-szn (no API keys in frontend)
//   - Batches 12 tokens per call
//   - localStorage cache with 24h TTL — survives page refreshes
//   - Individual token results cached by address — new tokens don't
//     invalidate results for tokens we've already categorized
//   - Returns via callback so keyword results show immediately

const BACKEND_URL  = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const BATCH_SIZE   = 12
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h — narratives don't change daily
const LS_KEY       = 'betaplays_szn_cache_v1'

// ─── localStorage cache helpers ──────────────────────────────────
// Stores results per individual token address so a new token joining
// the feed doesn't force re-categorization of everything else.

const loadCache = () => {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const saveCache = (cache) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache))
  } catch {
    // localStorage full — not a fatal error, just skip persisting
  }
}

const isFresh = (entry) =>
  entry && (Date.now() - entry.timestamp) < CACHE_TTL_MS

// ─── Process a batch ─────────────────────────────────────────────
const categorizeBatch = async (tokens, knownCategories) => {
  if (!tokens.length) return []

  const response = await fetch(`${BACKEND_URL}/api/categorize-szn`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ tokens, knownCategories }),
  })

  if (!response.ok) throw new Error(`Backend error: ${response.status}`)

  const results = await response.json()
  return results
    .filter(r => r.category || r.newNarrative)
    .map(r => ({
      token:        tokens[r.index],
      category:     r.category     || null,
      newNarrative: r.newNarrative || null,
    }))
}

// ─── Main export ─────────────────────────────────────────────────
// Takes:
//   unmatchedTokens  — tokens keyword matching didn't catch
//   knownCategories  — the NARRATIVE_CATEGORIES object from lore_map
//   onResults        — callback(categorized, novelGroups)
//
// categorized:  [{ token, category }]     — slot into existing Szn cards
// novelGroups:  [{ key, label, tokens }]  — brand new Szn cards to surface

export const categorizeWithAI = async (unmatchedTokens, knownCategories, onResults) => {
  if (!unmatchedTokens || unmatchedTokens.length === 0) return

  const cache = loadCache()

  // ── Split into cached vs truly new ───────────────────────────────
  const cachedResults = []
  const needsGroq     = []

  unmatchedTokens.forEach(token => {
    const key   = token.address || token.symbol
    const entry = cache[key]
    if (isFresh(entry)) {
      cachedResults.push({ token, category: entry.category, newNarrative: entry.newNarrative })
    } else {
      needsGroq.push(token)
    }
  })

  const cacheHits = cachedResults.filter(r => r.category || r.newNarrative)

  if (needsGroq.length === 0) {
    // Everything was cached — return immediately, no Groq call
    console.log(`[SznAI] Full cache hit — ${cacheHits.length} categorized (0 Groq calls)`)
    const { categorized, novelGroups } = assembleResults(cachedResults)
    onResults(categorized, novelGroups)
    return
  }

  console.log(`[SznAI] ${needsGroq.length} new tokens need Groq (${cachedResults.length} served from cache)`)

  // ── Call Groq for uncached tokens only ───────────────────────────
  const batches = []
  for (let i = 0; i < needsGroq.length; i += BATCH_SIZE) {
    batches.push(needsGroq.slice(i, i + BATCH_SIZE))
  }

  const batchResults = await Promise.allSettled(
    batches.map(batch => categorizeBatch(batch, knownCategories))
  )

  const newResults = batchResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)

  // ── Persist new results to localStorage ──────────────────────────
  newResults.forEach(({ token, category, newNarrative }) => {
    const key  = token.address || token.symbol
    cache[key] = { category, newNarrative, timestamp: Date.now() }
  })

  // Also cache tokens that got no result (so we don't retry them)
  needsGroq.forEach(token => {
    const key = token.address || token.symbol
    if (!cache[key]) {
      cache[key] = { category: null, newNarrative: null, timestamp: Date.now() }
    }
  })

  saveCache(cache)

  const allResults = [...cachedResults, ...newResults]
  const { categorized, novelGroups } = assembleResults(allResults)

  console.log(`[SznAI] ${categorized.length} categorized, ${novelGroups.length} novel narratives`)
  onResults(categorized, novelGroups)
}

// ─── Assemble final results ───────────────────────────────────────
const assembleResults = (allResults) => {
  const categorized = allResults.filter(r => r.category)
  const novelRaw    = allResults.filter(r => r.newNarrative)

  const novelMap = {}
  novelRaw.forEach(({ token, newNarrative }) => {
    const { key, label } = newNarrative
    if (!novelMap[key]) novelMap[key] = { key, label, tokens: [], totalVolume: 0, source: 'ai' }
    novelMap[key].tokens.push(token)
    novelMap[key].totalVolume += token.volume24h || 0
  })

  return { categorized, novelGroups: Object.values(novelMap) }
}

export default categorizeWithAI