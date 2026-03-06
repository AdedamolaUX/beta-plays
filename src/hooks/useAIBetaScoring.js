// ─── Vector 8: AI-Powered Beta Scoring ──────────────────────────
// Uses Claude to semantically score narrative relationships between
// an alpha token and candidate betas. This is what closes the gap
// that hardcoded pattern matching can never close:
//
// $DARWIN and $EVOLUTION → related (no shared characters)
// $COPE and $HOPIUM → same narrative universe
// $GORKFUND and $GORK → derivative (prefix not in our dict)
//
// In production: call YOUR backend endpoint instead of API directly.
// Your backend holds the API key securely. See Vector8_Backend_Guide.docx

// Route all AI calls through our backend — key never touches the frontend
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const AI_SCORE_THRESHOLD = 0.65  // Minimum score to qualify as a beta
const BATCH_SIZE = 8             // Candidates per API call (controls cost + latency)
const CACHE_TTL_MS = 30 * 60 * 1000  // 30 min — balances freshness vs token budget
const LS_KEY = 'betaplays_score_cache_v1'

// ─── localStorage cache ───────────────────────────────────────────
// Persists across page refreshes so we never re-score the same
// alpha+candidates pair within the TTL window.
const getCacheKey = (alphaAddress, candidateAddresses) =>
  `${alphaAddress}:${[...candidateAddresses].sort().join(',')}`

const loadScoreCache = () => {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

const saveScoreCache = (cache) => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cache)) } catch {}
}

// ─── Build the scoring prompt ────────────────────────────────────
// This prompt is the heart of Vector 8.
// We give Claude full context about the alpha and ask it to score
// each candidate on narrative relatedness — not just name similarity.
const buildScoringPrompt = (alpha, candidates) => {
  const alphaContext = [
    `Symbol: $${alpha.symbol}`,
    alpha.name    ? `Name: ${alpha.name}`               : null,
    alpha.description ? `Description: ${alpha.description}` : null,
    alpha.marketCap   ? `Market Cap: $${alpha.marketCap.toLocaleString()}` : null,
  ].filter(Boolean).join('\n')

  const candidateList = candidates.map((c, i) => {
    const lines = [
      `[${i}] Symbol: $${c.symbol}`,
      c.name        ? `    Name: ${c.name}`               : null,
      c.description ? `    Description: ${c.description}` : null,
    ].filter(Boolean).join('\n')
    return lines
  }).join('\n\n')

  return `You are analyzing Solana meme tokens to identify which ones are narrative derivatives or beta plays of a given alpha token.

ALPHA TOKEN (the runner we're analyzing):
${alphaContext}

CANDIDATE TOKENS (potential beta plays):
${candidateList}

For each candidate, score how likely it is to be a beta/derivative of the alpha token (0.0 to 1.0).

Scoring criteria:
- 0.9-1.0: Direct derivative (same character, event, or meme — e.g. PIPPKIN of PIPPIN)
- 0.7-0.89: Strong narrative connection (same universe, concept, or cultural moment)
- 0.5-0.69: Possible connection but ambiguous
- 0.0-0.49: Likely unrelated despite surface similarity

Consider ALL of the following signals:
- Ticker/name: prefix or suffix derivatives (BABY, MINI, INU, AI, 2.0 etc.)
- Shared characters: same mascot, person, or fictional entity
- Shared events: same cultural moment or news event that spawned both (e.g. Trump alien disclosure → multiple ALIEN tokens)
- Shared meme formats: same joke format, same reference template
- Description language: pay close attention to token descriptions — they often contain indirect references WITHOUT naming the alpha explicitly. Look for:
    * Thematic echoes ("the original", "the one that started it", "for those who missed the run")
    * Cultural callbacks and in-jokes the community would recognize
    * Phrases that reference the alpha's narrative without using its name/symbol
    * Community dog-whistles like "you know what this is" or "the sequel"
- Narrative universe: tokens launched in the same cultural moment even without direct name overlap

Respond ONLY with a JSON array. No explanation, no markdown, no preamble. Example format:
[{"index":0,"score":0.95,"reason":"Direct derivative"},{"index":1,"score":0.2,"reason":"Unrelated"}]`
}

// ─── Call backend /api/score-betas ──────────────────────────────
// Backend holds the Anthropic key and returns parsed JSON directly.
const callAnthropicAPI = async (prompt) => {
  const response = await fetch(`${BACKEND_URL}/api/score-betas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })

  if (!response.ok) {
    throw new Error(`Backend scoring error: ${response.status}`)
  }

  const data = await response.json()

  // Backend returns parsed array directly.
  // Guard: if somehow we got an error object, throw instead of crashing .map()
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(data).slice(0, 100)}`)
  }

  return data
}

// ─── Score a batch of candidates ────────────────────────────────
const scoreBatch = async (alpha, candidates) => {
  if (!candidates || candidates.length === 0) return []

  const prompt  = buildScoringPrompt(alpha, candidates)
  const results = await callAnthropicAPI(prompt)

  return results
    .filter(r => r.score >= AI_SCORE_THRESHOLD)
    .map(r => ({
      ...candidates[r.index],
      aiScore:  r.score,
      aiReason: r.reason,
      signalSources: [...(candidates[r.index].signalSources || []), 'ai_match'],
    }))
}

// ─── Throttle helper ─────────────────────────────────────────────
// Groq free tier = 30 req/min shared across all endpoints.
// Sequential batching with a delay keeps us safe.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const BATCH_DELAY_MS = 3000  // 3s between batches → max 20 req/min across all Groq calls

// ─── Main scoring function ───────────────────────────────────────
// Takes alpha + all candidates, runs them through Groq in batches,
// returns only the ones that score above the threshold.
export const scoreWithAI = async (alpha, candidates) => {
  if (!alpha || !candidates || candidates.length === 0) return []

  const cacheKey = getCacheKey(
    alpha.address,
    candidates.map(c => c.address || c.id)
  )

  // Return cached results if still fresh (persisted across page refreshes)
  const scoreCache = loadScoreCache()
  const cached = scoreCache[cacheKey]
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`[Vector8] Cache hit for $${alpha.symbol} — ${cached.results.length} AI matches (0 Groq calls)`)
    return cached.results
  }

  console.log(`[Vector8] Scoring ${candidates.length} candidates for $${alpha.symbol}...`)

  // Process batches sequentially with a delay between each
  // (was Promise.allSettled — fired all at once, caused Groq 429s)
  const allScored = []

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    // Throttle between batches — not before the first one
    if (i > 0) {
      console.log(`[Vector8] Throttling — waiting ${BATCH_DELAY_MS / 1000}s before batch ${batchNum}...`)
      await sleep(BATCH_DELAY_MS)
    }

    try {
      const results = await scoreBatch(alpha, batch)
      allScored.push(...results)
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('rate')) {
        console.warn(`[Vector8] Rate limited on batch ${batchNum} — backing off 10s`)
        await sleep(10000)
        try {
          const retryResults = await scoreBatch(alpha, batch)
          allScored.push(...retryResults)
        } catch (retryErr) {
          console.warn(`[Vector8] Retry failed for batch ${batchNum}:`, retryErr.message)
        }
      } else {
        console.warn(`[Vector8] Batch ${batchNum} failed:`, err.message)
      }
    }
  }

  const sorted = allScored.sort((a, b) => b.aiScore - a.aiScore)

  // Persist results to localStorage so next refresh doesn't re-score
  const latestCache = loadScoreCache()
  latestCache[cacheKey] = { results: sorted, timestamp: Date.now() }
  saveScoreCache(latestCache)
  console.log(`[Vector8] Found ${sorted.length} AI-matched betas for $${alpha.symbol}`)

  return sorted
}

// ─── Production swap instructions ───────────────────────────────
// When you deploy the backend (see Vector8_Backend_Guide.docx),
// replace callAnthropicAPI with:
//
// const callAnthropicAPI = async (prompt) => {
//   const response = await fetch('https://your-backend.railway.app/api/score-betas', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ prompt }),
//   })
//   return response.json()
// }
//
// That's the only change needed. The rest of this file stays identical.

export default scoreWithAI