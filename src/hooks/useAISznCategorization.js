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
//   - In-memory cache with 5-min TTL
//   - Returns via callback so keyword results show immediately

const BACKEND_URL  = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const BATCH_SIZE   = 12
const CACHE_TTL_MS = 5 * 60 * 1000

// ─── Cache ───────────────────────────────────────────────────────
const categorizationCache = new Map()

const getCacheKey = (tokenAddresses) =>
  tokenAddresses.slice().sort().join(',')

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

  const cacheKey = getCacheKey(unmatchedTokens.map(t => t.address || t.symbol))
  const cached   = categorizationCache.get(cacheKey)

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[SznAI] Cache hit — ${cached.categorized.length} categorized, ${cached.novelGroups.length} novel narratives`)
    onResults(cached.categorized, cached.novelGroups)
    return
  }

  console.log(`[SznAI] Categorizing ${unmatchedTokens.length} unmatched tokens via Groq...`)

  const batches = []
  for (let i = 0; i < unmatchedTokens.length; i += BATCH_SIZE) {
    batches.push(unmatchedTokens.slice(i, i + BATCH_SIZE))
  }

  const batchResults = await Promise.allSettled(
    batches.map(batch => categorizeBatch(batch, knownCategories))
  )

  const allResults = batchResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)

  const categorized = allResults.filter(r => r.category)
  const novelRaw    = allResults.filter(r => r.newNarrative)

  // Group novel tokens by narrative key
  const novelMap = {}
  novelRaw.forEach(({ token, newNarrative }) => {
    const { key, label } = newNarrative
    if (!novelMap[key]) novelMap[key] = { key, label, tokens: [], totalVolume: 0, source: 'ai' }
    novelMap[key].tokens.push(token)
    novelMap[key].totalVolume += token.volume24h || 0
  })

  const novelGroups = Object.values(novelMap)

  console.log(`[SznAI] ${categorized.length} matched to existing categories, ${novelGroups.length} novel narratives found`)

  categorizationCache.set(cacheKey, { categorized, novelGroups, timestamp: Date.now() })
  onResults(categorized, novelGroups)
}

export default categorizeWithAI