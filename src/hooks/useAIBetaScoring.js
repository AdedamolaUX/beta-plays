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
  // Description is the most reliable signal — it tells us what the token
  // actually IS, not just what its symbol pattern suggests.
  // When present, it becomes the explicit narrative frame: the AI must classify
  // candidates in the context of the DESCRIPTION, not the symbol alone.
  // This prevents hallucination like $LANDLORD scoring as a COUNTER for $HUGH
  // (a raccoon) just because "HUGH" superficially resembles "HOUSE".
  const alphaContext = alpha.description
    ? [
        `Symbol: ${alpha.symbol}`,
        alpha.name && alpha.name.toLowerCase() !== alpha.symbol.toLowerCase()
          ? `Name: ${alpha.name}` : null,
        `
⚠️  NARRATIVE FRAME — evaluate candidates two ways:

1. WORD-BY-WORD: Decompose the description into individual concepts first.
   "${alpha.description}"
   Each word is a separate concept. A candidate matching ANY ONE is a valid beta:
   - Matches all concepts → strong beta (0.8-1.0)
   - Matches one or some concepts → moderate beta (0.5-0.7, classify as UNIVERSE or SECTOR)
   - Matches no concepts at all → reject (0.1)

2. WHOLE PHRASE: Also evaluate the description as a unified concept.
   What does the full phrase mean together? What cultural/thematic world does it reference?
   A candidate fitting that whole-phrase meaning is also a valid beta even if it
   doesn't match any individual word.

Both evaluations run. The higher score wins.`,
      ].filter(Boolean).join('\n')
    : [
        `Symbol: ${alpha.symbol}`,
        alpha.name ? `Name: ${alpha.name}` : null,
      ].filter(Boolean).join('\n')

  // Inject hints from Vector 0 — but only when they don't contradict the description.
  // If a description exists, hints are secondary: the description is ground truth.
  // Mark them clearly so the AI knows they are suggestions, not facts.
  const hintsText = Object.keys(relationshipHints).length > 0
    ? `\n${alpha.description
        ? 'SUPPLEMENTARY HINTS (lower priority than the description above — discard any hint that contradicts the narrative frame):'
        : 'NARRATIVE HINTS from concept expansion:'
      }\n${
        Object.entries(relationshipHints)
          .map(([term, type]) => `  "${term}" → ${type}`)
          .join('\n')
      }`
    : ''

  const candidateList = candidates.map((c, i) => {
    const lines = [
      `[${i}] ${c.symbol}`,
      c.name        ? `    Name: ${c.name}`               : null,
      c.description ? `    Description: ${c.description}` : null,
    ]
    // Show which signals found this candidate — helps AI weight accordingly.
    // e.g. "found by: keyword, lore" vs "found by: og_match" tells the AI
    // whether the match is structural/on-chain or just text-similarity-based.
    if (c.signalSources?.length) {
      const readable = c.signalSources
        .filter(s => !['ai_match','visual_match'].includes(s))  // exclude meta signals
        .join(', ')
      if (readable) lines.push(`    Found by: ${readable}`)
    }
    // Pass visual signal to AI if vision ran on this candidate.
    if (c.visualScore != null) {
      const strength = c.visualScore >= 0.7 ? 'STRONG' : 'MODERATE'
      lines.push(
        `    🔍 VISUAL SIGNAL (${strength}, score: ${c.visualScore.toFixed(2)}): "${c.visualReason || 'logo visually related to alpha'}"`
      )
    }
    return lines.filter(Boolean).join('\n')
  }).join('\n\n')

  return `You are classifying narrative relationships between Solana meme tokens.
Your job: identify genuine beta plays — tokens whose concept, character, or narrative
is meaningfully derived from, opposed to, or part of the same universe as the alpha.

ALPHA TOKEN:
${alphaContext}${hintsText}

CANDIDATE TOKENS:
${candidateList}

RELATIONSHIP TYPES — pick the best fit:
  TWIN      = same concept, synonym, or equivalent — different token, same idea
              Examples: $PEPE → $PEEPO, $FROG, $KERMIT | $LOL → $LMAO, $HAHA, $GIGGLE
  COUNTER   = opposite pole of the same narrative — exists BECAUSE the alpha exists
              Examples: $PEPE → $WOJAK, $CHAD | $BULL → $BEAR | $PUMP → $DUMP
              Key test: would traders think of this token WHEN the alpha pumps?
  ECHO      = consequence, child, or continuation of the same narrative
              Examples: $TRUMP → $MAGA, $MELANIA | $PEPE → $PEPEWIF, $BABYPEPE
  UNIVERSE  = same fictional world, franchise, or cultural reference
              Examples: $BATMAN → $JOKER, $ROBIN | $MARIO → $LUIGI, $BOWSER
  SECTOR    = same thematic category but not directly related
              Examples: $WIF → $BONK (both dog coins) | $GPT → $CLAUDE (both AI)
  EVIL_TWIN = explicitly dark/inverted version — description must confirm it
  SPIN      = loose or weak derivative — include if score ≥ 0.45, exclude below

For each candidate:
1. Read the description carefully — it often reveals the exact narrative intent
   ("the laughter token" for $LOL confirms TWIN for other emotion/humor tokens)
2. Score 0.0–1.0:
   0.8–1.0  Strong — intentional narrative link, clear to any degen
   0.6–0.79 Moderate — plausible link, same thematic space
   0.45–0.59 Weak — include with SPIN
   0.0–0.44 Unrelated — exclude
   If a VISUAL SIGNAL is present, raise score by +0.2 (STRONG) or +0.1 (MODERATE)
3. One-sentence reason — be specific about WHY, not just "meme concept alignment"

INVALID REASONS (always score 0.1):
- "Both are cryptocurrencies / meme tokens / Solana tokens"
- "Both reference the dollar sign / monetary concepts"
- "Both have similar market structure"
- "Both relate to finance/currency/wealth" (unless alpha's theme IS explicitly financial)

DESCRIPTION RULE: If a description contradicts a negative name interpretation,
the description wins. "Dark Pepe" + description "wholesome frog art" = UNIVERSE not EVIL_TWIN.

Respond ONLY with a JSON array, no markdown:
[{"index":0,"score":0.92,"relationshipType":"TWIN","reason":"LMAO is the direct escalation of LOL — same humor/laughter narrative"},{"index":1,"score":0.2,"relationshipType":"SPIN","reason":"Unrelated financial token"}]`
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

  // Context-aware hallucination filter
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