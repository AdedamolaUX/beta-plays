// ─── BetaPlays Backend ────────────────────────────────────────────
// Endpoints:
//   POST /api/score-betas      — Vector 8 AI scoring
//                                Chain: Groq 70b → Groq Scout → OR Llama 70b → OR DeepSeek R1
//                                → Kimi K2.5 → OR Qwen 72b → Hunter Alpha → Gemini Flash
//                                → OR Gemini Flash → Kimi K2 Thinking → Groq 8b (last resort)
//   POST /api/categorize-szn   — Narrative categorization (same chain)
//   POST /api/analyze-vision   — Logo analysis: Gemini Flash → Groq vision → Healer Alpha
//   GET  /api/birdeye          — Birdeye data proxy
//   GET  /api/pumpfun          — PumpFun CORS proxy
//   GET  /health               — uptime check
//
// Keys live ONLY in server/.env — never in the frontend.
// Required: GROQ_API_KEY, GEMINI_API_KEY
// Optional: OPENROUTER_API_KEY (free at openrouter.ai — used as final fallback for Vector 8)

const express   = require('express')
const cors      = require('cors')
const rateLimit = require('express-rate-limit')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const telegramService = require('./telegramService')
const twitterService  = require('./twitterService')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))  // 10mb for base64 image payloads

// ─── Groq 70b daily limit tracker ─────────────────────────────────
// Groq's free tier caps llama-3.3-70b at ~100K tokens/day (resets UTC midnight).
// Instead of attempting it on every request and always failing + falling back,
// we track the first 429 with a daily-limit signature and skip it until reset.
// Per-minute TPM limits are NOT tracked here — those resolve in seconds.
let groq70bDailyLimitHit  = false
let groq70bLimitResetTime = 0

function isGroq70bAvailable () {
  if (!groq70bDailyLimitHit) return true
  if (Date.now() > groq70bLimitResetTime) {
    groq70bDailyLimitHit  = false
    groq70bLimitResetTime = 0
    console.log('[Groq70b] Daily limit reset — re-enabling')
    return true
  }
  return false
}

function markGroq70bDailyLimitHit () {
  groq70bDailyLimitHit = true
  // Next UTC midnight
  const now = new Date()
  groq70bLimitResetTime = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  )
  console.warn(`[Groq70b] Daily limit hit — skipping until ${new Date(groq70bLimitResetTime).toISOString()}`)
}

// ─── PumpFun / PumpPortal cache (10-minute TTL) ────────────────────
// PumpFun CDN has chronic 530 outages. We cache the last good response
// so a CDN blip doesn't wipe out all Vector 4 results mid-session.
// PumpPortal is used as a live fallback when PumpFun is unavailable.
const pumpFunCache = new Map()  // key: query string → { data, ts }
const PUMPFUN_CACHE_TTL = 10 * 60 * 1000  // 10 minutes

// Outage cooldown — when both PumpFun AND PumpPortal fail, mark as down
// for 5 minutes. Skips all PumpFun calls immediately instead of waiting
// 8s × 2 timeouts on every request. Same pattern as Groq 70b daily limit.
let pumpFunOutageUntil = 0
const PUMPFUN_OUTAGE_COOLDOWN = 5 * 60 * 1000  // 5 minutes
const isPumpFunDown = () => Date.now() < pumpFunOutageUntil
const markPumpFunDown = () => {
  pumpFunOutageUntil = Date.now() + PUMPFUN_OUTAGE_COOLDOWN
  console.warn(`[PumpFun] Both PumpFun + PumpPortal failed — cooling down until ${new Date(pumpFunOutageUntil).toISOString()}`)
}

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
      max_tokens:  1200,
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

// ─── MiMo V2 Omni vision fallback ────────────────────────────────
// Previously "Healer Alpha" — that model was deprecated March 18, 2026
// and replaced by xiaomi/mimo-v2-omni on OpenRouter.
// Omni-modal model supporting vision. Used when Gemini + Groq both exhausted.
const callHealerVision = async (parts, prompt) => {
  const OR_KEY = process.env.OPENROUTER_API_KEY
  if (!OR_KEY) throw new Error('OPENROUTER_API_KEY not configured')

  // MiMo V2 Omni uses OpenAI-compatible vision format
  const content = []
  parts.forEach(p => {
    if (p.text) {
      content.push({ type: 'text', text: p.text })
    } else if (p.inline_data) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` }
      })
    }
  })

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'HTTP-Referer':  'https://betaplays.app',
      'X-Title':       'BetaPlays',
    },
    body: JSON.stringify({
      model: 'xiaomi/mimo-v2-omni',
      max_tokens: 1000,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a crypto analyst. Always respond with valid JSON only.' },
        { role: 'user', content },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`MiMo V2 Omni error ${response.status}: ${err}`)
  }

  const data  = await response.json()
  const text  = data.choices?.[0]?.message?.content || ''
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

// ─── Gemini text scoring helper ──────────────────────────────────
// Uses the same Gemini key as vision but for pure text tasks.
// Gemini Flash has a generous free quota (15 req/min, 1500/day).
const callGeminiText = async (systemPrompt, userPrompt) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured')

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Gemini text error ${response.status}: ${err}`)
  }

  const data  = await response.json()
  const text  = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const clean = text.replace(/```json|```/g, '').trim()
  if (!clean) throw new Error('Gemini text returned empty response')
  return JSON.parse(clean)
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

  return `You are a crypto degen and narrative analyst. Find every beta play for this Solana meme token — tokens degens will ape alongside it due to narrative connection.

ALPHA TOKEN:
${context}

All terms must come from THIS token only. Examples below show reasoning style only — never copy them.

ANALYSIS (work through each step):

1. SYMBOL: Synonyms, antonyms, word family, semantic cluster of the raw ticker word.
   If it belongs to a set (colors, emotions, directions, quantities) — complete the entire set.

2. NAME: If name differs from symbol, break into individual words and expand each independently.
   Slang/misspellings → translate to standard English first, then expand.
   Name always overrides letter-pattern guessing.

3. WHOLE PHRASE: After individual words, treat the full name as one unified concept.
   What theme, archetype, or cultural reference does the combined phrase evoke?

4. DESCRIPTION: Mine additional narrative from description text.
   IGNORE charity mentions, fees, utility, partnerships — those are admin, not identity.
   Focus on what the token IS, not what it does with its treasury.

5. SUBJECT EXPANSION — expand in all four directions:
   A. SPECIES/FAMILY: If animal/creature, name every biological family member.
      Never stop at the name word — complete the full family.
      (ape → gorilla, chimp, orangutan, monkey, primate, bonobo)
   B. PROPS/ACCESSORIES/ACTIONS: What is the subject wearing, holding, doing?
      Degens name tokens after accessories. (hat → wif, cap, fedora / chain → drip, bling)
   C. SETTING/ENVIRONMENT: Where does this subject exist?
      (jungle ape → jungle, banana, vine / space → cosmos, nebula, ufo)
   D. DEGEN DERIVATIVES: What remix tokens would CT immediately spin up from this runner?
      (ape → babyape, evilape, darkape, apewif / pepe → babypepe, pepewif, sadpepe)

6. MANDATORY COUNTER — this step is required, never skip it:
   Every concept has an opposing force that runs BECAUSE this token runs.
   Name the direct antonym, the narrative enemy, the philosophical opposite.
   zen → chaos | bull → bear | light → dark | heaven → hell | order → chaos
   hot → cold | fast → slow | hero → villain | good → evil | rich → poor
   Output at least 1-2 COUNTER terms. Mark them COUNTER in relationshipHints.
   If the concept has an explicit dark/inverted version (evil twin, corrupted form,
   shadow self) — output that too and mark it EVIL_TWIN.
   zen → darkzen, chaoszen (EVIL_TWIN) | pepe → wojak (COUNTER) | bull → bear (COUNTER)

7. CRYPTO CULTURE: What ran alongside this narrative historically?
   What CT communities, collections, or movements does this connect to?
   What competing tokens or rival concepts exist in the same space?
   (zen → tao, buddha, monk as SECTOR rivals / ape → bayc, bored as UNIVERSE)

RELATIONSHIP TYPES (assign each term one):
TWIN=synonym/equivalent | COUNTER=direct opposite | ECHO=consequence/extension
UNIVERSE=same cultural world | SECTOR=same category | SPIN=loose derivative

RULES:
- No generic terms: solana/eth/crypto/token/coin/chain/cute/cool/funny/animal/pet/moon/pump/buy/sell
- Never output instruction words as search terms: opposite/synonym/counter/twin/echo/universe/sector
- No words already in the symbol or name
- Only terms specific enough to be a real meme token ticker
- 12-20 terms. Single words preferred. Compounds: output joined AND spaced forms, lowercase only.
- Anti-drift: each term must complete "This token IS/IS A TYPE OF/IS THE OPPOSITE OF/LIVES IN/Degens CREATE ___ from it"
  Biological family and cultural crypto associations never drift.

SELF-CHECK before outputting — remove any term that:
- Is a relationship label (opposite, synonym, twin, counter, echo, universe, sector)
- Could describe any random Solana token (too generic)
- You invented right now and likely doesn't exist as a real token name
- Needs more than one reasoning hop to connect to this token

ALSO VERIFY before outputting:
- Do your relationshipHints include at least one COUNTER? If not — add one now.
- Do your searchTerms include the direct antonym of the core concept? If not — add it.

8. CATEGORY — name this token's primary narrative universe in ONE short lowercase word or phrase.
   Use your own judgment — do NOT limit yourself to a fixed list. Examples of what good categories look like:
   "political" | "dogs" | "cats" | "frogs" | "space" | "ai" | "memes" | "anime" | "food" | "sports"
   "emoji" | "internet_culture" | "weather" | "chess" | "western" | "fitness" | "horror" | "gaming"
   These are EXAMPLES only — invent the right label for whatever universe this token lives in.
   If the token genuinely has no clear narrative universe, output null.
   One rule: the category must be specific enough that a human would recognise it as a distinct theme.
   "things" or "crypto" or "misc" are too vague — always drill down.

Respond ONLY with valid JSON, no markdown:
{"searchTerms":["term1","term2"],"relationshipHints":{"term1":"TWIN","term2":"COUNTER"},"category":"space"}`
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

Step 1 — IDENTIFY THE SUBJECT: What is the main character or object? Be specific about species/type.
  Good: "holstein cow", "shiba inu dog", "pepe frog", "raccoon", "astronaut"
  Bad: "animal", "character", "creature"

Step 2 — NOTABLE ACCESSORIES or ACTIONS: What is it wearing or doing that makes it unique?
  Good: "red baseball cap", "crying expression", "holding sign", "wearing suit"
  Bad: "colorful", "cute", "big eyes" — these describe every cartoon, useless

Step 3 — DEGEN ANGLE: What narrative would a meme token creator derive from this image?
  A cow farting → fart, gas, methane | A dog with hat → dogwif | A sad frog → pepe, feels

Output 3-5 terms: the SUBJECT (most important), then accessories, then the degen narrative angle.

Also note mood (happy/evil/stoic/chaotic/sad/angry).

Step 4 — VISUAL COUNTERS: What would be the visual opposite or antagonist of this logo?
  A cute panda → wolf, predator, hunter | A king → rebel, peasant, anarchist
  Trump → democrat, opponent | A bull → bear | Kawaii → dark, edgy, villain
  List 2–4 searchable counter concepts (not generic descriptors like "opposite").

Respond ONLY with valid JSON. No markdown:
{"visualTerms":["cow","bovine","fart","farm"],"visualCounters":["vegetable","vegan","farmer"],"mood":"happy","visualHints":{"cow":"TWIN","fart":"TWIN","farm":"UNIVERSE"}}`,
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
    text: `Step 1 — IDENTIFY THE SUBJECT: What is the main character or object? Be specific about species/type.
  Good: "holstein cow", "shiba inu dog", "pepe frog", "raccoon", "astronaut"
  Bad: "animal", "character", "creature"

Step 2 — NOTABLE ACCESSORIES or ACTIONS that make it unique:
  Good: "red baseball cap", "crying expression", "holding sign"
  Bad: "colorful", "cute", "big eyes", "fluffy texture" — generic, useless

Step 3 — DEGEN NARRATIVE ANGLE: What meme/narrative would this image inspire?
  Cow farting → fart, gas, methane | Dog with hat → dogwif | Sad frog → pepe, feels

Output 3-5 terms: subject first (most important), then accessories, then degen angle.
Also note mood (happy/evil/stoic/chaotic/sad/angry).

Respond ONLY with valid JSON. No markdown:
{"visualTerms":["cow","bovine","fart","farm"],"visualCounters":["vegetable","vegan","farmer"],"mood":"happy","visualHints":{"cow":"TWIN","fart":"TWIN","farm":"UNIVERSE"}}`,
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

    const SYSTEM = 'You are a crypto analyst. Always respond with valid JSON only — no explanation, no markdown fences.'

    // ── Unified fallback chain ────────────────────────────────────
    // Order: strongest/most-available first, weakest last.
    // 8b-instant moved to LAST — it's too weak for relationship scoring.
    // Gemini Flash added mid-chain — uses existing key, 1500 req/day free.
    const GROQ_KEY = process.env.GROQ_API_KEY
    const OR_KEY   = process.env.OPENROUTER_API_KEY
    const OR_HEADERS = { 'HTTP-Referer': 'https://betaplays.app', 'X-Title': 'BetaPlays' }

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: prompt },
    ]

    // Helper: call any OpenAI-compatible endpoint
    const tryOpenAI = async (url, key, model, extraHeaders = {}) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...extraHeaders },
        body: JSON.stringify({ model, max_tokens: 1000, temperature: 0.1, messages }),
      })
      if (!response.ok) {
        const errText = await response.text()
        if (response.status === 429) {
          const err = new Error('429')
          // Tag as daily limit if error body mentions per-day quota
          err.dailyLimit = errText.toLowerCase().includes('day') || errText.toLowerCase().includes('tpd')
          throw err
        }
        throw new Error(`${response.status}: ${errText}`)
      }
      const data  = await response.json()
      const text  = data.choices?.[0]?.message?.content || ''
      return JSON.parse(text.replace(/```json|```/g, '').trim())
    }

    // ── Fallback chain — ordered by quality for relationship scoring ──
    // 1.  Groq 70b           — fast, reliable, 100K TPD
    // 2.  Groq Scout 17b     — separate Groq quota
    // 3.  OR Llama 3.3 70b   — same quality as Groq 70b, free
    // 4.  OR DeepSeek R1     — strong reasoning, consistent JSON
    // 5.  Kimi K2.5          — 1T params, strong reasoning+general, free
    // 6.  OR Qwen 2.5 72b    — solid alternative, free
    // 7.  Hunter Alpha        — 1T params, large context, free (benchmarks "okay")
    // 8.  Gemini Flash        — existing key, 1500 req/day
    // 9.  OR Gemini Flash exp — free tier backup
    // 10. Kimi K2 Thinking   — best reasoning but slow + needs temp=1.0
    // 11. Groq 8b-instant    — last resort, too weak for nuanced scoring

    // 1. Groq 70b — 100K TPD, best Groq quality
    if (GROQ_KEY && isGroq70bAvailable()) {
      try {
        const result = await tryOpenAI('https://api.groq.com/openai/v1/chat/completions', GROQ_KEY, 'llama-3.3-70b-versatile')
        return res.json(result)
      } catch (e) {
        if (e.message !== '429') throw e
        // Distinguish TPM (per-minute) vs daily — daily errors mention 'day' in body
        if (e.dailyLimit) markGroq70bDailyLimitHit()
        else console.warn('[Vector8] llama-3.3-70b-versatile TPM hit — falling back')
      }
    } else if (groq70bDailyLimitHit) {
      console.warn('[Vector8] Groq 70b daily limit active — skipping to Scout')
    }

    // 2. Groq Scout 17b — separate quota
    if (GROQ_KEY) {
      try {
        const result = await tryOpenAI('https://api.groq.com/openai/v1/chat/completions', GROQ_KEY, 'meta-llama/llama-4-scout-17b-16e-instruct')
        console.log('[Vector8] Groq fallback: llama-4-scout-17b')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] llama-4-scout-17b quota hit') }
    }

    // 3. OR Llama 3.3 70b — same quality as Groq 70b
    if (OR_KEY) {
      try {
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'meta-llama/llama-3.3-70b-instruct:free', OR_HEADERS)
        console.log('[Vector8] OR fallback: llama-3.3-70b-instruct:free')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] OR llama-3.3-70b quota hit') }
    }

    // 4. OR DeepSeek V3 — R1:free removed from OR April 2026, V3-5 is replacement
    if (OR_KEY) {
      try {
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'deepseek/deepseek-chat-v3-5:free', OR_HEADERS)
        console.log('[Vector8] OR fallback: deepseek-v3-5:free')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] OR deepseek-v3-5 quota hit') }
    }

    // 5. Kimi K2.5 — 1T params, strong reasoning, free on OpenRouter
    if (OR_KEY) {
      try {
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'moonshotai/kimi-k2.5', OR_HEADERS)
        console.log('[Vector8] OR fallback: kimi-k2.5')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] Kimi K2.5 quota hit') }
    }

    // 5b. Gemma 4 31B — #3 open model, reasoning mode, strong classification quality
    // Released April 2025. Free on OpenRouter. Better reasoning than Qwen/Hunter.
    if (OR_KEY) {
      try {
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'google/gemma-4-31b-it', OR_HEADERS)
        console.log('[Vector8] OR fallback: gemma-4-31b-it')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] Gemma 4 31B quota hit') }
    }

    // 6. OR Qwen 2.5 72b — solid alternative
    if (OR_KEY) {
      try {
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'qwen/qwen-2.5-72b-instruct:free', OR_HEADERS)
        console.log('[Vector8] OR fallback: qwen-2.5-72b:free')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] OR qwen-2.5-72b quota hit') }
    }

    // 7. MiMo V2 Omni — formerly "Hunter Alpha", replaced March 18 2026
    if (OR_KEY) {
      try {
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'xiaomi/mimo-v2-omni', OR_HEADERS)
        console.log('[Vector8] OR fallback: mimo-v2-omni')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] MiMo V2 Omni quota hit') }
    }

    // 8. Gemini Flash — existing key, 1500 req/day
    try {
      const result = await callGeminiText(SYSTEM, prompt)
      console.log('[Vector8] Gemini Flash fallback used')
      return res.json(result)
    } catch (e) {
      if (!isGeminiQuotaError(e)) throw e
      console.warn('[Vector8] Gemini Flash quota hit')
    }

    // 9. OR Gemini Flash exp — free tier backup
    if (OR_KEY) {
      try {
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'google/gemini-2.0-flash-exp:free', OR_HEADERS)
        console.log('[Vector8] OR fallback: gemini-2.0-flash-exp:free')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] OR gemini-flash quota hit') }
    }

    // 10. Kimi K2 Thinking — best reasoning but slow, needs temp=1.0 for reliability
    if (OR_KEY) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OR_KEY}`, ...OR_HEADERS },
          body: JSON.stringify({ model: 'moonshotai/kimi-k2-thinking', max_tokens: 1000, temperature: 1.0, messages }),
        })
        if (!response.ok) { const t = await response.text(); if (response.status === 429) throw new Error('429'); throw new Error(t) }
        const data = await response.json()
        const text = data.choices?.[0]?.message?.content || ''
        const result = JSON.parse(text.replace(/```json|```/g, '').trim())
        console.log('[Vector8] OR fallback: kimi-k2-thinking')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] Kimi K2 Thinking quota hit') }
    }

    // 11. Groq 8b-instant — LAST RESORT only (too weak for nuanced scoring)
    if (GROQ_KEY) {
      try {
        const result = await tryOpenAI('https://api.groq.com/openai/v1/chat/completions', GROQ_KEY, 'llama-3.1-8b-instant')
        console.warn('[Vector8] ⚠️  8b-instant last resort — scoring quality degraded')
        return res.json(result)
      } catch (e) { if (e.message !== '429') throw e; console.warn('[Vector8] 8b-instant quota hit') }
    }

    // All models exhausted
    console.error('[Vector8] All models quota-exhausted for today')
    res.status(429).json({ error: 'All AI models quota exhausted. Resets at midnight UTC.' })

  } catch (err) {
    console.error('Score error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Vector 0: Alpha concept expansion (Groq + Gemini) ──────────
// Generates search terms + visual terms for the full beta scan.
// Server-side cached — shared across all users. One call per alpha.
// Cache invalidated on re-entry events (forceRefresh) or mcap growth.
// ── Clear expansion cache for a single address ────────────────
app.post('/api/clear-expansion-cache', (req, res) => {
  const { address } = req.body
  if (address) {
    expansionCache.delete(address)
    console.log(`[Vector0] Cache cleared for ${address}`)
    res.json({ cleared: true, address })
  } else {
    // Clear all
    expansionCache.clear()
    console.log('[Vector0] Full expansion cache cleared')
    res.json({ cleared: true, all: true })
  }
})

// ─── Warmup endpoint ──────────────────────────────────────────────
// Called on startup (and optionally by frontend) to pre-expand a list
// of tokens so the server-side cache is warm before the first user scan.
// Without this, cold Render starts hit Groq with 10+ simultaneous V0
// requests the moment the first user lands — causing rate limit cascades.
//
// Usage:
// ─── Shared background expansion helper ──────────────────────────
// Expands a single token's V0A terms and stores in expansionCache.
// Returns true if cached successfully, false otherwise.
// Used by both /api/warmup and /api/report-alphas.
const expandTokenToCache = async (token) => {
  if (!token.address || !token.symbol) return false

  const cached = expansionCache.get(token.address)
  if (isExpansionCacheValid(cached, token.marketCap, false)) return false // already warm

  const OR_KEY = process.env.OPENROUTER_API_KEY
  const expansionPrompt = buildExpansionPrompt(token)
  const expansionSystem = 'You are a crypto narrative analyst. Always respond with valid JSON only — no explanation, no markdown.'
  let textResult = null

  if (isGroq70bAvailable()) {
    try {
      textResult = await callGroq(expansionPrompt, expansionSystem)
    } catch (e) {
      if (e.message?.includes('429') || e.message?.includes('daily')) markGroq70bDailyLimitHit()
    }
  }

  if (!textResult && OR_KEY) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OR_KEY}`, 'HTTP-Referer': 'https://betaplays.app', 'X-Title': 'BetaPlays' },
        body: JSON.stringify({ model: 'google/gemma-4-26b-a4b-it', max_tokens: 1200, temperature: 0.1, messages: [{ role: 'system', content: expansionSystem }, { role: 'user', content: expansionPrompt }] }),
      })
      if (r.ok) {
        const d = await r.json()
        textResult = JSON.parse((d.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim())
      }
    } catch { /* fall through to Gemini */ }
  }

  if (!textResult) {
    try { textResult = await callGeminiText(expansionSystem, expansionPrompt) } catch { /* silent */ }
  }

  if (textResult) {
    const cacheData = {
      searchTerms:       textResult.searchTerms       || [],
      relationshipHints: textResult.relationshipHints || {},
      detectedCategory:  textResult.category          || null,
      visualTerms: [], visualCounters: [], visualHints: {}, mood: null,
      promptVersion: 'v6',
    }
    expansionCache.set(token.address, { data: cacheData, timestamp: Date.now(), mcap: token.marketCap || 0 })
    console.log(`[Warmup] $${token.symbol} → ${cacheData.searchTerms.length} terms cached`)
    return true
  }

  console.warn(`[Warmup] $${token.symbol} — all models failed`)
  return false
}

// ─── Background warmup queue ──────────────────────────────────────
// Prevents report-alphas from firing 30 simultaneous expansions.
// Tokens queue here and are processed one at a time with 400ms spacing.
let warmupRunning = false
const warmupQueue = []

const drainWarmupQueue = async () => {
  if (warmupRunning) return
  warmupRunning = true
  while (warmupQueue.length > 0) {
    const token = warmupQueue.shift()
    try { await expandTokenToCache(token) } catch { /* non-fatal */ }
    if (warmupQueue.length > 0) await new Promise(r => setTimeout(r, 400))
  }
  warmupRunning = false
}

// ─── Cache status (debug) ─────────────────────────────────────────
// GET /api/cache-status
// Returns a summary of what's in the server-side expansion cache.
// Useful for diagnosing Review 29 (deployed vs localhost discrepancy).
app.get('/api/cache-status', (req, res) => {
  const entries = []
  for (const [address, cached] of expansionCache.entries()) {
    const ageMin = Math.round((Date.now() - cached.timestamp) / 60000)
    entries.push({
      address: address.slice(0, 8) + '...',
      terms:   cached.data?.searchTerms?.length || 0,
      ageMin,
      valid:   isExpansionCacheValid(cached, null, false),
    })
  }
  res.json({
    cacheSize:          expansionCache.size,
    queueLength:        warmupQueue.length,
    warmupRunning,
    groq70bLimitActive: groq70bDailyLimitHit,
    pumpFunDown:        isPumpFunDown(),
    entries,
  })
})

// ─── Warmup endpoint ──────────────────────────────────────────────
// POST /api/warmup — accepts { tokens: [...] } or no body.
// Processes sequentially via shared expandTokenToCache.
app.post('/api/warmup', async (req, res) => {
  const tokens = req.body?.tokens?.length ? req.body.tokens : []
  if (tokens.length === 0) {
    return res.json({ ok: true, message: 'No tokens provided — warmup happens automatically via report-alphas', cacheSize: expansionCache.size })
  }

  let warmed = 0, skipped = 0, failed = 0
  console.log(`[Warmup] Manual warmup of ${tokens.length} tokens...`)

  for (const token of tokens) {
    if (!token.address || !token.symbol) { failed++; continue }
    const cached = expansionCache.get(token.address)
    if (isExpansionCacheValid(cached, token.marketCap, false)) { skipped++; continue }
    const ok = await expandTokenToCache(token)
    ok ? warmed++ : failed++
    if (warmed + failed < tokens.length) await new Promise(r => setTimeout(r, 400))
  }

  console.log(`[Warmup] Manual warmup done — warmed: ${warmed}, skipped: ${skipped}, failed: ${failed}`)
  res.json({ ok: true, warmed, skipped, failed, cacheSize: expansionCache.size })
})

// ─── Vector 0 — Alpha expansion ──────────────────────────────────
// POST /api/expand-alpha
// Body: { address, symbol, name, description, logoUrl, marketCap, forceRefresh }
app.post('/api/expand-alpha', async (req, res) => {
  try {
    const { address, symbol, name, description, logoUrl, marketCap, forceRefresh } = req.body
    if (!address || !symbol) return res.status(400).json({ error: 'address and symbol required' })

    const OR_KEY = process.env.OPENROUTER_API_KEY  // needed for Gemma 4 calls

    // Check server-side cache first
    const cached = expansionCache.get(address)
    if (isExpansionCacheValid(cached, marketCap, forceRefresh)) {
      console.log(`[Vector0] Cache hit for $${symbol}`)
      return res.json({ ...cached.data, fromCache: true })
    }

    console.log(`[Vector0] Expanding $${symbol}${forceRefresh ? ' (forced refresh)' : ''}...`)

    // ── Vector 0A: Text expansion ─────────────────────────────────
    // Model chain priority:
    //   1. Groq 70b          — fastest, reliable, known quality (100K TPD)
    //   2. Gemma 4 26B MoE   — #6 open model, fast MoE (3.8B active params),
    //                          free on OpenRouter, comparable quality to 31B
    //   3. Gemini Flash      — generous quota (1500/day), strong reasoning
    //   empty if all fail    — symbol decomposition carries the search
    //                          (better than broken 8b JSON cached as 0 terms)
    let searchTerms      = []
    let relationshipHints = {}
    let detectedCategory  = null  // V0A-inferred narrative category — feeds MetaSeed + category seeding

    try {
      const expansionPrompt = buildExpansionPrompt({ symbol, name, description })
      const expansionSystem = 'You are a crypto narrative analyst. Always respond with valid JSON only — no explanation, no markdown.'

      let textResult = null

      // 1. Groq 70b — fastest, best quota for our usage
      if (isGroq70bAvailable()) {
        try {
          console.log(`[Vector0A] $${symbol} — trying Groq 70b...`)
          textResult = await callGroq(expansionPrompt, expansionSystem)
          console.log(`[Vector0A] $${symbol} → Groq 70b → ${(textResult?.searchTerms||[]).length} terms`)
        } catch (groq70Err) {
          if (groq70Err.message?.includes('429') || groq70Err.message?.includes('rate') || groq70Err.message?.includes('daily')) {
            markGroq70bDailyLimitHit()
            console.warn(`[Vector0A] Groq 70b quota hit — trying Gemma 4 26B MoE`)
          } else {
            console.warn(`[Vector0A] Groq 70b error:`, groq70Err.message)
          }
        }
      } else {
        console.log(`[Vector0A] $${symbol} — Groq 70b daily limit active, trying Gemma 4 26B MoE`)
      }

      // 2. Gemma 4 26B MoE — #6 open model, fast inference (3.8B active params)
      // Free on OpenRouter. Strong reasoning, 256K context, native function calling.
      // MoE variant chosen over 31B for speed — comparable quality, much faster.
      if (!textResult && OR_KEY) {
        try {
          console.log(`[Vector0A] $${symbol} — trying Gemma 4 26B MoE...`)
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${OR_KEY}`,
              'HTTP-Referer':  'https://betaplays.app',
              'X-Title':       'BetaPlays',
            },
            body: JSON.stringify({
              model:       'google/gemma-4-26b-a4b-it',
              max_tokens:  1200,
              temperature: 0.1,
              messages: [
                { role: 'system', content: expansionSystem },
                { role: 'user',   content: expansionPrompt },
              ],
            }),
          })
          if (!response.ok) {
            const errText = await response.text()
            throw new Error(`Gemma 4 MoE ${response.status}: ${errText.slice(0, 100)}`)
          }
          const data = await response.json()
          const text = data.choices?.[0]?.message?.content || ''
          const clean = text.replace(/```json|```/g, '').trim()
          textResult = JSON.parse(clean)
          console.log(`[Vector0A] $${symbol} → Gemma 4 26B MoE → ${(textResult?.searchTerms||[]).length} terms`)
        } catch (gemma4Err) {
          console.warn(`[Vector0A] Gemma 4 26B MoE failed:`, gemma4Err.message)
        }
      }

      // 3. Gemini Flash — generous quota fallback
      if (!textResult) {
        try {
          console.log(`[Vector0A] $${symbol} — trying Gemini Flash...`)
          textResult = await callGeminiText(expansionSystem, expansionPrompt)
          console.log(`[Vector0A] $${symbol} → Gemini Flash → ${(textResult?.searchTerms||[]).length} terms`)
        } catch (geminiErr) {
          console.warn(`[Vector0A] Gemini Flash failed:`, geminiErr.message)
        }
      }

      if (!textResult) {
        console.warn(`[Vector0A] $${symbol} — all models failed, returning empty (symbol decomposition takes over)`)
      }

      if (textResult) {
        searchTerms       = textResult.searchTerms      || []
        relationshipHints = textResult.relationshipHints || {}
        detectedCategory  = textResult.category          || null
        if (detectedCategory) {
          console.log(`[Vector0A] $${symbol} → AI category: "${detectedCategory}"`)
        } else {
          console.log(`[Vector0A] $${symbol} → no category returned (null)`)
        }
        console.log(`[Vector0A] $${symbol} → ${searchTerms.length} text terms`)
        if (searchTerms.length === 0) {
          // Log raw response when AI returned valid JSON but empty terms — helps diagnose prompt issues
          console.warn(`[Vector0A] $${symbol} — zero search terms in response. Raw keys: ${Object.keys(textResult).join(', ')}`)
        }
      }
    } catch (textErr) {
      console.warn(`[Vector0A] Text expansion failed for $${symbol}:`, textErr.message)
    }

    // ── Vector 0B: Image expansion ────────────────────────────────
    // Model chain priority:
    //   1. Gemini Flash    — best cultural/visual analysis, existing key
    //   2. Gemma 4 31B     — vision benchmark leader, better than Gemini
    //                        on charts/diagrams/logo understanding
    //   3. Groq vision     — last resort (Llama 4 Scout)
    let visualTerms    = []
    let visualCounters = []
    let visualHints  = {}
    let mood         = null

    if (logoUrl) {
      try {
        const imgData = await fetchImageAsBase64(logoUrl)
        if (imgData && GROQ_SUPPORTED_TYPES.includes(imgData.mimeType)) {

          // 1. Gemini — primary vision model
          try {
            const parts  = buildImageExpansionParts(symbol, name, imgData)
            const result = await callGemini(parts)
            visualTerms  = result.visualTerms || []
                    visualCounters = result.visualCounters || []
            visualHints  = result.visualHints  || {}
            mood         = result.mood         || null
            console.log(`[Vector0B] $${symbol} → ${visualTerms.length} visual terms via Gemini`)
          } catch (geminiErr) {
            if (isGeminiQuotaError(geminiErr)) {
              console.warn(`[Vector0B] Gemini quota — trying Gemma 4 31B vision for $${symbol}`)

              // 2. Gemma 4 31B — superior vision benchmarks, free on OpenRouter
              // Handles charts, diagrams, logos better than Gemini on visual tasks.
              // Uses same prompt structure as Groq vision (OpenAI-compatible format).
              if (OR_KEY) {
                try {
                  const visionContent = [
                    {
                      type: 'image_url',
                      image_url: { url: `data:${imgData.mimeType};base64,${imgData.base64}` },
                    },
                    {
                      type: 'text',
                      text: `This is the logo of Solana meme token $${symbol}${name && name.toLowerCase() !== symbol.toLowerCase() ? ' (' + name + ')' : ''}.

Step 1 — IDENTIFY THE SUBJECT: What is the main character or object? Be specific about species/type.
  Good: "holstein cow", "shiba inu dog", "pepe frog", "raccoon", "astronaut"
  Bad: "animal", "character", "creature"

Step 2 — NOTABLE ACCESSORIES or ACTIONS: What is it wearing or doing that makes it unique?
  Good: "red baseball cap", "crying expression", "holding sign", "wearing suit"
  Bad: "colorful", "cute", "big eyes"

Step 3 — DEGEN NARRATIVE ANGLE: What narrative would a meme token creator derive from this image?
  Cow farting → fart, gas, methane | Dog with hat → dogwif | Sad frog → pepe, feels

Output 3-5 terms: the SUBJECT (most important), then accessories, then degen narrative angle.
Also note mood (happy/evil/stoic/chaotic/sad/angry).

Step 4 — VISUAL COUNTERS: What would be the visual opposite or antagonist of this logo?
  A cute panda → wolf, predator, hunter | A king → rebel, peasant, anarchist
  Trump → democrat, opponent | A bull → bear | Kawaii → dark, edgy, villain
  List 2–4 searchable counter concepts (not generic descriptors like "opposite").

Respond ONLY with valid JSON. No markdown:
{"visualTerms":["cow","bovine","fart","farm"],"visualCounters":["vegetable","vegan","farmer"],"mood":"happy","visualHints":{"cow":"TWIN","fart":"TWIN","farm":"UNIVERSE"}}`,
                    },
                  ]
                  const gemma4Res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                      'Content-Type':  'application/json',
                      'Authorization': `Bearer ${OR_KEY}`,
                      'HTTP-Referer':  'https://betaplays.app',
                      'X-Title':       'BetaPlays',
                    },
                    body: JSON.stringify({
                      model:       'google/gemma-4-31b-it',
                      max_tokens:  400,
                      temperature: 0.1,
                      messages: [{ role: 'user', content: visionContent }],
                    }),
                  })
                  if (!gemma4Res.ok) throw new Error(`Gemma 4 vision ${gemma4Res.status}`)
                  const gemma4Data = await gemma4Res.json()
                  const gemma4Text = gemma4Data.choices?.[0]?.message?.content || ''
                  const result = JSON.parse(gemma4Text.replace(/```json|```/g, '').trim())
                  visualTerms  = result.visualTerms || []
                    visualCounters = result.visualCounters || []
                  visualHints  = result.visualHints  || {}
                  mood         = result.mood         || null
                  console.log(`[Vector0B] $${symbol} → ${visualTerms.length} visual terms via Gemma 4 31B`)
                } catch (gemma4Err) {
                  console.warn(`[Vector0B] Gemma 4 31B vision failed:`, gemma4Err.message)

                  // 3. Groq vision — last resort
                  try {
                    const result = await callGroqImageExpansion(symbol, name, imgData)
                    visualTerms  = result.visualTerms || []
                    visualCounters = result.visualCounters || []
                    visualHints  = result.visualHints  || {}
                    mood         = result.mood         || null
                    console.log(`[Vector0B] $${symbol} → ${visualTerms.length} visual terms via Groq`)
                  } catch (groqErr) {
                    console.warn(`[Vector0B] Groq vision fallback failed:`, groqErr.message)
                  }
                }
              } else {
                // No OR key — fall straight to Groq vision
                try {
                  const result = await callGroqImageExpansion(symbol, name, imgData)
                  visualTerms  = result.visualTerms || []
                    visualCounters = result.visualCounters || []
                  visualHints  = result.visualHints  || {}
                  mood         = result.mood         || null
                  console.log(`[Vector0B] $${symbol} → ${visualTerms.length} visual terms via Groq`)
                } catch (groqErr) {
                  console.warn(`[Vector0B] Groq vision fallback failed:`, groqErr.message)
                }
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

    const PROMPT_VERSION = 'v6'  // Bump when expansion prompt changes significantly
    const data = {
      searchTerms,
      visualTerms,
      visualCounters,
      relationshipHints: { ...relationshipHints, ...visualHints },
      mood,
      category: detectedCategory,  // V0A-inferred category — used by MetaSeed + category seeding in frontend
      promptVersion: PROMPT_VERSION,
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

    const GROQ_KEY = process.env.GROQ_API_KEY
    const OR_KEY   = process.env.OPENROUTER_API_KEY
    const SYSTEM   = 'You are a crypto analyst. Always respond with valid JSON only — no explanation, no markdown fences.'
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: prompt },
    ]

    // Same ordered chain as score-betas — 8b-instant last
    const OR_HEADERS = { 'HTTP-Referer': 'https://betaplays.app', 'X-Title': 'BetaPlays' }

    const tryModel = async (url, key, model, extraHeaders = {}) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...extraHeaders },
        body: JSON.stringify({ model, max_tokens: 1000, temperature: 0.1, messages }),
      })
      if (!response.ok) {
        const errText = await response.text()
        if (response.status === 429) throw new Error('429')
        throw new Error(`${response.status}:${errText}`)
      }
      const data  = await response.json()
      const text  = data.choices?.[0]?.message?.content || ''
      return JSON.parse(text.replace(/```json|```/g, '').trim())
    }

    const CHAIN = [
      { url: 'https://api.groq.com/openai/v1/chat/completions',   key: GROQ_KEY, model: 'llama-3.3-70b-versatile',                      headers: {},         tag: 'Groq 70b'           },
      { url: 'https://api.groq.com/openai/v1/chat/completions',   key: GROQ_KEY, model: 'meta-llama/llama-4-scout-17b-16e-instruct',     headers: {},         tag: 'Groq Scout'         },
      { url: 'https://openrouter.ai/api/v1/chat/completions',     key: OR_KEY,   model: 'meta-llama/llama-3.3-70b-instruct:free',        headers: OR_HEADERS, tag: 'OR llama-70b'       },
      { url: 'https://openrouter.ai/api/v1/chat/completions',     key: OR_KEY,   model: 'deepseek/deepseek-chat-v3-5:free',                 headers: OR_HEADERS, tag: 'OR deepseek-v3-5'  },
      { url: 'https://openrouter.ai/api/v1/chat/completions',     key: OR_KEY,   model: 'moonshotai/kimi-k2.5',                          headers: OR_HEADERS, tag: 'Kimi K2.5'          },
      { url: 'https://openrouter.ai/api/v1/chat/completions',     key: OR_KEY,   model: 'qwen/qwen-2.5-72b-instruct:free',               headers: OR_HEADERS, tag: 'OR qwen-72b'        },
      { url: 'https://openrouter.ai/api/v1/chat/completions',     key: OR_KEY,   model: 'xiaomi/mimo-v2-omni',                              headers: OR_HEADERS, tag: 'MiMo V2 Omni'       },
      { url: 'https://openrouter.ai/api/v1/chat/completions',     key: OR_KEY,   model: 'google/gemini-2.0-flash-exp:free',              headers: OR_HEADERS, tag: 'OR gemini-flash'    },
      { url: 'https://api.groq.com/openai/v1/chat/completions',   key: GROQ_KEY, model: 'llama-3.1-8b-instant',                         headers: {},         tag: 'Groq 8b (last resort)' },
    ]

    for (const { url, key, model, headers, tag } of CHAIN) {
      if (!key) continue
      try {
        const result = await tryModel(url, key, model, headers)
        if (tag !== 'Groq 70b') console.log(`[SznAI] Fallback used: ${tag}`)
        return res.json(result)
      } catch (err) {
        if (err.message === '429') { console.warn(`[SznAI] ${tag} quota hit`); continue }
        throw err
      }
    }

    // Gemini Flash — separate call format, 1500 req/day
    try {
      const result = await callGeminiText(SYSTEM, prompt)
      console.log('[SznAI] Gemini Flash fallback used')
      return res.json(result)
    } catch (e) { console.warn('[SznAI] Gemini Flash failed:', e.message) }

    // Kimi K2 Thinking — best reasoning, slower, temp=1.0
    if (OR_KEY) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OR_KEY}`, ...OR_HEADERS },
          body: JSON.stringify({ model: 'moonshotai/kimi-k2-thinking', max_tokens: 1000, temperature: 1.0, messages }),
        })
        if (!response.ok) { const t = await response.text(); if (response.status === 429) throw new Error('429'); throw new Error(t) }
        const data = await response.json()
        const text = data.choices?.[0]?.message?.content || ''
        const result = JSON.parse(text.replace(/```json|```/g, '').trim())
        console.log('[SznAI] Kimi K2 Thinking fallback used')
        return res.json(result)
      } catch (e) { console.warn('[SznAI] Kimi K2 Thinking failed:', e.message) }
    }

    res.status(429).json({ error: 'All AI models quota exhausted. Resets at midnight UTC.' })
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
        if (!isGeminiQuotaError(geminiErr)) throw geminiErr
        console.warn('[Vision] Gemini quota exhausted — trying Groq vision')
        try {
          const groqCompatible = filterForGroq(withImages)
          if (groqCompatible.length === 0) { res.json([]); return }
          result = await callGroqVision('classify', groqCompatible)
          console.log('[Vision] Groq vision classify OK')
        } catch (groqErr) {
          console.warn('[Vision] Groq vision failed — trying MiMo V2 Omni')
          result = await callHealerVision(parts, 'classify')
          console.log('[Vision] MiMo V2 Omni classify OK')
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

      // Build visual context string from V0B terms if provided
      const visualCtx = alpha.visualTerms?.length
        ? `\nAlpha logo depicts: ${alpha.visualTerms.join(', ')}.${
            alpha.visualCounters?.length
              ? ` Visual opposites/antagonists: ${alpha.visualCounters.join(', ')}.`
              : ''
          } Score candidates that match either the depicted subject OR its visual opposite.`
        : ''

      const parts = [
        { text: `ALPHA TOKEN: $${alpha.symbol} — this is the token we're analyzing for beta plays.${visualCtx}` },
        { inline_data: { mime_type: alphaImg.mimeType, data: alphaImg.base64 } },
        { text: `CANDIDATE TOKENS — are any of these visually derived from, or the visual opposite of, the alpha above?` },
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
        if (!isGeminiQuotaError(geminiErr)) throw geminiErr
        console.warn('[Vision] Gemini quota exhausted — trying Groq vision')
        try {
          const alphaWithImg = { ...alpha, img: alphaImg }
          if (!GROQ_SUPPORTED_TYPES.includes(alphaImg.mimeType)) { res.json([]); return }
          const groqCompatible = filterForGroq(withImages)
          if (groqCompatible.length === 0) { res.json([]); return }
          result = await callGroqVision('compare', groqCompatible, alphaWithImg)
          console.log('[Vision] Groq vision compare OK')
        } catch (groqErr) {
          console.warn('[Vision] Groq vision failed — trying MiMo V2 Omni')
          result = await callHealerVision(parts, 'compare')
          console.log('[Vision] MiMo V2 Omni compare OK')
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

  const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY
  if (!BIRDEYE_KEY) return res.status(503).json({ error: 'Birdeye not configured' })

  // trending endpoint doesn't need an address
  const ENDPOINT_MAP = {
    token_overview: address ? `https://public-api.birdeye.so/defi/token_overview?address=${address}` : null,
    holders:        address ? `https://public-api.birdeye.so/v1/token/holder?address=${address}&offset=0&limit=10` : null,
    // Top gainers by 24h % change — finds organic runners not in DEXScreener boost feed
    // token_trending requires paid plan — use tokenlist sorted by 24h% change instead
    // tokenlist is available on free tier and sorts by the same metric we need
    trending:       `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=50&min_liquidity=5000`,
    // Top by volume — catches high-activity tokens regardless of % change
    top_volume:     `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=20&min_liquidity=10000`,
  }

  if (!address && ['token_overview','holders'].includes(endpoint)) {
    return res.status(400).json({ error: 'address required for this endpoint' })
  }

  const url = ENDPOINT_MAP[endpoint]
  if (!url) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  console.log(`[Birdeye] Calling: ${url}`)
  console.log(`[Birdeye] Key present: ${!!BIRDEYE_KEY} (${BIRDEYE_KEY ? BIRDEYE_KEY.slice(0,8) + '...' : 'MISSING'})`)

  try {
    const response = await fetchWithRetry(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    })
    console.log(`[Birdeye] Response status: ${response.status}`)
    if (response.status === 404) return res.json({ data: null })
    if (response.status === 400) {
      console.warn(`[Birdeye] 400 on ${endpoint} — endpoint may require higher tier or key is invalid`)
      return res.status(400).json({ error: `Birdeye 400 — check API key tier for ${endpoint}` })
    }
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

// ─── PumpFun metadata proxy ───────────────────────────────────────
// PumpFun blocks direct browser fetch (CORS). Backend proxies the
// request server-side to bypass this restriction.
// Used by Vector 1b Source 8 to fetch token descriptions for
// PumpFun-launched tokens — their descriptions only live in PumpFun's
// API, not in DEXScreener or Birdeye.
// GET /api/pumpfun-metadata?address={address}
app.get('/api/pumpfun-metadata', async (req, res) => {
  const { address } = req.query
  if (!address) return res.status(400).json({ error: 'address required' })

  // Skip if PumpFun is in outage cooldown
  if (isPumpFunDown()) {
    console.warn(`[PumpFunMeta] Outage cooldown active — skipping ${address}`)
    return res.status(503).json({ error: 'PumpFun outage — cooling down' })
  }

  try {
    const response = await fetch(
      `https://frontend-api.pump.fun/coins/${address}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BetaPlays/1.0)',
          'Accept':     'application/json',
        },
      }
    )
    if (!response.ok) {
      console.warn(`[PumpFunMeta] ${address} → ${response.status}`)
      return res.status(response.status).json({ error: `PumpFun returned ${response.status}` })
    }
    const data = await response.json()
    console.log(`[PumpFunMeta] ${address} → description: "${(data?.description || '').slice(0, 60)}"`)
    res.json({ description: data?.description || '', name: data?.name || '', symbol: data?.symbol || '' })
  } catch (err) {
    console.error('[PumpFunMeta] fetch error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// ─── PumpFun proxy ────────────────────────────────────────────────
app.get('/api/pumpfun', async (req, res) => {
  const { path: apiPath, ...params } = req.query
  if (!apiPath) return res.status(400).json({ error: 'path required' })

  const allowed = ['coins']
  if (!allowed.includes(apiPath)) return res.status(400).json({ error: 'unknown path' })

  const qs       = new URLSearchParams(params).toString()
  const cacheKey = `${apiPath}?${qs}`

  // ── Serve from cache if fresh ──────────────────────────────────
  const cached = pumpFunCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < PUMPFUN_CACHE_TTL) {
    console.log(`[PumpFun] Cache hit for ${cacheKey}`)
    return res.json(cached.data)
  }

  // ── Skip if both sources recently failed ───────────────────────
  if (isPumpFunDown()) {
    console.warn(`[PumpFun] Outage cooldown active — skipping until ${new Date(pumpFunOutageUntil).toISOString()}`)
    if (cached) {
      const ageMin = Math.round((Date.now() - cached.ts) / 60000)
      console.warn(`[PumpFun] Serving stale cache (${ageMin}m old) during cooldown`)
      return res.json(cached.data)
    }
    return res.status(503).json({ error: 'PumpFun outage — cooling down' })
  }

  // ── Try PumpFun first ──────────────────────────────────────────
  const pumpFunUrl = `https://frontend-api.pump.fun/${apiPath}${qs ? '?' + qs : ''}`
  try {
    const response = await fetch(pumpFunUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    })

    if (response.status === 530) {
      console.warn('[PumpFun] CDN outage (530) — trying PumpPortal fallback')
      throw new Error('CDN_OUTAGE')
    }
    if (response.status === 429 || response.status >= 500) {
      const retried = await fetchWithRetry(pumpFunUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      })
      if (!retried.ok) throw new Error(`PumpFun ${retried.status}`)
      const contentType = retried.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) throw new Error('NON_JSON')
      const data = await retried.json()
      pumpFunCache.set(cacheKey, { data, ts: Date.now() })
      return res.json(data)
    }
    if (!response.ok) throw new Error(`PumpFun ${response.status}`)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) throw new Error('NON_JSON')

    const data = await response.json()
    pumpFunCache.set(cacheKey, { data, ts: Date.now() })
    return res.json(data)

  } catch (pumpErr) {
    console.warn(`[PumpFun] Failed (${pumpErr.message}) — trying PumpPortal`)

    // ── PumpPortal fallback ──────────────────────────────────────
    // Maps PumpFun query params to PumpPortal's equivalent endpoint.
    // Returns same coin shape — symbol, name, mint, usd_market_cap.
    try {
      const sort  = params.sort  || 'last_trade_timestamp'
      const order = params.order || 'DESC'
      const limit = params.limit || 100
      // PumpPortal: /api/data/coins?orderby=last_trade_timestamp&order=DESC&limit=100
      const ppUrl = `https://pumpportal.fun/api/data/coins?orderby=${sort}&order=${order}&limit=${limit}&includeNsfw=false`
      const ppRes = await fetch(ppUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (!ppRes.ok) throw new Error(`PumpPortal ${ppRes.status}`)
      const ppContentType = ppRes.headers.get('content-type') || ''
      if (!ppContentType.includes('application/json')) throw new Error('PumpPortal non-JSON')

      const ppData = await ppRes.json()
      console.log(`[PumpPortal] Fallback success — ${ppData.length || 0} coins`)
      // Cache the fallback result too
      pumpFunCache.set(cacheKey, { data: ppData, ts: Date.now() })
      return res.json(ppData)
    } catch (ppErr) {
      console.error(`[PumpPortal] Fallback also failed: ${ppErr.message}`)

      // Mark both sources as down — skip for 5 minutes
      markPumpFunDown()

      // ── Last resort: serve stale cache rather than empty ──────
      if (cached) {
        const ageMin = Math.round((Date.now() - cached.ts) / 60000)
        console.warn(`[PumpFun] Serving stale cache (${ageMin}m old)`)
        return res.json(cached.data)
      }

      return res.status(503).json({ error: 'PumpFun and PumpPortal both unavailable' })
    }
  }
})

// ─── Telegram Vector 10 endpoints ────────────────────────────────

// GET /api/telegram-betas?symbol=WIF
// Returns pre-computed cached beta results for a given alpha symbol.
// Zero processing on request — all heavy work happens in background poller.
app.get('/api/telegram-betas', (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  const results = telegramService.getTelegramBetas(symbol)
  return res.json({ symbol, results })
})

// ─── Twitter Vector 11 endpoint (stub) ───────────────────────────

// GET /api/twitter-betas?symbol=WIF
// Returns [] until Twitter credentials added to .env.
// Same interface as /api/telegram-betas — frontend treats them identically.
app.get('/api/twitter-betas', (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  const results = twitterService.getTwitterBetas(symbol)
  return res.json({ symbol, results })
})

// POST /api/report-alphas
// Frontend posts its current alpha list so telegramService knows what to
// match against during polling. Called automatically on each alpha refresh.
// Also queues any uncached alphas for background V0 expansion — this is
// the primary warmup mechanism. Static seed lists removed in Session 24.
// Body: { alphas: [{ symbol, name, address, description, logoUrl, marketCap }, ...] }
app.post('/api/report-alphas', (req, res) => {
  const { alphas } = req.body
  if (!Array.isArray(alphas)) return res.status(400).json({ error: 'alphas array required' })

  telegramService.updateKnownAlphas(alphas)
  twitterService.updateKnownAlphas(alphas)

  // Queue uncached tokens for background V0 expansion.
  // Already-cached tokens are skipped inside expandTokenToCache.
  // Queue deduplication: don't add if already queued.
  const queuedAddresses = new Set(warmupQueue.map(t => t.address))
  let queued = 0
  for (const alpha of alphas) {
    if (!alpha.address || !alpha.symbol) continue
    const cached = expansionCache.get(alpha.address)
    if (isExpansionCacheValid(cached, alpha.marketCap, false)) continue
    if (queuedAddresses.has(alpha.address)) continue
    warmupQueue.push(alpha)
    queuedAddresses.add(alpha.address)
    queued++
  }

  if (queued > 0) {
    console.log(`[Warmup] ${queued} new alphas queued for background expansion (queue size: ${warmupQueue.length})`)
    drainWarmupQueue() // non-blocking — runs in background
  }

  return res.json({ ok: true, count: alphas.length, queued })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`BetaPlays backend on port ${PORT}`)
  // Initialise Telegram service after server is up
  telegramService.init().catch(err =>
    console.error('[TelegramService] Init failed:', err.message)
  )
  // Initialise Twitter service (stub — logs status, no-ops until credentials added)
  twitterService.init().catch(err =>
    console.error('[TwitterService] Init failed:', err.message)
  )
  // Expansion cache warmup is now driven by /api/report-alphas.
  // Frontend calls report-alphas on every alpha refresh (every 30s).
  // Any alpha not in cache gets queued for background V0 expansion automatically.
  // No static seed list needed — cache always mirrors the live feed.
  console.log('[Warmup] Cache warming driven by live feed via report-alphas')
})