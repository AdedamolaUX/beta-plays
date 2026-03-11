// ─── BetaPlays Backend ────────────────────────────────────────────
// Endpoints:
//   POST /api/score-betas      — Vector 8 AI scoring via Groq (Llama 3.3 70B)
//   POST /api/categorize-szn   — Narrative categorization via Groq
//   POST /api/analyze-vision   — Logo analysis via Gemini Flash
//   GET  /api/birdeye          — Birdeye data proxy
//   GET  /api/pumpfun          — PumpFun CORS proxy
//   GET  /health               — uptime check
//
// Keys live ONLY in server/.env — never in the frontend.

const express   = require('express')
const cors      = require('cors')
const rateLimit = require('express-rate-limit')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))  // 10mb for base64 image payloads

// Rate limiting — split limits so vision batches don't eat the shared quota
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,  // 60 req/min for general endpoints (birdeye, pumpfun, scoring)
  message: { error: 'Too many requests, slow down degen' },
})
const visionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,  // 20 req/min for vision — just under Gemini's 15/min free tier limit
  message: { error: 'Vision rate limit — slow down' },
})
app.use('/api/analyze-vision', visionLimiter)  // vision gets its own bucket
app.use('/api/', limiter)                       // everything else shares the general bucket

// ─── Groq helper ──────────────────────────────────────────────────
const callGroq = async (prompt, systemPrompt = null) => {
  const GROQ_KEY = process.env.GROQ_API_KEY
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not configured')

  const messages = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: prompt })

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  1000,
      temperature: 0.1,
      messages,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Groq error ${response.status}: ${err}`)
  }

  const data  = await response.json()
  const text  = data.choices?.[0]?.message?.content || ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

// ─── Groq Fast helper (llama-3.1-8b-instant) ────────────────────
// Separate model = separate TPD quota (500k/day vs 70b's 100k/day).
// Used for structured output tasks that don't need 70B reasoning:
//   - Vector 0A concept expansion
// Vector 8 classification stays on 70b for quality.
const callGroqFast = async (prompt, systemPrompt = null) => {
  const GROQ_KEY = process.env.GROQ_API_KEY
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not configured')

  const messages = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: prompt })

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model:       'llama-3.1-8b-instant',
      max_tokens:  600,
      temperature: 0.1,
      messages,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Groq error ${response.status}: ${err}`)
  }

  const data  = await response.json()
  const text  = data.choices?.[0]?.message?.content || ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

// ─── Gemini helper ────────────────────────────────────────────────
const callGemini = async (parts) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured')

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Gemini error ${response.status}: ${err}`)
  }

  const data  = await response.json()
  const text  = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const clean = text.replace(/```json|```/g, '').trim()
  if (!clean) throw new Error('Gemini returned empty response')
  try {
    return JSON.parse(clean)
  } catch (parseErr) {
    console.error('[Gemini] JSON parse failed. Raw:', clean.slice(0, 300))
    throw new Error(`Gemini response was not valid JSON: ${parseErr.message}`)
  }
}

// ─── Groq Vision fallback helper ─────────────────────────────────
// Used when Gemini quota is exhausted. Accepts same image data,
// formats it for Groq's OpenAI-compatible vision API.
const callGroqVision = async (mode, withImages, alpha = null) => {
  const GROQ_KEY = process.env.GROQ_API_KEY
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not configured')

  const contentParts = []

  if (mode === 'classify') {
    withImages.forEach((t, i) => {
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${t.img.mimeType};base64,${t.img.base64}` },
      })
      contentParts.push({ type: 'text', text: `[${i}] Token: $${t.symbol} (${t.name || 'unknown'})` })
    })
    contentParts.push({
      type: 'text',
      text: `For each token image above, identify the narrative/theme and give a 1-sentence description.
Respond ONLY with a JSON array. No markdown. Example:
[
  {"index":0,"category":"cats","description":"Orange cat with glowing eyes"},
  {"index":1,"category":"aliens","description":"Green alien holding a sign"},
  {"index":2,"category":null,"description":"Abstract geometric logo, unclear theme"}
]`,
    })
  } else {
    // compare mode
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${alpha.img.mimeType};base64,${alpha.img.base64}` },
    })
    contentParts.push({ type: 'text', text: `ALPHA TOKEN: $${alpha.symbol} — analyzing for beta plays.` })
    withImages.forEach((c, i) => {
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${c.img.mimeType};base64,${c.img.base64}` },
      })
      contentParts.push({ type: 'text', text: `[${i}] $${c.symbol} (${c.name || ''})` })
    })
    contentParts.push({
      type: 'text',
      text: `Score each candidate's visual relatedness to the ALPHA (0.0 to 1.0).
Respond ONLY with a JSON array. No markdown. Example:
[
  {"index":0,"visualScore":0.92,"visualReason":"Same frog character, recolored green"},
  {"index":1,"visualScore":0.3,"visualReason":"Different animal entirely, unrelated"}
]`,
    })
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model:       'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens:  1000,
      temperature: 0.1,
      messages: [{ role: 'user', content: contentParts }],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Groq vision error ${response.status}: ${err}`)
  }

  const data  = await response.json()
  const text  = data.choices?.[0]?.message?.content || ''
  const clean = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(clean)
  } catch (parseErr) {
    console.error('[GroqVision] JSON parse failed. Raw:', clean.slice(0, 300))
    throw new Error(`Groq vision response was not valid JSON: ${parseErr.message}`)
  }
}

// ─── Vision provider helper ───────────────────────────────────────
// Tries Gemini first. If quota is exhausted, falls back to Groq vision.
const isGeminiQuotaError = (err) =>
  err.message.includes('429') || err.message.includes('quota') || err.message.includes('RESOURCE_EXHAUSTED')

// ─── Server-side expansion cache ─────────────────────────────────
// Shared across ALL users. One expansion per alpha, not per user.
// Key: token address. Value: { data, timestamp, mcap }
const expansionCache = new Map()
const EXPANSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h

const isExpansionCacheValid = (cached, currentMcap, forceRefresh) => {
  if (forceRefresh) return false
  if (!cached) return false
  if (Date.now() - cached.timestamp > EXPANSION_CACHE_TTL_MS) return false
  // Invalidate if mcap grew >50% — significant new attention = new betas spawning
  if (currentMcap && cached.mcap && currentMcap > cached.mcap * 1.5) return false
  return true
}

// Vector 0A: Text concept expansion prompt
const buildExpansionPrompt = (alpha) => {
  const context = [
    `Symbol: $${alpha.symbol}`,
    alpha.name && alpha.name.toLowerCase() !== alpha.symbol.toLowerCase()
      ? `Name: ${alpha.name}` : null,
    alpha.description ? `Description: ${alpha.description}` : null,
  ].filter(Boolean).join('\n')

  return `You are analyzing a Solana meme token to find SPECIFIC derivative/beta tokens on DEXScreener.

ALPHA TOKEN:
${context}

Generate search terms for finding tokens that were CONSCIOUSLY created in response to this alpha.

Think about these relationship types:
- TWIN: specific synonyms ($HOUSECOIN → shelter, crib, dwelling — NOT "home" which is too generic)
- SECTOR: named peers in same space ($CLAUDE → cursor, devin, copilot — actual product names)
- COUNTER: the DIRECT OPPOSITE concept — this is critical and often missed
  * $WAR → peace, truce, ceasefire, armistice, pacifist
  * $BEAR → bull (the market pair)
  * $DARK → light, bright, glow
  * $CHAOS → order, calm, control
  * For ANY single-concept token, always generate its direct antonym as a COUNTER term
- ECHO: specific narrative consequences ($HOUSECOIN → eviction, foreclosure — NOT "money")
- UNIVERSE: named characters/places from same fictional world ($NARUTO → sasuke, kakashi, itachi)
- EVIL_TWIN: dark variant keywords (dark, evil, cursed, corrupt + the core subject)

STRICT RULES — violating these wastes quota:
- NO generic words: chain, coin, token, green, blue, red, crypto, solana, degen, moon, pump, based
- NO body parts, colors, or emotions unless they are THE defining feature of this specific token
- NO words already in the token's symbol or name
- ONLY terms specific enough that a token creator would use them as a ticker
- Return 5-8 terms maximum — precision over volume

BAD example for $DOGCHAIN: ["dog","chain","crypto","token","coin"] — all generic, useless
GOOD example for $DOGCHAIN: ["leash","collar","kennel","breed","dogcatcher"] — specific to dog+chain narrative

Respond ONLY with valid JSON. No explanation, no markdown:
{
  "searchTerms": ["shelter","eviction","landlord","crib","foreclosure"],
  "relationshipHints": {
    "shelter": "TWIN",
    "eviction": "ECHO",
    "landlord": "COUNTER",
    "crib": "TWIN",
    "foreclosure": "ECHO"
  }
}`
}

// Vector 0B: Image expansion via Groq vision (called when Gemini quota exhausted)
const callGroqImageExpansion = async (symbol, name, imgData) => {
  const GROQ_KEY = process.env.GROQ_API_KEY
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not configured')

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 250,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${imgData.mimeType};base64,${imgData.base64}` },
          },
          {
            type: 'text',
            text: `This is the logo of Solana meme token $${symbol}${name && name.toLowerCase() !== symbol.toLowerCase() ? ' (' + name + ')' : ''}.

Identify the 2-3 most SPECIFIC visual elements a beta token creator would consciously copy, reference, or subvert.
Good specific elements: "shiba inu breed", "red baseball cap", "crying expression", "astronaut suit"
Bad generic elements: "dog", "cute", "colorful", "round logo"

Also note the overall mood (happy/evil/stoic/chaotic/sad/angry).

Respond ONLY with valid JSON. No markdown:
{"visualTerms":["shiba","red hat"],"mood":"happy","visualHints":{"shiba":"TWIN","red hat":"TWIN"}}`,
          },
        ],
      }],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Groq vision error ${response.status}: ${err}`)
  }

  const data  = await response.json()
  const text  = data.choices?.[0]?.message?.content || ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

// Vector 0B: Image expansion parts for Gemini
const buildImageExpansionParts = (symbol, name, imgData) => [
  {
    text: `This is the logo of Solana meme token $${symbol}${name && name.toLowerCase() !== symbol.toLowerCase() ? ' (' + name + ')' : ''}.`,
  },
  { inline_data: { mime_type: imgData.mimeType, data: imgData.base64 } },
  {
    text: `Identify the 2-3 most SPECIFIC visual elements a beta token creator would consciously copy, reference, or subvert.
Good specific elements: "shiba inu breed", "red baseball cap", "crying expression", "astronaut suit"
Bad generic elements: "dog", "cute", "colorful", "round logo"

Also note the overall mood (happy/evil/stoic/chaotic/sad/angry).

Respond ONLY with valid JSON. No markdown:
{"visualTerms":["shiba","red hat"],"mood":"happy","visualHints":{"shiba":"TWIN","red hat":"TWIN"}}`,
  },
]

// ─── Image fetch helper ───────────────────────────────────────────
const GROQ_SUPPORTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

// Detect actual image type from magic bytes — ignores lying Content-Type headers
const detectMimeFromBytes = (buf) => {
  const b = new Uint8Array(buf)
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'   // GIF87a / GIF89a
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp'  // RIFF....WEBP
  return null  // unknown / unsupported
}

const fetchImageAsBase64 = async (url) => {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`)
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength < 100) throw new Error('Image too small or empty')
    // Use magic bytes — don't trust Content-Type header
    const mimeType = detectMimeFromBytes(buffer)
    if (!mimeType) throw new Error('Unrecognised image format')
    const base64 = Buffer.from(buffer).toString('base64')
    return { base64, mimeType }
  } catch (err) {
    console.warn(`[Vision] Could not fetch image: ${url}`, err.message)
    return null
  }
}

// Filter images to only those Groq can handle (no GIFs, no broken data)
const filterForGroq = (items) =>
  items.filter(t => t.img && GROQ_SUPPORTED_TYPES.includes(t.img.mimeType))

// ─── Retry helper ─────────────────────────────────────────────────
// Retries a fetch call up to maxRetries times with exponential backoff.
// Handles both 429 (rate limit) and 5xx (gateway/server errors).
const fetchWithRetry = async (url, options = {}, maxRetries = 3) => {
  let lastErr
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.status === 429 || res.status >= 500) {
        const backoff = Math.pow(2, attempt) * 1000  // 1s, 2s, 4s
        console.warn(`[Proxy] ${res.status} on attempt ${attempt + 1} — retrying in ${backoff}ms`)
        await new Promise(r => setTimeout(r, backoff))
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      return res
    } catch (err) {
      const backoff = Math.pow(2, attempt) * 1000
      console.warn(`[Proxy] Fetch error on attempt ${attempt + 1} — retrying in ${backoff}ms:`, err.message)
      await new Promise(r => setTimeout(r, backoff))
      lastErr = err
    }
  }
  throw lastErr
}

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }))

// ─── Vector 8: AI beta scoring (Groq) ────────────────────────────
app.post('/api/score-betas', async (req, res) => {
  try {
    const { prompt } = req.body
    if (!prompt) return res.status(400).json({ error: 'prompt required' })

    const result = await callGroq(
      prompt,
      'You are a crypto analyst. Always respond with valid JSON only — no explanation, no markdown fences.'
    )
    res.json(result)
  } catch (err) {
    console.error('Score error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Vector 0: Alpha concept expansion (Groq + Gemini) ──────────
// Generates search terms + visual terms for the full beta scan.
// Server-side cached — shared across all users. One call per alpha.
// Cache invalidated on re-entry events (forceRefresh) or mcap growth.
app.post('/api/expand-alpha', async (req, res) => {
  try {
    const { address, symbol, name, description, logoUrl, marketCap, forceRefresh } = req.body
    if (!address || !symbol) return res.status(400).json({ error: 'address and symbol required' })

    // Check server-side cache first
    const cached = expansionCache.get(address)
    if (isExpansionCacheValid(cached, marketCap, forceRefresh)) {
      console.log(`[Vector0] Cache hit for $${symbol}`)
      return res.json({ ...cached.data, fromCache: true })
    }

    console.log(`[Vector0] Expanding $${symbol}${forceRefresh ? ' (forced refresh)' : ''}...`)

    // ── Vector 0A: Text expansion ─────────────────────────────────
    let searchTerms      = []
    let relationshipHints = {}

    try {
      const textResult = await callGroqFast(
        buildExpansionPrompt({ symbol, name, description }),
        'You are a crypto narrative analyst. Always respond with valid JSON only — no explanation, no markdown.'
      )
      searchTerms       = textResult.searchTerms      || []
      relationshipHints = textResult.relationshipHints || {}
      console.log(`[Vector0A] $${symbol} → ${searchTerms.length} text terms`)
    } catch (textErr) {
      console.warn(`[Vector0A] Text expansion failed for $${symbol}:`, textErr.message)
    }

    // ── Vector 0B: Image expansion ────────────────────────────────
    let visualTerms  = []
    let visualHints  = {}
    let mood         = null

    if (logoUrl) {
      try {
        const imgData = await fetchImageAsBase64(logoUrl)
        if (imgData && GROQ_SUPPORTED_TYPES.includes(imgData.mimeType)) {
          // Try Gemini first — better at visual cultural analysis
          try {
            const parts  = buildImageExpansionParts(symbol, name, imgData)
            const result = await callGemini(parts)
            visualTerms  = result.visualTerms || []
            visualHints  = result.visualHints  || {}
            mood         = result.mood         || null
            console.log(`[Vector0B] $${symbol} → ${visualTerms.length} visual terms via Gemini`)
          } catch (geminiErr) {
            if (isGeminiQuotaError(geminiErr)) {
              console.warn(`[Vector0B] Gemini quota — falling back to Groq vision for $${symbol}`)
              try {
                const result = await callGroqImageExpansion(symbol, name, imgData)
                visualTerms  = result.visualTerms || []
                visualHints  = result.visualHints  || {}
                mood         = result.mood         || null
                console.log(`[Vector0B] $${symbol} → ${visualTerms.length} visual terms via Groq`)
              } catch (groqErr) {
                console.warn(`[Vector0B] Groq vision fallback failed:`, groqErr.message)
              }
            } else {
              console.warn(`[Vector0B] Gemini error (non-quota):`, geminiErr.message)
            }
          }
        }
      } catch (imgErr) {
        console.warn(`[Vector0B] Image fetch failed for $${symbol}:`, imgErr.message)
      }
    }

    const data = {
      searchTerms,
      visualTerms,
      relationshipHints: { ...relationshipHints, ...visualHints },
      mood,
      expandedAt: Date.now(),
    }

    // Cache server-side — shared across all users
    expansionCache.set(address, { data, timestamp: Date.now(), mcap: marketCap || 0 })
    console.log(`[Vector0] $${symbol} cached — ${searchTerms.length} text + ${visualTerms.length} visual terms`)

    res.json({ ...data, fromCache: false })
  } catch (err) {
    console.error('[Vector0] Expand error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Szn categorization (Groq) ────────────────────────────────────
// Body: { tokens: [{symbol, name, description, address}], knownCategories: {...} }
app.post('/api/categorize-szn', async (req, res) => {
  try {
    const { tokens, knownCategories } = req.body
    if (!tokens?.length) return res.status(400).json({ error: 'tokens required' })

    const categoryList = Object.entries(knownCategories || {})
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

    const prompt = `You are analyzing Solana meme tokens to detect narrative themes for a crypto analytics tool.

KNOWN NARRATIVE CATEGORIES:
${categoryList}

UNMATCHED TOKENS (did not match any keyword filter — categorize these):
${tokenList}

For each token, determine:
1. Does it fit one of the KNOWN categories above? (use semantic understanding — $WHISKERS → cats, $BARKY → dogs)
2. If not, does it belong to a genuinely novel narrative that should get its own category?

Rules:
- Be generous with existing categories.
- Only create a "newNarrative" if it clearly doesn't fit anything above.
- newNarrative.key must be a short lowercase identifier (e.g. "gork", "foxes")
- newNarrative.label must be emoji + short name (e.g. "🦊 Foxes", "🦕 Gork")
- If a token is genuinely random with no clear theme, set both to null.

Respond ONLY with a JSON array. No explanation, no markdown. Example:
[
  {"index":0,"category":"cats","newNarrative":null},
  {"index":1,"category":null,"newNarrative":{"key":"foxes","label":"🦊 Foxes"}},
  {"index":2,"category":null,"newNarrative":null}
]`

    const result = await callGroq(
      prompt,
      'You are a crypto analyst. Always respond with valid JSON only — no explanation, no markdown fences.'
    )
    res.json(result)
  } catch (err) {
    console.error('Categorize error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Vision analysis (Gemini Flash) ──────────────────────────────
// Two modes:
//   classify: Body { mode: 'classify', tokens: [{symbol, name, logoUrl, address}] }
//   compare:  Body { mode: 'compare',  alpha: {..., logoUrl}, candidates: [{...logoUrl}] }
app.post('/api/analyze-vision', async (req, res) => {
  try {
    const { mode, tokens, alpha, candidates } = req.body

    if (mode === 'classify') {
      if (!tokens?.length) return res.status(400).json({ error: 'tokens required' })

      const withImages = (
        await Promise.all(
          tokens.map(async t => {
            const img = await fetchImageAsBase64(t.logoUrl)
            return img ? { ...t, img } : null
          })
        )
      ).filter(Boolean)

      if (withImages.length === 0) return res.json([])

      const parts = []
      withImages.forEach((t, i) => {
        parts.push({ text: `[${i}] Token: $${t.symbol} (${t.name || 'unknown'})` })
        parts.push({ inline_data: { mime_type: t.img.mimeType, data: t.img.base64 } })
      })
      parts.push({
        text: `For each token image above, identify:
1. What narrative/theme does this image represent? (e.g. cats, dogs, frogs, aliens, political figure, anime, space, gaming, food, memes, etc.)
2. A brief description of what you see (1 sentence max)

Respond ONLY with a JSON array. No markdown. Example:
[
  {"index":0,"category":"cats","description":"Orange cat with glowing eyes"},
  {"index":1,"category":"aliens","description":"Green alien holding a sign"},
  {"index":2,"category":null,"description":"Abstract geometric logo, unclear theme"}
]`,
      })

      let result
      try {
        result = await callGemini(parts)
        console.log('[Vision] Gemini classify OK')
      } catch (geminiErr) {
        if (isGeminiQuotaError(geminiErr)) {
          console.warn('[Vision] Gemini quota exhausted — falling back to Groq vision')
          const groqCompatible = filterForGroq(withImages)
          if (groqCompatible.length === 0) { res.json([]); return }
          result = await callGroqVision('classify', groqCompatible)
        } else {
          throw geminiErr
        }
      }
      const enriched = result.map(r => ({
        ...r,
        address: withImages[r.index]?.address,
        symbol:  withImages[r.index]?.symbol,
      }))
      res.json(enriched)

    } else if (mode === 'compare') {
      if (!alpha?.logoUrl) return res.status(400).json({ error: 'alpha.logoUrl required' })
      if (!candidates?.length) return res.json([])

      const alphaImg = await fetchImageAsBase64(alpha.logoUrl)
      if (!alphaImg) return res.json([])

      const withImages = (
        await Promise.all(
          candidates.map(async c => {
            const img = await fetchImageAsBase64(c.logoUrl)
            return img ? { ...c, img } : null
          })
        )
      ).filter(Boolean)

      if (withImages.length === 0) return res.json([])

      const parts = [
        { text: `ALPHA TOKEN: $${alpha.symbol} — this is the token we're analyzing for beta plays.` },
        { inline_data: { mime_type: alphaImg.mimeType, data: alphaImg.base64 } },
        { text: `CANDIDATE TOKENS — are any of these visually derived from the alpha above?` },
      ]

      withImages.forEach((c, i) => {
        parts.push({ text: `[${i}] $${c.symbol} (${c.name || ''})` })
        parts.push({ inline_data: { mime_type: c.img.mimeType, data: c.img.base64 } })
      })

      parts.push({
        text: `For each candidate, score visual relatedness to the ALPHA (0.0 to 1.0):
- 0.9-1.0: Directly derived — same character/art, recolored, wearing something, obvious copy
- 0.7-0.89: Same visual universe — same meme format, same cultural reference, same narrative
- 0.5-0.69: Loosely related — similar style or theme but not obviously the same
- 0.0-0.49: Unrelated visually

Respond ONLY with a JSON array. No markdown. Example:
[
  {"index":0,"visualScore":0.92,"visualReason":"Same frog character, recolored green"},
  {"index":1,"visualScore":0.3,"visualReason":"Different animal entirely, unrelated"}
]`,
      })

      let result
      try {
        result = await callGemini(parts)
        console.log('[Vision] Gemini compare OK')
      } catch (geminiErr) {
        if (isGeminiQuotaError(geminiErr)) {
          console.warn('[Vision] Gemini quota exhausted — falling back to Groq vision')
          const alphaWithImg = { ...alpha, img: alphaImg }
          // Skip if alpha itself is a GIF — can't compare without a valid reference image
          if (!GROQ_SUPPORTED_TYPES.includes(alphaImg.mimeType)) { res.json([]); return }
          const groqCompatible = filterForGroq(withImages)
          if (groqCompatible.length === 0) { res.json([]); return }
          result = await callGroqVision('compare', groqCompatible, alphaWithImg)
        } else {
          throw geminiErr
        }
      }
      const enriched = result.map(r => ({
        ...r,
        address: withImages[r.index]?.address,
        symbol:  withImages[r.index]?.symbol,
      }))
      res.json(enriched)

    } else {
      res.status(400).json({ error: 'mode must be "classify" or "compare"' })
    }

  } catch (err) {
    console.error('Vision error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Birdeye proxy ────────────────────────────────────────────────
app.get('/api/birdeye', async (req, res) => {
  const { endpoint, address } = req.query
  if (!address) return res.status(400).json({ error: 'address required' })

  const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY
  if (!BIRDEYE_KEY) return res.status(503).json({ error: 'Birdeye not configured' })

  const ENDPOINT_MAP = {
    token_overview: `https://public-api.birdeye.so/defi/token_overview?address=${address}`,
    holders:        `https://public-api.birdeye.so/v1/token/holder?address=${address}&offset=0&limit=10`,
  }

  const url = ENDPOINT_MAP[endpoint]
  if (!url) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  try {
    const response = await fetchWithRetry(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    })
    if (response.status === 404) return res.json({ data: null })
    if (!response.ok) throw new Error(`Birdeye ${response.status}`)

    // Guard: Birdeye occasionally returns an HTML error page instead of JSON
    // (e.g. during outages or when the CDN intercepts the request)
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      const raw = await response.text()
      console.warn('[Birdeye] Non-JSON response:', raw.slice(0, 100))
      return res.status(502).json({ error: 'Birdeye returned non-JSON response' })
    }

    res.json(await response.json())
  } catch (err) {
    console.error('Birdeye proxy error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// ─── PumpFun proxy ────────────────────────────────────────────────
app.get('/api/pumpfun', async (req, res) => {
  const { path: apiPath, ...params } = req.query
  if (!apiPath) return res.status(400).json({ error: 'path required' })

  const allowed = ['coins']
  if (!allowed.includes(apiPath)) return res.status(400).json({ error: 'unknown path' })

  const qs  = new URLSearchParams(params).toString()
  const url = `https://frontend-api.pump.fun/${apiPath}${qs ? '?' + qs : ''}`

  try {
    // 530 = Cloudflare CDN outage — no point retrying, fail fast
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    })
    if (response.status === 530) {
      console.warn('[PumpFun] CDN outage (530) — skipping retries')
      return res.status(503).json({ error: 'PumpFun CDN unavailable (530)' })
    }
    if (response.status === 429 || response.status >= 500) {
      // Only retry on rate limits and server errors — not CDN outages
      const retried = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      })
      if (!retried.ok) throw new Error(`PumpFun ${retried.status}`)

      const contentType = retried.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        return res.status(502).json({ error: 'PumpFun returned non-JSON response' })
      }
      return res.json(await retried.json())
    }
    if (!response.ok) throw new Error(`PumpFun ${response.status}`)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      return res.status(502).json({ error: 'PumpFun returned non-JSON response' })
    }
    res.json(await response.json())
  } catch (err) {
    console.error('PumpFun proxy error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`BetaPlays backend on port ${PORT}`))