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
const CACHE_TTL_MS = 5 * 60 * 1000  // Cache results for 5 minutes

// ─── In-memory cache ─────────────────────────────────────────────
// Prevents re-scoring on every render. Key = alphaAddress + candidateAddresses hash.
const scoreCache = new Map()

const getCacheKey = (alphaAddress, candidateAddresses) =>
  `${alphaAddress}:${candidateAddresses.sort().join(',')}`

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

Consider: shared characters, shared events (Trump alien disclosure → ALIEN tokens), shared cultural references, shared meme formats, prefix/suffix derivatives, thematic overlap.

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

// ─── Main scoring function ───────────────────────────────────────
// Takes alpha + all candidates, runs them through Claude in batches,
// returns only the ones that score above the threshold.
export const scoreWithAI = async (alpha, candidates) => {
  if (!alpha || !candidates || candidates.length === 0) return []

  const cacheKey = getCacheKey(
    alpha.address,
    candidates.map(c => c.address || c.id)
  )

  // Return cached results if still fresh
  const cached = scoreCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[Vector8] Cache hit for $${alpha.symbol} — ${cached.results.length} AI matches`)
    return cached.results
  }

  console.log(`[Vector8] Scoring ${candidates.length} candidates for $${alpha.symbol}...`)

  // Process in batches to manage token usage and latency
  const batches = []
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE))
  }

  const batchResults = await Promise.allSettled(
    batches.map(batch => scoreBatch(alpha, batch))
  )

  const allScored = batchResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => b.aiScore - a.aiScore)

  // Cache the results
  scoreCache.set(cacheKey, { results: allScored, timestamp: Date.now() })
  console.log(`[Vector8] Found ${allScored.length} AI-matched betas for $${alpha.symbol}`)

  return allScored
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