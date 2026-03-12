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
    `Symbol: ${alpha.symbol}`,  // No $ prefix — it's display-only, not a semantic signal
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
    `[${i}] ${c.symbol}`,  // No $ prefix
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

INVALID REASONING — these are NOT connections, always score 0.1 or below:
- "Both are cryptocurrencies / meme tokens / Solana tokens" — true of everything here, meaningless
- "Both reference monetary concepts / dollar signs / financial value" — the symbol prefix is a display convention shared by ALL tokens, it carries zero thematic meaning
- "Both have similar market caps / price action" — market data is not a narrative connection
- "Both relate to currency/money/wealth" — only valid if the ALPHA's actual theme is explicitly about money (e.g. alpha is named GOLD or WEALTH)

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

// ─── Process one batch and return results + scores ───────────────
const processBatch = async (alpha, batch, batchNum, relationshipHints) => {
  const prompt  = buildClassificationPrompt(alpha, batch, relationshipHints)
  const results = await callBackend(prompt)

  // Context-aware hallucination filter.
  // Monetary/financial reasons are only invalid when the alpha is NOT money-themed.
  const MONEY_ALPHA_KEYWORDS = [
    'gold','wealth','money','dollar','coin','cash','rich',
    'finance','bank','fund','capital','treasury','yield','profit','buck','dough'
  ]
  const alphaIsMoneyThemed = MONEY_ALPHA_KEYWORDS.some(kw =>
    alpha.symbol?.toLowerCase().includes(kw) ||
    alpha.name?.toLowerCase().includes(kw)
  )
  const ALWAYS_INVALID = [
    'dollar sign','both are crypto','both tokens are',
    'cryptocurrency','meme token','solana token','similar concept'
  ]
  const MONETARY_IF_NOT_THEMED = ['monetary','dollar','currency','financial']
  const isHallucination = (reason = '') => {
    const lower = reason.toLowerCase()
    if (ALWAYS_INVALID.some(p => lower.includes(p))) return true
    if (!alphaIsMoneyThemed && MONETARY_IF_NOT_THEMED.some(p => lower.includes(p))) return true
    return false
  }

  const classified      = []
  const rejectedInBatch = []

  // Log ALL scores for tuning — not just passing ones
  console.log(`[Vector8] Batch ${batchNum} scores for $${alpha.symbol}:`)
  results.forEach(r => {
    const candidate = batch[r.index]
    if (!candidate) return
    const pass = r.score >= MIN_SCORE && !isHallucination(r.reason)
    if (!pass && r.score >= MIN_SCORE) {
      console.log(`  🚫 $${candidate.symbol} — blocked hallucination: "${r.reason}"`)
    }
    console.log(
      `  ${pass ? '✅' : '❌'} $${candidate.symbol} — score: ${r.score} | type: ${r.relationshipType} | ${r.reason}`
    )
    if (pass) {
      classified.push({
        ...candidate,
        aiScore:          r.score,
        relationshipType: r.relationshipType || 'SPIN',
        aiReason:         r.reason,
        signalSources:    [...(candidate.signalSources || []), 'ai_match'],
      })
    } else {
      rejectedInBatch.push(candidate.address)
    }
  })

  // Any candidate not mentioned in results = AI skipped it = treat as rejected
  const mentionedIndices = new Set(results.map(r => r.index))
  batch.forEach((c, i) => {
    if (!mentionedIndices.has(i)) {
      console.log(`  ⚠️  $${c.symbol} — not scored by AI (skipped)`)
      rejectedInBatch.push(c.address)
    }
  })

  return { classified, rejectedInBatch }
}

// ─── Main classification function ────────────────────────────────
// Returns { results, rejectedAddresses } — caller uses rejectedAddresses
// to remove confirmed-noise tokens from the beta list.
export const classifyRelationships = async (alpha, candidates, relationshipHints = {}) => {
  if (!alpha || !candidates?.length) return { results: [], rejectedAddresses: new Set() }

  const cacheKey = getCacheKey(
    alpha.address,
    candidates.map(c => c.address || c.id)
  )

  const cached = classifyCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[Vector8] Cache hit for $${alpha.symbol} — ${cached.results.length} classified, ${cached.rejectedAddresses.size} rejected`)
    return { results: cached.results, rejectedAddresses: cached.rejectedAddresses }
  }

  console.log(`[Vector8] Classifying ${candidates.length} candidates for $${alpha.symbol}...`)

  const allClassified      = []
  const allRejectedAddrs   = new Set()

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch    = candidates.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    if (i > 0) {
      console.log(`[Vector8] Throttling — waiting ${BATCH_DELAY_MS / 1000}s before batch ${batchNum}...`)
      await sleep(BATCH_DELAY_MS)
    }

    try {
      const { classified, rejectedInBatch } = await processBatch(alpha, batch, batchNum, relationshipHints)
      allClassified.push(...classified)
      rejectedInBatch.forEach(addr => allRejectedAddrs.add(addr))
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('rate')) {
        console.warn(`[Vector8] Rate limited on batch ${batchNum} — backing off 10s`)
        await sleep(10000)
        try {
          const { classified, rejectedInBatch } = await processBatch(alpha, batch, batchNum, relationshipHints)
          allClassified.push(...classified)
          rejectedInBatch.forEach(addr => allRejectedAddrs.add(addr))
        } catch (retryErr) {
          console.warn(`[Vector8] Retry failed for batch ${batchNum}:`, retryErr.message)
          // Batch failed entirely — don't add to rejected (we simply don't know)
        }
      } else {
        console.warn(`[Vector8] Batch ${batchNum} failed:`, err.message)
        // Batch failed entirely — don't add to rejected (we simply don't know)
      }
    }
  }

  const sorted = allClassified.sort((a, b) => b.aiScore - a.aiScore)
  classifyCache.set(cacheKey, { results: sorted, rejectedAddresses: allRejectedAddrs, timestamp: Date.now() })
  console.log(`[Vector8] $${alpha.symbol} — ✅ ${sorted.length} confirmed, ❌ ${allRejectedAddrs.size} rejected`)

  return { results: sorted, rejectedAddresses: allRejectedAddrs }
}

// ─── Backward compat alias ────────────────────────────────────────
export const scoreWithAI = (alpha, candidates) =>
  classifyRelationships(alpha, candidates, {})

export default classifyRelationships