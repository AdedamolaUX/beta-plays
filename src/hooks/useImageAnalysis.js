// ─── Image Analysis: Gemini Vision for Token Logos ───────────────
// Text signals miss a huge class of relationships because meme token
// identity lives in the IMAGE, not the name:
//
//   $NIRE (abstract ticker) + cat logo = cats narrative
//   Candidate logo = alpha logo wearing a hat = direct visual derivative
//   PumpFun token image = screenshot of alpha's tweet = clear beta signal
//
// Architecture:
//   - Calls backend /api/analyze-vision (Gemini Flash — free tier)
//   - Backend fetches images server-side (avoids CORS on DEXScreener)
//   - Two modes:
//       CLASSIFY: "what is in this image?" → Szn categorization
//       COMPARE:  "is candidate visually derived from alpha?" → beta scoring
//   - In-memory cache with 10-min TTL (logos don't change)
//
// Works in production now — backend handles image fetching.

const BACKEND_URL        = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const CACHE_TTL_MS       = 10 * 60 * 1000
const VISION_BATCH_SIZE  = 6
const MIN_TEXT_CONFIDENCE = 0.5

// ─── Cache ───────────────────────────────────────────────────────
const visionCache = new Map()

const getCacheKey = (...parts) => parts.filter(Boolean).join(':')

// ─── Core API call ────────────────────────────────────────────────
const callVisionBackend = async (body) => {
  const response = await fetch(`${BACKEND_URL}/api/analyze-vision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Vision backend error: ${response.status}`)
  return response.json()
}

// ─── MODE 1: Classify logos → Szn category ───────────────────────
// Takes tokens with logos, asks Gemini what each image depicts.
// Returns { tokenAddress, category, description } per token.
// Used by: useNarrativeSzn — for tokens that text matching didn't catch.

export const classifyLogos = async (tokens) => {
  const withLogos = tokens.filter(t => t.logoUrl)
  if (withLogos.length === 0) return []

  const results = []

  for (let i = 0; i < withLogos.length; i += VISION_BATCH_SIZE) {
    const batch = withLogos.slice(i, i + VISION_BATCH_SIZE)

    // Check cache first
    const uncached = []
    batch.forEach(t => {
      const key    = getCacheKey('classify', t.address, t.logoUrl)
      const cached = visionCache.get(key)
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        results.push({ token: t, ...cached.result })
      } else {
        uncached.push(t)
      }
    })

    if (uncached.length === 0) continue

    try {
      const apiResults = await callVisionBackend({
        mode:   'classify',
        tokens: uncached.map(t => ({
          address:  t.address,
          symbol:   t.symbol,
          name:     t.name,
          logoUrl:  t.logoUrl,
        })),
      })

      apiResults.forEach(r => {
        const token  = uncached.find(t => t.address === r.address || t.symbol === r.symbol)
        if (!token) return
        const result = { category: r.category, visualDescription: r.description }
        visionCache.set(
          getCacheKey('classify', token.address, token.logoUrl),
          { result, timestamp: Date.now() }
        )
        results.push({ token, ...result })
      })
    } catch (err) {
      console.warn('[Vision] Classify batch failed:', err.message)
    }
  }

  return results
}

// ─── MODE 2: Compare logos → visual beta scoring ──────────────────
// Takes the alpha logo + a batch of candidate logos.
// Asks Gemini: "Is this candidate visually derived from the alpha?"
//
// Returns scored candidates with visualScore (0–1) and visualReason.
// Used by: useBetas / Vector 8 enrichment.

export const compareLogos = async (alpha, candidates) => {
  if (!alpha?.logoUrl) return []
  const withLogos = candidates.filter(c => c.logoUrl)
  if (withLogos.length === 0) return []

  const cacheKey = getCacheKey('compare', alpha.address, withLogos.map(c => c.address).sort().join(','))
  const cached   = visionCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[Vision] Cache hit for $${alpha.symbol} comparison`)
    return cached.results
  }

  const results = []

  for (let i = 0; i < withLogos.length; i += VISION_BATCH_SIZE) {
    const batch = withLogos.slice(i, i + VISION_BATCH_SIZE)

    try {
      const apiResults = await callVisionBackend({
        mode:       'compare',
        alpha:      { address: alpha.address, symbol: alpha.symbol, logoUrl: alpha.logoUrl },
        candidates: batch.map(c => ({
          address: c.address,
          symbol:  c.symbol,
          name:    c.name,
          logoUrl: c.logoUrl,
        })),
      })

      apiResults
        .filter(r => r.visualScore >= 0.5)
        .forEach(r => {
          const candidate = batch.find(c => c.address === r.address || c.symbol === r.symbol)
          if (!candidate) return
          results.push({
            ...candidate,
            visualScore:   r.visualScore,
            visualReason:  r.visualReason,
            signalSources: [...(candidate.signalSources || []), 'visual_match'],
          })
        })
    } catch (err) {
      console.warn('[Vision] Compare batch failed:', err.message)
    }
  }

  visionCache.set(cacheKey, { results, timestamp: Date.now() })
  console.log(`[Vision] Found ${results.length} visual matches for $${alpha.symbol}`)
  return results
}

// ─── Trigger guard ────────────────────────────────────────────────
// Only run vision on tokens where text gave weak signal.
export const shouldRunVision = (token, textConfidence = 0) => {
  if (!token?.logoUrl) return false
  if (textConfidence >= MIN_TEXT_CONFIDENCE) return false
  return true
}

export default { classifyLogos, compareLogos, shouldRunVision }