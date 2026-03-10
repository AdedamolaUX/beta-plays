// ─── Vector 8: AI Relationship Classification ────────────────────
// Replaced pure scoring with classification — Vector 0 now generates
// semantically targeted search terms, so candidates are already
// relevant. Vector 8's job is to confirm and classify WHY each
// token is a beta, not just whether it is.
//
// Relationship types:
//   TWIN      — synonym/equivalent concept ($SHELTER for $HOUSECOIN)
//   COUNTER   — opposite side of same narrative ($LANDLORD for $HOUSECOIN)
//   ECHO      — narrative consequence ($EVICTION for $HOUSECOIN)
//   UNIVERSE  — same fictional/cultural world ($SASUKE for $NARUTO)
//   SECTOR    — same industry/space peer ($CURSOR for $CLAUDE)
//   EVIL_TWIN — dark/inverted variant ($DARKSHIBA for $SHIBA)
//   SPIN      — general derivative, weaker connection

const BACKEND_URL  = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const MIN_SCORE    = 0.45   // Lower than old threshold — Vector 0 pre-filters noise
const BATCH_SIZE   = 8
const CACHE_TTL_MS = 10 * 60 * 1000  // 10 min — longer than before, results are stable

const classifyCache = new Map()

const getCacheKey = (alphaAddress, betaAddresses) =>
  `${alphaAddress}:${[...betaAddresses].sort().join(',')}`

// ─── Classification prompt ────────────────────────────────────────
const buildClassificationPrompt = (alpha, candidates, relationshipHints = {}) => {
  const alphaContext = [
    `Symbol: $${alpha.symbol}`,
    alpha.name        ? `Name: ${alpha.name}`               : null,
    alpha.description ? `Description: ${alpha.description}` : null,
  ].filter(Boolean).join('\n')

  // Inject hints from Vector 0 to help classification
  const hintsText = Object.keys(relationshipHints).length > 0
    ? `\nNARRATIVE HINTS from concept expansion:\n${
        Object.entries(relationshipHints)
          .map(([term, type]) => `  "${term}" → ${type}`)
          .join('\n')
      }`
    : ''

  const candidateList = candidates.map((c, i) => [
    `[${i}] $${c.symbol}`,
    c.name        ? `    Name: ${c.name}`               : null,
    c.description ? `    Description: ${c.description}` : null,
  ].filter(Boolean).join('\n')).join('\n\n')

  return `You are analyzing Solana meme tokens to classify narrative relationships.

ALPHA TOKEN (the runner):
${alphaContext}${hintsText}

CANDIDATE TOKENS (potential betas):
${candidateList}

For each candidate:
1. Score narrative relatedness (0.0–1.0)
2. Classify the relationship type:
   TWIN      = synonym/equivalent concept
   COUNTER   = opposite side of same narrative
   ECHO      = narrative consequence or continuation
   UNIVERSE  = same fictional/cultural world
   SECTOR    = same industry/space peer
   EVIL_TWIN = dark, inverted, or evil variant of the alpha
   SPIN      = general derivative with weaker connection
3. One-sentence reason

Scoring guide:
  0.8–1.0: Strong — clear intentional connection
  0.6–0.79: Moderate — plausible narrative link
  0.45–0.59: Weak but possible — include with SPIN
  0.0–0.44: Unrelated — exclude

Respond ONLY with a JSON array. No explanation, no markdown:
[{"index":0,"score":0.92,"relationshipType":"TWIN","reason":"Direct synonym for house/shelter"},{"index":1,"score":0.2,"relationshipType":"SPIN","reason":"Unrelated"}]`
}

// ─── Call backend /api/score-betas ───────────────────────────────
const callBackend = async (prompt) => {
  const response = await fetch(`${BACKEND_URL}/api/score-betas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!response.ok) throw new Error(`Backend error: ${response.status}`)
  const data = await response.json()
  if (!Array.isArray(data)) throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 100)}`)
  return data
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const BATCH_DELAY_MS = 2500

// ─── Main classification function ────────────────────────────────
export const classifyRelationships = async (alpha, candidates, relationshipHints = {}) => {
  if (!alpha || !candidates?.length) return []

  const cacheKey = getCacheKey(
    alpha.address,
    candidates.map(c => c.address || c.id)
  )

  const cached = classifyCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[Vector8] Cache hit for $${alpha.symbol} — ${cached.results.length} classified`)
    return cached.results
  }

  console.log(`[Vector8] Classifying ${candidates.length} candidates for $${alpha.symbol}...`)

  const allClassified = []

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch    = candidates.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    if (i > 0) {
      console.log(`[Vector8] Throttling — waiting ${BATCH_DELAY_MS / 1000}s before batch ${batchNum}...`)
      await sleep(BATCH_DELAY_MS)
    }

    try {
      const prompt  = buildClassificationPrompt(alpha, batch, relationshipHints)
      const results = await callBackend(prompt)

      results
        .filter(r => r.score >= MIN_SCORE)
        .forEach(r => {
          allClassified.push({
            ...batch[r.index],
            aiScore:          r.score,
            relationshipType: r.relationshipType || 'SPIN',
            aiReason:         r.reason,
            signalSources:    [...(batch[r.index].signalSources || []), 'ai_match'],
          })
        })
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('rate')) {
        console.warn(`[Vector8] Rate limited on batch ${batchNum} — backing off 10s`)
        await sleep(10000)
        try {
          const prompt  = buildClassificationPrompt(alpha, batch, relationshipHints)
          const results = await callBackend(prompt)
          results
            .filter(r => r.score >= MIN_SCORE)
            .forEach(r => {
              allClassified.push({
                ...batch[r.index],
                aiScore:          r.score,
                relationshipType: r.relationshipType || 'SPIN',
                aiReason:         r.reason,
                signalSources:    [...(batch[r.index].signalSources || []), 'ai_match'],
              })
            })
        } catch (retryErr) {
          console.warn(`[Vector8] Retry failed for batch ${batchNum}:`, retryErr.message)
        }
      } else {
        console.warn(`[Vector8] Batch ${batchNum} failed:`, err.message)
      }
    }
  }

  const sorted = allClassified.sort((a, b) => b.aiScore - a.aiScore)
  classifyCache.set(cacheKey, { results: sorted, timestamp: Date.now() })
  console.log(`[Vector8] ${sorted.length} classified betas for $${alpha.symbol}`)

  return sorted
}

// ─── Backward compat alias ────────────────────────────────────────
// Legacy calls still work — classification is strictly better than scoring
export const scoreWithAI = (alpha, candidates) =>
  classifyRelationships(alpha, candidates, {})

export default classifyRelationships