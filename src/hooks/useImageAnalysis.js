// ─── Image Analysis: Claude Vision for Token Logos ───────────────
// Text signals miss a huge class of relationships because meme token
// identity lives in the IMAGE, not the name:
//
//   $NIRE (abstract ticker) + cat logo = cats narrative
//   Candidate logo = alpha logo wearing a hat = direct visual derivative
//   PumpFun token image = screenshot of alpha's tweet = clear beta signal
//
// Architecture:
//   - Runs ONLY on tokens where text analysis gave weak/no signal
//   - Batches logo URLs into Claude Vision calls (cost-conscious)
//   - Two modes:
//       CLASSIFY: "what is in this image?" → Szn categorization
//       COMPARE:  "is candidate visually derived from alpha?" → beta scoring
//   - In-memory cache with 10-min TTL (logos don't change)
//
// Cost guard: vision tokens are ~3-4x text tokens.
// We only trigger vision when text confidence is below threshold.

const ANTHROPIC_API_URL  = 'https://api.anthropic.com/v1/messages'
const CACHE_TTL_MS       = 10 * 60 * 1000   // 10 minutes — logos are stable
const VISION_BATCH_SIZE  = 6                 // logos per API call
const MIN_TEXT_CONFIDENCE = 0.5              // skip vision if text already confident

// ─── Cache ───────────────────────────────────────────────────────
const visionCache = new Map()

const getCacheKey = (...parts) => parts.filter(Boolean).join(':')

// ─── Fetch image as base64 ────────────────────────────────────────
// Claude Vision requires base64-encoded images.
// We proxy through a data URL fetch to avoid CORS issues.
const fetchImageAsBase64 = async (url) => {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`)
    const blob       = await response.blob()
    const mediaType  = blob.type || 'image/png'
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload  = () => {
        // Strip the data URL prefix, keep only base64
        const base64 = reader.result.split(',')[1]
        resolve({ base64, mediaType })
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch (err) {
    console.warn(`[Vision] Could not fetch image: ${url}`, err.message)
    return null
  }
}

// ─── Core API call with vision ────────────────────────────────────
const callVisionAPI = async (messages) => {
  const response = await fetch(ANTHROPIC_API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages,
    }),
  })
  if (!response.ok) throw new Error(`Vision API error: ${response.status}`)
  const data  = await response.json()
  const text  = data.content?.filter(b => b.type === 'text')?.map(b => b.text)?.join('') || ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

// ─── MODE 1: Classify logos → Szn category ───────────────────────
// Takes a batch of tokens with logos, asks Claude what each image depicts.
// Returns { tokenAddress, category, description } per token.
//
// Used by: useNarrativeSzn — for tokens that text matching didn't catch.

const buildClassifyPrompt = (tokens) => ({
  role: 'user',
  content: [
    // One image block per token
    ...tokens.flatMap((t, i) => [
      {
        type: 'text',
        text: `[${i}] Token: $${t.symbol} (${t.name || 'unknown name'})`,
      },
      {
        type:   'image',
        source: { type: 'base64', media_type: t._imgData.mediaType, data: t._imgData.base64 },
      },
    ]),
    {
      type: 'text',
      text: `For each token image above, identify:
1. What narrative/theme does this image represent? (e.g. cats, dogs, frogs, aliens, political figure, anime, space, gaming, food, memes, etc.)
2. A brief description of what you see (1 sentence max)

Respond ONLY with a JSON array. No markdown. Example:
[
  {"index":0,"category":"cats","description":"Orange cat with glowing eyes"},
  {"index":1,"category":"aliens","description":"Green alien holding a sign"},
  {"index":2,"category":null,"description":"Abstract geometric logo, unclear theme"}
]`,
    },
  ],
})

export const classifyLogos = async (tokens) => {
  // Filter to tokens that have logos
  const withLogos = tokens.filter(t => t.logoUrl)
  if (withLogos.length === 0) return []

  const results = []

  // Process in batches
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

    // Fetch images as base64
    const withImgData = (
      await Promise.all(
        uncached.map(async t => {
          const imgData = await fetchImageAsBase64(t.logoUrl)
          return imgData ? { ...t, _imgData: imgData } : null
        })
      )
    ).filter(Boolean)

    if (withImgData.length === 0) continue

    try {
      const prompt      = buildClassifyPrompt(withImgData)
      const apiResults  = await callVisionAPI([prompt])

      apiResults.forEach(r => {
        const token  = withImgData[r.index]
        if (!token) return
        const result = { category: r.category, visualDescription: r.description }
        // Cache it
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
// Asks Claude: "Is this candidate visually derived from the alpha?"
//
// Returns scored candidates with visualScore (0–1) and visualReason.
// Used by: useBetas / Vector 8 enrichment.

const buildComparePrompt = (alpha, candidates) => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: `ALPHA TOKEN: $${alpha.symbol} — this is the token we're analyzing for beta plays.`,
    },
    {
      type:   'image',
      source: { type: 'base64', media_type: alpha._imgData.mediaType, data: alpha._imgData.base64 },
    },
    {
      type: 'text',
      text: `CANDIDATE TOKENS — are any of these visually derived from the alpha above?`,
    },
    ...candidates.flatMap((c, i) => [
      {
        type: 'text',
        text: `[${i}] $${c.symbol} (${c.name || ''})`,
      },
      {
        type:   'image',
        source: { type: 'base64', media_type: c._imgData.mediaType, data: c._imgData.base64 },
      },
    ]),
    {
      type: 'text',
      text: `For each candidate, score visual relatedness to the ALPHA (0.0 to 1.0):

- 0.9-1.0: Directly derived — same character/art, recolored, wearing something, or obvious copy
- 0.7-0.89: Same visual universe — same meme format, same cultural reference, clearly same narrative
- 0.5-0.69: Loosely related — similar style or theme but not obviously the same
- 0.0-0.49: Unrelated visually

Also note what you see in each candidate image.

Respond ONLY with a JSON array. No markdown. Example:
[
  {"index":0,"visualScore":0.92,"visualReason":"Same frog character, recolored green"},
  {"index":1,"visualScore":0.3,"visualReason":"Different animal entirely, unrelated"}
]`,
    },
  ],
})

export const compareLogos = async (alpha, candidates) => {
  // DEXScreener blocks cross-origin image fetches in production.
  // Vision only runs on localhost until we add an image proxy endpoint.
  const IS_PROD = !window.location.hostname.includes('localhost')
  if (IS_PROD) return []

  if (!alpha?.logoUrl) return []
  const withLogos = candidates.filter(c => c.logoUrl)
  if (withLogos.length === 0) return []

  const cacheKey = getCacheKey('compare', alpha.address, withLogos.map(c => c.address).sort().join(','))
  const cached   = visionCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[Vision] Cache hit for $${alpha.symbol} comparison`)
    return cached.results
  }

  // Fetch alpha image
  const alphaImgData = await fetchImageAsBase64(alpha.logoUrl)
  if (!alphaImgData) return []

  const enrichedAlpha = { ...alpha, _imgData: alphaImgData }

  const results = []

  // Process candidates in batches (keep vision calls small — expensive)
  for (let i = 0; i < withLogos.length; i += VISION_BATCH_SIZE) {
    const batch = withLogos.slice(i, i + VISION_BATCH_SIZE)

    // Fetch candidate images
    const withImgData = (
      await Promise.all(
        batch.map(async c => {
          const imgData = await fetchImageAsBase64(c.logoUrl)
          return imgData ? { ...c, _imgData: imgData } : null
        })
      )
    ).filter(Boolean)

    if (withImgData.length === 0) continue

    try {
      const prompt     = buildComparePrompt(enrichedAlpha, withImgData)
      const apiResults = await callVisionAPI([prompt])

      apiResults
        .filter(r => r.visualScore >= 0.5)  // Only surface meaningful visual matches
        .forEach(r => {
          const candidate = withImgData[r.index]
          if (!candidate) return
          results.push({
            ...candidate,
            visualScore:  r.visualScore,
            visualReason: r.visualReason,
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
// Prevents burning API budget on tokens we already understand.
//
// Returns true if vision analysis is worth running for this token.
export const shouldRunVision = (token, textConfidence = 0) => {
  if (!token?.logoUrl) return false
  if (textConfidence >= MIN_TEXT_CONFIDENCE) return false  // Text already confident
  return true
}

export default { classifyLogos, compareLogos, shouldRunVision }