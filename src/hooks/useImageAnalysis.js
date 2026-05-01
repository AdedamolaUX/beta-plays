// ─── Image Analysis: Vision for Token Logos ───────────────────────
// Text signals miss a huge class of relationships because meme token
// identity lives in the IMAGE, not the name:
//
//   $NIRE (abstract ticker) + cat logo = cats narrative
//   Candidate logo = alpha logo wearing a hat = direct visual derivative
//   PumpFun token image = screenshot of alpha's tweet = clear beta signal
//
// Architecture:
//   - Runs ONLY on tokens where text analysis gave weak/no signal
//   - Batches logo URLs into backend vision calls (Gemini)
//   - Two modes:
//       CLASSIFY: "what is in this image?" → Szn categorization
//       COMPARE:  "is candidate visually derived from alpha?" → beta scoring
//   - In-memory cache with 10-min TTL (logos don't change)
//
// Rate limiting:
//   Gemini free tier = 15 req/min.
//   We throttle to 1 batch every BATCH_DELAY_MS between calls.
//   Combined with VISION_BATCH_SIZE this keeps us safely under the limit.

const BACKEND_URL         = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const CACHE_TTL_MS        = 24 * 60 * 60 * 1000  // 24h — logos almost never change
const VISION_BATCH_SIZE   = 5                     // tokens per backend call
const BATCH_DELAY_MS      = 5000                  // 5s between batches → max 12 req/min
const MIN_TEXT_CONFIDENCE = 0.5                   // skip vision if text already confident

// ─── Cache: in-memory + Neon ──────────────────────────────────────
// In-memory: instant repeat lookups within the same session (free, no latency)
// Neon: shared across all users and survives server/page restarts (24h TTL)
// localStorage completely removed — Neon is the durable layer.

const getCacheKey = (...parts) => parts.filter(Boolean).join(':')
const visionMemCache = new Map()

const getCached = async (key) => {
  // Memory first
  if (visionMemCache.has(key)) return visionMemCache.get(key)

  // Neon fallback
  try {
    const res = await fetch(`${BACKEND_URL}/api/cache/vision?key=${encodeURIComponent(key)}`)
    if (res.ok) {
      const { hit, data } = await res.json()
      if (hit && data) {
        visionMemCache.set(key, { result: data, timestamp: Date.now() })
        return { result: data, timestamp: Date.now() }
      }
    }
  } catch { /* non-fatal */ }
  return null
}

const setCached = (key, result) => {
  const entry = { result, timestamp: Date.now() }
  visionMemCache.set(key, entry)
  // Persist to Neon — 24h TTL
  fetch(`${BACKEND_URL}/api/cache/vision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ key, data: result }),
  }).catch(() => {})
}

// ─── Throttle helper ──────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ─── Core API call → backend vision endpoint ─────────────────────
// All vision calls go through the backend so:
//   1. API key stays server-side
//   2. CORS issues with DEXScreener image URLs are handled by the server
//   3. We have a single place to tune rate limits

const callVisionBackend = async (mode, tokens, alpha = null) => {
  const body = { mode, tokens }
  if (alpha) body.alpha = alpha

  const response = await fetch(`${BACKEND_URL}/api/analyze-vision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })

  if (response.status === 429) {
    throw new Error('RATE_LIMITED')
  }

  if (!response.ok) throw new Error(`Vision backend error: ${response.status}`)

  return response.json()
}

// ─── MODE 1: Classify logos → Szn category ───────────────────────
// Takes a batch of tokens with logos, asks Gemini what each image depicts.
// Returns { token, category, visualDescription } per token.
//
// Used by: useNarrativeSzn — for tokens that text matching didn't catch.

export const classifyLogos = async (tokens) => {
  const withLogos = tokens.filter(t => t.logoUrl)
  if (withLogos.length === 0) return []

  const results = []
  let batchIndex = 0

  for (let i = 0; i < withLogos.length; i += VISION_BATCH_SIZE) {
    const batch = withLogos.slice(i, i + VISION_BATCH_SIZE)

    // ── Check cache first ──────────────────────────────────────────
    const uncached = []
    for (const t of batch) {
      const key    = getCacheKey('classify', t.address, t.logoUrl)
      const cached = await getCached(key)
      if (cached) {
        console.log(`[Vision] Cache hit: $${t.symbol}`)
        results.push({ token: t, ...cached.result })
      } else {
        uncached.push(t)
      }
    }

    if (uncached.length === 0) continue

    // ── Throttle: wait between batches (not before the first one) ──
    if (batchIndex > 0) {
      console.log(`[Vision] Throttling — waiting ${BATCH_DELAY_MS / 1000}s before next batch...`)
      await sleep(BATCH_DELAY_MS)
    }
    batchIndex++

    // ── Call backend ───────────────────────────────────────────────
    try {
      const apiResults = await callVisionBackend('classify', uncached)

      apiResults.forEach(r => {
        const token  = uncached[r.index]
        if (!token) return
        const result = { category: r.category, visualDescription: r.description }

        // Persist to Neon cache
        setCached(getCacheKey('classify', token.address, token.logoUrl), result)
        results.push({ token, ...result })
      })

      console.log(`[Vision] Classified batch ${batchIndex}: ${uncached.length} tokens`)
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        // Back off and retry this batch once
        console.warn(`[Vision] Rate limited on batch ${batchIndex} — backing off 10s`)
        await sleep(10000)
        try {
          const retryResults = await callVisionBackend('classify', uncached)
          retryResults.forEach(r => {
            const token  = uncached[r.index]
            if (!token) return
            const result = { category: r.category, visualDescription: r.description }
            setCached(getCacheKey('classify', token.address, token.logoUrl), result)
            results.push({ token, ...result })
          })
        } catch (retryErr) {
          console.warn(`[Vision] Retry failed for batch ${batchIndex}:`, retryErr.message)
        }
      } else {
        console.warn(`[Vision] Classify batch ${batchIndex} failed:`, err.message)
      }
    }
  }

  return results
}

// ─── MODE 2: Compare logos → visual beta scoring ──────────────────
// Takes the alpha token + a batch of candidate tokens.
// Asks Gemini: "Is this candidate visually derived from the alpha?"
//
// Returns scored candidates with visualScore (0–1) and visualReason.
// Used by: useBetas / Vector 8 enrichment.

export const compareLogos = async (alpha, candidates) => {
  if (!alpha?.logoUrl) return []
  const withLogos = candidates.filter(c => c.logoUrl)
  if (withLogos.length === 0) return []

  // ── Full comparison cache ──────────────────────────────────────
  const cacheKey = getCacheKey('compare', alpha.address, withLogos.map(c => c.address).sort().join(','))
  const cachedCompare = await getCached(cacheKey)
  if (cachedCompare) {
    console.log(`[Vision] Cache hit for $${alpha.symbol} comparison (0 Groq/Gemini calls)`)
    return cachedCompare.result
  }

  const results  = []
  let batchIndex = 0

  for (let i = 0; i < withLogos.length; i += VISION_BATCH_SIZE) {
    const batch = withLogos.slice(i, i + VISION_BATCH_SIZE)

    // ── Throttle between batches ───────────────────────────────────
    if (batchIndex > 0) {
      console.log(`[Vision] Throttling — waiting ${BATCH_DELAY_MS / 1000}s before next compare batch...`)
      await sleep(BATCH_DELAY_MS)
    }
    batchIndex++

    try {
      const apiResults = await callVisionBackend('compare', batch, alpha)

      apiResults
        .filter(r => r.visualScore >= 0.5)  // Only surface meaningful visual matches
        .forEach(r => {
          const candidate = batch[r.index]
          if (!candidate) return
          results.push({
            ...candidate,
            visualScore:   r.visualScore,
            visualReason:  r.visualReason,
            signalSources: [...(candidate.signalSources || []), 'visual_match'],
          })
        })

      console.log(`[Vision] Compared batch ${batchIndex} against $${alpha.symbol}`)
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        console.warn(`[Vision] Rate limited on compare batch ${batchIndex} — backing off 10s`)
        await sleep(10000)
        try {
          const retryResults = await callVisionBackend('compare', batch, alpha)
          retryResults
            .filter(r => r.visualScore >= 0.5)
            .forEach(r => {
              const candidate = batch[r.index]
              if (!candidate) return
              results.push({
                ...candidate,
                visualScore:   r.visualScore,
                visualReason:  r.visualReason,
                signalSources: [...(candidate.signalSources || []), 'visual_match'],
              })
            })
        } catch (retryErr) {
          console.warn(`[Vision] Retry failed for compare batch ${batchIndex}:`, retryErr.message)
        }
      } else {
        console.warn(`[Vision] Compare batch ${batchIndex} failed:`, err.message)
      }
    }
  }

  // Persist comparison results to Neon cache
  setCached(cacheKey, results)
  console.log(`[Vision] Found ${results.length} visual matches for $${alpha.symbol}`)
  return results
}

// ─── Trigger guard ────────────────────────────────────────────────
// Used by useNarrativeSzn for the Szn classify pipeline.
// In useBetas, vision now runs on all logo-bearing candidates before
// Vector 8 — the textConfidence check is not used there anymore.
//
// Returns true if vision analysis is worth running for this token.
export const shouldRunVision = (token, textConfidence = 0) => {
  if (!token?.logoUrl) return false
  // Only skip if text is already very confident AND ai_match confirmed it
  const hasAIConfirmation = (token.signalSources || []).includes('ai_match')
  if (hasAIConfirmation && textConfidence >= MIN_TEXT_CONFIDENCE) return false
  return true
}

export default { classifyLogos, compareLogos, shouldRunVision }