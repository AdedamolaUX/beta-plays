// ─── AI Szn Categorization ────────────────────────────────────────
// Runs AFTER keyword matching. Takes tokens that didn't match any
// known category and asks Claude two questions:
//
//   1. Does this token fit an existing category we know about?
//      (catches things like $WHISKERS → cats, $BARK → dogs)
//
//   2. If not, does it cluster with any other unmatched tokens
//      into a novel narrative worth surfacing as a new Szn?
//      (catches things like $GORK + $GORKFUND + $GORKCORE → 🦕 Gork Szn)
//
// Architecture mirrors Vector 8 (useAIBetaScoring.js):
//   - Runs async, non-blocking
//   - Batches 12 tokens per API call
//   - In-memory cache with 5-min TTL
//   - Returns via callback so keyword results show immediately

const ANTHROPIC_API_URL  = 'https://api.anthropic.com/v1/messages'
const BATCH_SIZE         = 12
const CACHE_TTL_MS       = 5 * 60 * 1000

// ─── Cache ───────────────────────────────────────────────────────
const categorizationCache = new Map()

const getCacheKey = (tokenAddresses) =>
  tokenAddresses.slice().sort().join(',')

// ─── Prompt builder ──────────────────────────────────────────────
// We send:
//   - The full list of known categories so Claude can match to them
//   - The unmatched tokens (symbol + name + description)
//
// Claude returns per-token: { index, category, newNarrative }
//   - category:     one of our known keys (e.g. 'cats') OR null
//   - newNarrative: { key, label, emoji } if it's something genuinely novel OR null

const buildCategorizationPrompt = (tokens, knownCategories) => {
  const categoryList = Object.entries(knownCategories)
    .map(([key, cat]) => `  "${key}": ${cat.label}`)
    .join('\n')

  const tokenList = tokens.map((t, i) => {
    const parts = [
      `[${i}] $${t.symbol}`,
      t.name        ? `name: "${t.name}"`               : null,
      t.description ? `description: "${t.description}"` : null,
    ].filter(Boolean).join(' | ')
    return parts
  }).join('\n')

  return `You are analyzing Solana meme tokens to detect narrative themes for a crypto analytics tool.

KNOWN NARRATIVE CATEGORIES:
${categoryList}

UNMATCHED TOKENS (did not match any keyword filter — categorize these):
${tokenList}

For each token, determine:
1. Does it fit one of the KNOWN categories above? (even if the name is unusual — use semantic understanding)
2. If not, does it belong to a genuinely novel narrative that should get its own category?

Rules:
- Be generous with existing categories. $WHISKERS → cats. $BARKY → dogs. $ZELENSKY → political.
- Only create a "newNarrative" if the token represents something that clearly doesn't fit anything above.
- newNarrative.key must be a short lowercase identifier (e.g. "gork", "foxes", "bears")
- newNarrative.label must be emoji + short name (e.g. "🦊 Foxes", "🦕 Gork")
- If a token is genuinely random with no clear theme, set both category and newNarrative to null.

Respond ONLY with a JSON array. No explanation, no markdown. Example:
[
  {"index":0,"category":"cats","newNarrative":null},
  {"index":1,"category":null,"newNarrative":{"key":"foxes","label":"🦊 Foxes"}},
  {"index":2,"category":null,"newNarrative":null}
]`
}

// ─── API call ─────────────────────────────────────────────────────
const callAnthropicAPI = async (prompt) => {
  const response = await fetch(ANTHROPIC_API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) throw new Error(`API error: ${response.status}`)

  const data  = await response.json()
  const text  = data.content?.filter(b => b.type === 'text')?.map(b => b.text)?.join('') || ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

// ─── Process a batch ─────────────────────────────────────────────
const categorizeBatch = async (tokens, knownCategories) => {
  if (!tokens.length) return []
  const prompt  = buildCategorizationPrompt(tokens, knownCategories)
  const results = await callAnthropicAPI(prompt)
  return results
    .filter(r => r.category || r.newNarrative)
    .map(r => ({
      token:         tokens[r.index],
      category:      r.category      || null,
      newNarrative:  r.newNarrative  || null,
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

  console.log(`[SznAI] Categorizing ${unmatchedTokens.length} unmatched tokens...`)

  // Batch the tokens
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

  // ── Split: existing category matches vs novel narratives ─────
  const categorized  = allResults.filter(r => r.category)
  const novelRaw     = allResults.filter(r => r.newNarrative)

  // ── Group novel tokens by narrative key ─────────────────────
  // Multiple tokens might share the same novel narrative
  // e.g. $GORK + $GORKFUND both get { key: 'gork', label: '🦕 Gork' }
  const novelMap = {}
  novelRaw.forEach(({ token, newNarrative }) => {
    const { key, label } = newNarrative
    if (!novelMap[key]) novelMap[key] = { key, label, tokens: [], totalVolume: 0, source: 'ai' }
    novelMap[key].tokens.push(token)
    novelMap[key].totalVolume += token.volume24h || 0
  })

  const novelGroups = Object.values(novelMap)

  console.log(`[SznAI] ${categorized.length} matched to existing categories, ${novelGroups.length} novel narratives found`)

  // Cache and return
  categorizationCache.set(cacheKey, { categorized, novelGroups, timestamp: Date.now() })
  onResults(categorized, novelGroups)
}

export default categorizeWithAI