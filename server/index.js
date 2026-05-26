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

const express     = require('express')
const cors        = require('cors')
const rateLimit   = require('express-rate-limit')
const compression = require('compression')
const jwt       = require('jsonwebtoken')
const nacl      = require('tweetnacl')
const { PublicKey } = require('@solana/web3.js')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const telegramService = require('./telegramService')
const twitterService  = require('./twitterService')
const newsService     = require('./newsService')
const db = require('./db')
const { cacheGet, cacheSet, loadExpansionCache } = require('./db')

const app = express()
app.use(compression()) // gzip all responses — cuts egress 60-80%
app.use(cors())
app.use(express.json({ limit: '10mb' }))

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
  console.warn(`[PumpFun] All sources failed (PumpFun + PumpPortal + DEXScreener) — cooling down until ${new Date(pumpFunOutageUntil).toISOString()}`)
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

7b. DISEASE / HORROR / THREAT EXPANSION — if the token references a disease, virus,
    biological threat, horror concept, or real-world danger event:
    A. CARRIERS & VECTORS: What animals or organisms carry/spread this?
       (hantavirus → rat, mouse, rodent, deer mouse / rabies → bat, dog, wolf)
    B. SYMPTOMS & EFFECTS: What does it cause?
       (hantavirus → fever, lung, respiratory / plague → death, blackdeath, skull)
    C. PHARMACEUTICAL RESPONSE: What drugs, vaccines, or companies are associated?
       (hantavirus → vaccine, antiviral, pfizer, mrna / covid → moderna, astrazeneca)
    D. CONTAINMENT & RESPONSE: What organisations or measures respond to it?
       (outbreak → cdc, who, quarantine, mask, hazmat, biohazard)
    E. NARRATIVE VILLAINS: What are the antagonists in this threat narrative?
       (virus → lab, bioweapon, china, bat, patient zero)
    These terms surface the DERIVATIVE tokens degens spin up when a threat narrative runs.
    $HANTA pumping → degens immediately launch $RAT, $RATWIF, $PFIZER, $VACCINE, $CDC.
    A degen scanning $HANTA should find ALL of these. Generate them proactively.

8. CT SLANG EXPANSION — if the token name, symbol, or description contains CT/degen slang,
   expand the slang itself into related concepts degens would recognise as connected.
   You understand all crypto Twitter lingo — use it.

   Key slang → expansion examples:
   larp / larping → fake, cope, pretend, imposter, fraud, clout
   cope / copium → denial, seethe, bags, rekt, ngmi
   seethe → rage, mald, salt, butthurt, cope
   rug / rugpull → exit, scam, dev, abandon, honeypot
   degen → gamble, ape, yolo, risk, degenerate
   wagmi → gm, gn, fren, ser, anon, ngmi (COUNTER)
   ngmi → wagmi (COUNTER), cope, rekt, poor
   rekt → liquidated, wrecked, loss, margin, leverage
   fud → fear, doubt, uncertainty, bearish, fudder
   based → chad, alpha, sigma, redpilled, gigachad
   chad / gigachad → based, sigma, alpha, king, goat
   wojak → pepe (UNIVERSE), doomer, boomer, soyjak, npc
   npc → normie, sleeper, sheep, bot, mindless
   wen / wen moon → soon, patience, hopium, moon
   hopium → cope (COUNTER), hopeful, bullish, delusion
   ser → anon, fren, gm, ct, degenerate
   probably nothing → definitely something, hidden gem, alpha
   this is fine → chaos, burning, disaster, meltdown
   touch grass → neet, basement, terminally online, burnout
   if a slang term is in the token → expand it AND include its opposite (COUNTER)

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
- NO evolutionary/taxonomic chaining: gorilla → primate → mammal → mouse is DRIFT. Stop at the direct family.
  gorilla → chimp, orangutan, ape, bonobo = valid (same direct family)
  gorilla → mouse, rat, hamster = INVALID (different family, connected only via taxonomy)
- NO conceptual extension chains: horror → fear → anxiety → depression is DRIFT. One hop only.
- NO property chains: big → large → giant → whale is DRIFT. The token IS the thing, not a property of it.

SELF-CHECK before outputting — remove any term that:
- Is a relationship label (opposite, synonym, twin, counter, echo, universe, sector)
- Could describe any random Solana token (too generic)
- You invented right now and likely doesn't exist as a real token name
- Needs more than one reasoning hop to connect to this token
- Is connected via taxonomy/evolution/property rather than direct narrative association

ALSO VERIFY before outputting:
- Do your relationshipHints include at least one COUNTER? If not — add one now.
- Do your searchTerms include the direct antonym of the core concept? If not — add it.

9. CATEGORY — name this token's primary narrative universe in ONE short lowercase word or phrase.
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

    const SYSTEM = `You are a crypto-native degen on Solana CT. You have encyclopedic knowledge of:
- Meme token naming conventions: wif, inu, cat, pepe, sol, baby, evil, dark prefixes/suffixes
- How CT spins derivative tokens from any narrative: disease → rat carrier → ratwif → pharma response
- Real-world entities that get tokenised: pharma companies, government agencies, historical figures
- Anime, gaming, political, animal, horror, and internet culture token universes
- How degens think: "if X pumps, what else would I ape into immediately?"
Always respond with valid JSON only — no explanation, no markdown fences.`

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
        const result = await tryOpenAI('https://openrouter.ai/api/v1/chat/completions', OR_KEY, 'deepseek/deepseek-chat-v3-0324:free', OR_HEADERS)
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
  const expansionSystem = `You are a crypto-native degen and narrative analyst on Solana CT. You deeply understand meme token naming conventions, CT culture, and how narratives spawn derivative tokens. Always respond with valid JSON only — no explanation, no markdown.`
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
      promptVersion: 'v7',
    }
    expansionCache.set(token.address, { data: cacheData, timestamp: Date.now(), mcap: token.marketCap || 0 })
    // Persist to Supabase — survives server restarts (6h TTL matches in-memory TTL)
    cacheSet(`expansion:${token.address}`, { ...cacheData, mcap: token.marketCap || 0 }, 6).catch(() => {})
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
    const { address, symbol, name, description, logoUrl, marketCap, forceRefresh, skipVision } = req.body
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
      const expansionSystem = `You are a crypto-native degen and narrative analyst on Solana CT. You deeply understand meme token naming conventions, CT culture, and how narratives spawn derivative tokens. Always respond with valid JSON only — no explanation, no markdown.`

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
    // Skipped when skipVision=true (background warmup calls) to preserve
    // Gemini quota for actual user-triggered scans. Text expansion alone
    // is sufficient for warmup — vision runs when the user clicks the alpha.
    let visualTerms    = []
    let visualCounters = []
    let visualHints  = {}
    let mood         = null

    if (logoUrl && !skipVision) {
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

    const PROMPT_VERSION = 'v7'  // Bump when expansion prompt changes significantly
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
    // Persist to Supabase so cache survives restarts
    cacheSet(`expansion:${address}`, { ...data, mcap: marketCap || 0 }, 6).catch(() => {})
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

    const prompt = `You are a CT degen categorising Solana meme tokens into narrative themes.
These tokens FAILED keyword matching — they need semantic understanding to classify.

KNOWN NARRATIVE CATEGORIES:
${categoryList}

TOKENS TO CATEGORISE:
${tokenList}

YOUR TASK for each token:
1. MATCH TO KNOWN CATEGORY — be aggressive with semantic matching:
   - $WHISKERS, $MEOW, $PURRFI → cats
   - $BARKY, $WOOFCOIN, $DOGWIF → dogs
   - $RATWIFMASK, $RATPEPE → animals (rats)
   - $NGMI, $COPIUM, $WAGMI → internet_culture or humor
   - $LARPER, $SIMP → internet_culture
   - $PFIZER, $VACCINE → (match to relevant health/political category or novel)
   - CT naming patterns: [subject]wif[item], baby[subject], evil[subject] — look past the suffix to the SUBJECT

2. CREATE NOVEL NARRATIVE — only when the token clearly doesn't fit any known category
   AND there are signals of a specific sub-narrative worth surfacing (e.g. a new creature,
   a specific political figure, a specific game/anime character)
   - newNarrative.key: short lowercase slug (e.g. "gork", "foxes", "hanta")
   - newNarrative.label: emoji + short name (e.g. "🦊 Foxes", "🦠 Hanta", "🦕 Gork")
   - Choose the emoji a CT degen would use for this narrative

3. NULL — only for genuinely random tokens with no identifiable theme

IMPORTANT: Prefer matching to an existing category over creating a new narrative.
A novel narrative should only be created when you're confident other tokens exist in that space.

Respond ONLY with a JSON array:
[
  {"index":0,"category":"cats","newNarrative":null},
  {"index":1,"category":null,"newNarrative":{"key":"foxes","label":"🦊 Foxes"}},
  {"index":2,"category":null,"newNarrative":null}
]`

    const GROQ_KEY = process.env.GROQ_API_KEY
    const OR_KEY   = process.env.OPENROUTER_API_KEY
    const SYSTEM   = `You are a crypto-native degen on Solana CT. You deeply understand how meme narratives cluster and what degens call things. You know that $WHISKERS = cats, $BARKY = dogs, $GORK = a novel creature narrative, $NGMI = internet culture, $COPE = humor/CT slang. You understand CT naming conventions — wif, inu, pepe, baby, evil prefixes/suffixes. Always respond with valid JSON only — no explanation, no markdown fences.`
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
      { url: 'https://openrouter.ai/api/v1/chat/completions',     key: OR_KEY,   model: 'deepseek/deepseek-chat-v3-0324:free',                 headers: OR_HEADERS, tag: 'OR deepseek-v3-5'  },
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
// ─── Birdeye proxy ────────────────────────────────────────────────
// Quota guard: marks exhausted until midnight UTC on 400/429.
// 10min server cache for trending/top_volume (was firing every 30s = 5,760/day).
// Per-token Supabase cache for overview/holders (shared across users).
// DEXScreener fallback for trending when quota exhausted.
// v3 endpoints stubbed — activate when key upgrades to paid tier.

let birdeyeQuotaExhaustedUntil = 0
const BIRDEYE_TRENDING_CACHE = { data: null, ts: 0, ttl: 10 * 60 * 1000 }

const isBirdeyeQuotaExhausted = () => Date.now() < birdeyeQuotaExhaustedUntil

const markBirdeyeQuotaExhausted = () => {
  const now      = new Date()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  birdeyeQuotaExhaustedUntil = midnight.getTime()
  console.warn(`[Birdeye] Quota exhausted — suspending until ${midnight.toISOString()}`)
}

const fetchDexScreenerTrendingFallback = async () => {
  try {
    const [boostRes, newRes] = await Promise.allSettled([
      fetch('https://api.dexscreener.com/token-boosts/top/v1',        { signal: AbortSignal.timeout(6000) }),
      fetch('https://api.dexscreener.com/latest/dex/pairs/solana/new', { signal: AbortSignal.timeout(6000) }),
    ])
    const seen = new Set()
    const items = []
    const addPairs = (pairs) => {
      for (const p of (pairs || [])) {
        if (p.chainId !== 'solana') continue
        const addr = p.baseToken?.address
        if (!addr || seen.has(addr)) continue
        if ((p.volume?.h24 || 0) < 5000) continue
        if ((p.liquidity?.usd || 0) < 1000) continue
        seen.add(addr)
        items.push({
          address:           addr,
          symbol:            p.baseToken.symbol || '',
          name:              p.baseToken.name   || '',
          v24hChangePercent: parseFloat(p.priceChange?.h24) || 0,
          v24hUSD:           p.volume?.h24    || 0,
          liquidity:         p.liquidity?.usd || 0,
          logoURI:           p.info?.imageUrl || null,
          _source:           'dexscreener_fallback',
        })
      }
    }
    if (boostRes.status === 'fulfilled' && boostRes.value.ok) {
      const raw   = await boostRes.value.json()
      const addrs = (Array.isArray(raw) ? raw : [])
        .filter(t => t.chainId === 'solana').slice(0, 30)
        .map(t => t.tokenAddress).join(',')
      if (addrs) {
        try {
          const pr = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`, { signal: AbortSignal.timeout(6000) })
          if (pr.ok) addPairs((await pr.json()).pairs)
        } catch { /* non-fatal */ }
      }
    }
    if (newRes.status === 'fulfilled' && newRes.value.ok) addPairs((await newRes.value.json()).pairs)
    if (items.length === 0) return null
    console.log(`[Birdeye] DEXScreener fallback — ${items.length} tokens`)
    return { data: { items } }
  } catch (err) {
    console.warn('[Birdeye] DEXScreener fallback failed:', err.message)
    return null
  }
}

app.get('/api/birdeye', async (req, res) => {
  const { endpoint, address } = req.query
  const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY
  if (!BIRDEYE_KEY) return res.status(503).json({ error: 'Birdeye not configured' })

  if (!address && ['token_overview', 'token_overview_v3', 'holders'].includes(endpoint)) {
    return res.status(400).json({ error: 'address required for this endpoint' })
  }

  const ENDPOINT_MAP = {
    token_overview:    address ? `https://public-api.birdeye.so/defi/token_overview?address=${address}` : null,
    holders:           address ? `https://public-api.birdeye.so/v1/token/holder?address=${address}&offset=0&limit=10` : null,
    trending:          `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=50&min_liquidity=5000`,
    top_volume:        `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=20&min_liquidity=10000`,
    // Paid tier stubs — activate automatically when key has access
    trending_v3:       `https://public-api.birdeye.so/defi/v3/token/list?sort_by=volume_24h_change_percent&sort_type=desc&offset=0&limit=50&min_liquidity=5000`,
    token_overview_v3: address ? `https://public-api.birdeye.so/defi/v3/token/overview?address=${address}` : null,
  }

  const url = ENDPOINT_MAP[endpoint]
  if (!url) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  // Per-token Supabase cache — shared across users, survives restarts
  if (endpoint === 'token_overview' || endpoint === 'token_overview_v3') {
    const cached = await cacheGet(`birdeye:overview:${address}`)
    if (cached) return res.json(cached)
  }
  if (endpoint === 'holders') {
    const cached = await cacheGet(`birdeye:holders:${address}`)
    if (cached) return res.json(cached)
  }

  // 10-minute in-memory cache for trending endpoints
  if (endpoint === 'trending' || endpoint === 'top_volume') {
    const age = Date.now() - BIRDEYE_TRENDING_CACHE.ts
    if (BIRDEYE_TRENDING_CACHE.data && age < BIRDEYE_TRENDING_CACHE.ttl) {
      return res.json(BIRDEYE_TRENDING_CACHE.data)
    }
  }

  // Quota guard
  if (isBirdeyeQuotaExhausted()) {
    if (endpoint === 'trending' || endpoint === 'top_volume' || endpoint === 'trending_v3') {
      if (BIRDEYE_TRENDING_CACHE.data) return res.json(BIRDEYE_TRENDING_CACHE.data)
      const fallback = await fetchDexScreenerTrendingFallback()
      if (fallback) return res.json(fallback)
    }
    return res.status(429).json({ error: 'Birdeye quota exhausted until midnight UTC' })
  }

  try {
    const response = await fetchWithRetry(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    }, 1)  // 1 retry only — don't double-burn quota

    if (response.status === 404) return res.json({ data: null })

    if (response.status === 400 || response.status === 429) {
      console.warn(`[Birdeye] ${response.status} on ${endpoint} — marking quota exhausted`)
      markBirdeyeQuotaExhausted()
      if (endpoint === 'trending' || endpoint === 'top_volume') {
        if (BIRDEYE_TRENDING_CACHE.data) return res.json(BIRDEYE_TRENDING_CACHE.data)
        const fallback = await fetchDexScreenerTrendingFallback()
        if (fallback) return res.json(fallback)
      }
      return res.status(response.status).json({ error: `Birdeye ${response.status}` })
    }

    if (!response.ok) throw new Error(`Birdeye ${response.status}`)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      const raw = await response.text()
      console.warn('[Birdeye] Non-JSON response:', raw.slice(0, 100))
      return res.status(502).json({ error: 'Birdeye returned non-JSON response' })
    }

    const data = await response.json()

    // Cache successful responses
    if (endpoint === 'trending' || endpoint === 'top_volume') {
      BIRDEYE_TRENDING_CACHE.data = data
      BIRDEYE_TRENDING_CACHE.ts   = Date.now()
    }
    if (endpoint === 'token_overview' || endpoint === 'token_overview_v3') {
      cacheGet(`birdeye:overview:${address}`).then(() =>
        cacheSet(`birdeye:overview:${address}`, data, 24)
      ).catch(() => {})
    }
    if (endpoint === 'holders') {
      cacheSet(`birdeye:holders:${address}`, data, 6).catch(() => {})
    }

    res.json(data)
  } catch (err) {
    console.error('[Birdeye] Proxy error:', err.message)
    if (endpoint === 'trending' || endpoint === 'top_volume') {
      if (BIRDEYE_TRENDING_CACHE.data) return res.json(BIRDEYE_TRENDING_CACHE.data)
      const fallback = await fetchDexScreenerTrendingFallback()
      if (fallback) return res.json(fallback)
    }
    res.status(502).json({ error: err.message })
  }
})

// ─── DEXScreener Metas API ────────────────────────────────────────
// Two-tier trending filter. Tier 1: aggregate (h1>10% OR h6>20%,
// tokenCount≥3, volume≥$1M). Tier 2: token-level on top 5 candidates
// (≥2 tokens up ≥30% in 24h). 5min server cache.

// ─── DEXScreener rate limit cooldowns ────────────────────────────
// When any DEXScreener endpoint returns 429, suspend that specific
// endpoint for 5 minutes and serve stale cache. Prevents thundering
// herd — no data in cache means every 30s refresh fires a live call
// and gets another 429, burning the rate limit repeatedly.
//
// Metas TTL raised to 15 minutes — narratives don't shift in 5 min.
// CTO TTL raised to 10 minutes — community takeovers are slow-moving.
// Profiles/Recent TTL stays at 3 minutes — rebrands can be faster.

let metasCooldownUntil          = 0
let ctoCooldownUntil            = 0
let profilesRecentCooldownUntil = 0

const DEXSCREENER_429_COOLDOWN = 5 * 60 * 1000  // 5 minutes

const METAS_CACHE          = { trending: null, ts: 0, ttl: 15 * 60 * 1000 }  // 15min
const CTO_CACHE            = { data: null, ts: 0, ttl: 10 * 60 * 1000 }      // 10min
const PROFILES_RECENT_CACHE = { data: null, ts: 0, ttl:  3 * 60 * 1000 }     //  3min

const checkMetaTokenMomentum = async (slug) => {
  try {
    const r = await fetch(`https://api.dexscreener.com/metas/meta/v1/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return { confirmed: false, pumpingCount: 0 }
    const data  = await r.json()
    const pairs = Array.isArray(data.pairs) ? data.pairs : []
    const pumping = pairs.filter(p => parseFloat(p.priceChange?.h24 || 0) >= 30)
    return {
      confirmed:    pumping.length >= 2,
      pumpingCount: pumping.length,
      totalTokens:  pairs.length,
      topGainers:   pumping
        .sort((a, b) => parseFloat(b.priceChange?.h24 || 0) - parseFloat(a.priceChange?.h24 || 0))
        .slice(0, 3)
        .map(p => ({ symbol: p.baseToken?.symbol || '', change24h: parseFloat(p.priceChange?.h24 || 0), volume24h: p.volume?.h24 || 0 })),
    }
  } catch { return { confirmed: false, pumpingCount: 0 } }
}

app.get('/api/metas', async (req, res) => {
  const { type = 'trending', slug } = req.query

  if (type === 'trending') {
    // Serve cache if fresh
    const age = Date.now() - METAS_CACHE.ts
    if (METAS_CACHE.trending && age < METAS_CACHE.ttl) return res.json(METAS_CACHE.trending)

    // 429 cooldown — serve stale cache if available, otherwise skip
    if (Date.now() < metasCooldownUntil) {
      if (METAS_CACHE.trending) {
        console.log('[Metas] 429 cooldown active — serving stale cache')
        return res.json(METAS_CACHE.trending)
      }
      return res.status(429).json({ error: 'Metas rate limited — no cache available' })
    }

    try {
      const r = await fetch('https://api.dexscreener.com/metas/trending/v1', { signal: AbortSignal.timeout(8000) })
      if (r.status === 429) throw new Error('Metas 429')
      if (!r.ok) throw new Error(`Metas ${r.status}`)
      const raw = await r.json()

      const tier1 = (Array.isArray(raw) ? raw : [])
        .filter(m => (m.tokenCount || 0) >= 3 && (m.volume || 0) >= 1_000_000 &&
          ((m.marketCapChange?.h1 || 0) >= 10 || (m.marketCapChange?.h6 || 0) >= 20))
        .map(m => ({
          name: m.name, slug: m.slug, marketCap: m.marketCap || 0, volume: m.volume || 0,
          tokenCount: m.tokenCount || 0,
          change: { m5: m.marketCapChange?.m5 || 0, h1: m.marketCapChange?.h1 || 0, h6: m.marketCapChange?.h6 || 0, h24: m.marketCapChange?.h24 || 0 },
          trendScore: Math.round(Math.abs(m.marketCapChange?.h1 || 0) * 0.5 + Math.abs(m.marketCapChange?.h6 || 0) * 0.3 + Math.abs(m.marketCapChange?.h24 || 0) * 0.2),
        }))
        .sort((a, b) => b.trendScore - a.trendScore)

      if (tier1.length === 0) {
        const result = { metas: [], fetchedAt: Date.now(), tier1Count: 0, tier2Count: 0 }
        METAS_CACHE.trending = result; METAS_CACHE.ts = Date.now()
        return res.json(result)
      }

      const top5 = tier1.slice(0, 5), remainder = tier1.slice(5)
      console.log(`[Metas] Tier 1: ${tier1.length} — Tier 2 check on top ${top5.length}`)
      const tier2Results = await Promise.allSettled(top5.map(m => checkMetaTokenMomentum(m.slug)))

      const confirmed = []
      top5.forEach((meta, i) => {
        const r = tier2Results[i]
        if (r.status !== 'fulfilled') return
        const { confirmed: ok, pumpingCount, topGainers } = r.value
        if (ok) { confirmed.push({ ...meta, pumpingCount, topGainers, tier2Confirmed: true }); console.log(`[Metas] ✅ ${meta.name} — ${pumpingCount} tokens up 30%+`) }
        else      console.log(`[Metas] ❌ ${meta.name} — only ${pumpingCount} tokens up 30%+`)
      })

      const metas  = [...confirmed, ...remainder.map(m => ({ ...m, tier2Confirmed: false, pumpingCount: null }))]
      const result = { metas, fetchedAt: Date.now(), tier1Count: tier1.length, tier2Count: confirmed.length }
      METAS_CACHE.trending = result; METAS_CACHE.ts = Date.now()
      console.log(`[Metas] ${confirmed.length} Tier 2 confirmed, ${remainder.length} Tier 1 only`)
      return res.json(result)
    } catch (err) {
      if (err.message?.includes('429')) {
        metasCooldownUntil = Date.now() + DEXSCREENER_429_COOLDOWN
        console.warn(`[Metas] 429 — cooling down for 5min until ${new Date(metasCooldownUntil).toISOString()}`)
      } else {
        console.error('[Metas] Failed:', err.message)
      }
      if (METAS_CACHE.trending) return res.json(METAS_CACHE.trending)
      return res.status(502).json({ error: err.message })
    }
  }

  if (type === 'meta' && slug) {
    try {
      const r = await fetch(`https://api.dexscreener.com/metas/meta/v1/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(`Meta ${slug} ${r.status}`)
      return res.json(await r.json())
    } catch (err) { return res.status(502).json({ error: err.message }) }
  }

  return res.status(400).json({ error: 'type must be trending or meta (with slug)' })
})

// ─── Community Takeovers ──────────────────────────────────────────
app.get('/api/cto', async (req, res) => {
  const age = Date.now() - CTO_CACHE.ts
  if (CTO_CACHE.data && age < CTO_CACHE.ttl) return res.json(CTO_CACHE.data)

  if (Date.now() < ctoCooldownUntil) {
    if (CTO_CACHE.data) {
      console.log('[CTO] 429 cooldown active — serving stale cache')
      return res.json(CTO_CACHE.data)
    }
    return res.status(429).json({ error: 'CTO rate limited — no cache available' })
  }

  try {
    const r = await fetch('https://api.dexscreener.com/community-takeovers/latest/v1', { signal: AbortSignal.timeout(8000) })
    if (r.status === 429) throw new Error('CTO 429')
    if (!r.ok) throw new Error(`CTO ${r.status}`)
    const raw    = await r.json()
    const tokens = (Array.isArray(raw) ? raw : [])
      .filter(t => t.chainId === 'solana' && t.tokenAddress)
      .map(t => ({ address: t.tokenAddress, symbol: t.header || '', name: t.description || '', logoUrl: t.icon || null, isCTO: true, source: 'cto' }))
    const result = { tokens, fetchedAt: Date.now() }
    CTO_CACHE.data = result; CTO_CACHE.ts = Date.now()
    console.log(`[CTO] ${tokens.length} tokens cached`)
    return res.json(result)
  } catch (err) {
    if (err.message?.includes('429')) {
      ctoCooldownUntil = Date.now() + DEXSCREENER_429_COOLDOWN
      console.warn(`[CTO] 429 — cooling down for 5min until ${new Date(ctoCooldownUntil).toISOString()}`)
    } else {
      console.error('[CTO] Failed:', err.message)
    }
    if (CTO_CACHE.data) return res.json(CTO_CACHE.data)
    return res.status(502).json({ error: err.message })
  }
})

// ─── Recently updated token profiles ─────────────────────────────
app.get('/api/profiles/recent', async (req, res) => {
  const age = Date.now() - PROFILES_RECENT_CACHE.ts
  if (PROFILES_RECENT_CACHE.data && age < PROFILES_RECENT_CACHE.ttl) return res.json(PROFILES_RECENT_CACHE.data)

  if (Date.now() < profilesRecentCooldownUntil) {
    if (PROFILES_RECENT_CACHE.data) {
      console.log('[Profiles/Recent] 429 cooldown active — serving stale cache')
      return res.json(PROFILES_RECENT_CACHE.data)
    }
    return res.status(429).json({ error: 'Profiles/Recent rate limited — no cache available' })
  }

  try {
    const r = await fetch('https://api.dexscreener.com/token-profiles/recent-updates/v1', { signal: AbortSignal.timeout(8000) })
    if (r.status === 429) throw new Error('Profiles recent 429')
    if (!r.ok) throw new Error(`Profiles recent ${r.status}`)
    const raw    = await r.json()
    const tokens = (Array.isArray(raw) ? raw : []).filter(t => t.chainId === 'solana' && t.tokenAddress)
    const result = { tokens, fetchedAt: Date.now() }
    PROFILES_RECENT_CACHE.data = result; PROFILES_RECENT_CACHE.ts = Date.now()
    console.log(`[Profiles/Recent] ${tokens.length} cached`)
    return res.json(result)
  } catch (err) {
    if (err.message?.includes('429')) {
      profilesRecentCooldownUntil = Date.now() + DEXSCREENER_429_COOLDOWN
      console.warn(`[Profiles/Recent] 429 — cooling down for 5min until ${new Date(profilesRecentCooldownUntil).toISOString()}`)
    } else {
      console.error('[Profiles/Recent] Failed:', err.message)
    }
    if (PROFILES_RECENT_CACHE.data) return res.json(PROFILES_RECENT_CACHE.data)
    return res.status(502).json({ error: err.message })
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
  // PumpFun API disabled — CDN has been returning 530 consistently.
  // All fallbacks (PumpPortal, DEXScreener pump) also failing.
  // Re-enable when PumpFun stabilises their API infrastructure.
  return res.status(503).json({ error: 'PumpFun source disabled — CDN outage' })

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

      // ── DEXScreener /pairs/solana/pump fallback ───────────────
      // Completely independent infrastructure from PumpFun/PumpPortal.
      // Returns graduated/bonded Pump.fun pairs with live trading data.
      // Normalised to match the PumpFun coin shape the frontend expects:
      //   { mint, symbol, name, usd_market_cap, last_trade_timestamp }
      try {
        const limit   = parseInt(params.limit) || 100
        const dexUrl  = 'https://api.dexscreener.com/latest/dex/pairs/solana/pump'
        const dexRes  = await fetch(dexUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        })
        if (!dexRes.ok) throw new Error(`DEXScreener pump ${dexRes.status}`)
        const dexData = await dexRes.json()
        const pairs   = Array.isArray(dexData.pairs) ? dexData.pairs : []

        if (pairs.length === 0) throw new Error('DEXScreener pump returned empty pairs')

        // Normalise DEXScreener pair shape → PumpFun coin shape
        // Frontend Vector 4 only needs: mint (address), symbol, name,
        // usd_market_cap, and last_trade_timestamp for sorting/filtering.
        const normalised = pairs
          .filter(p => p.baseToken?.address && p.baseToken?.symbol)
          .slice(0, limit)
          .map(p => ({
            mint:                 p.baseToken.address,
            symbol:               p.baseToken.symbol,
            name:                 p.baseToken.name || p.baseToken.symbol,
            usd_market_cap:       p.marketCap || p.fdv || 0,
            // DEXScreener pairCreatedAt is ms epoch — convert to seconds
            // so it matches PumpFun's last_trade_timestamp format
            last_trade_timestamp: p.pairCreatedAt
              ? Math.floor(p.pairCreatedAt / 1000)
              : Math.floor(Date.now() / 1000),
            // Extra fields that may be used by frontend filtering
            liquidity_usd:        p.liquidity?.usd    || 0,
            volume_24h:           p.volume?.h24        || 0,
            price_change_24h:     parseFloat(p.priceChange?.h24) || 0,
            image_uri:            p.info?.imageUrl     || null,
            // Source tag so logs can identify this path
            _source:              'dexscreener_pump',
          }))

        if (normalised.length === 0) throw new Error('DEXScreener pump normalisation yielded zero tokens')

        console.log(`[DEXScreener] Pump fallback success — ${normalised.length} pairs`)
        // Cache under the same key — serves future requests until TTL expires
        pumpFunCache.set(cacheKey, { data: normalised, ts: Date.now() })
        return res.json(normalised)

      } catch (dexErr) {
        console.error(`[DEXScreener] Pump fallback also failed: ${dexErr.message}`)

        // All three sources failed — mark as down for 5 minutes
        markPumpFunDown()

        // ── Last resort: serve stale cache rather than empty ──────
        if (cached) {
          const ageMin = Math.round((Date.now() - cached.ts) / 60000)
          console.warn(`[PumpFun] Serving stale cache (${ageMin}m old)`)
          return res.json(cached.data)
        }

        return res.status(503).json({ error: 'PumpFun, PumpPortal, and DEXScreener pump all unavailable' })
      }
    }
  }
})

// ─── Telegram Vector 10 endpoints ────────────────────────────────

// GET /api/telegram-betas?symbol=WIF
// Returns pre-computed cached beta results for a given alpha symbol.
// Zero processing on request — all heavy work happens in background poller.
app.get('/api/telegram-betas', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  const results = telegramService.getTelegramBetas(symbol)

  // Persist any new signals to Supabase (fire-and-forget)
  if (results?.length > 0) {
    ;(async () => {
      for (const r of results) {
        try {
          await db.query(`
            INSERT INTO telegram_signals (alpha_symbol, beta_symbol, beta_address, channel, confidence)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
          `, [symbol, r.symbol || null, r.address || null, r.channel || null, r.confidence || 1.0])
        } catch { /* non-fatal */ }
      }
    })()
  }

  // If in-memory cache is empty (cold restart), try Supabase fallback
  if (!results || results.length === 0) {
    try {
      const dbResult = await db.query(`
        SELECT beta_symbol AS symbol, beta_address AS address, channel, confidence
        FROM telegram_signals
        WHERE alpha_symbol = $1
          AND created_at > NOW() - INTERVAL '48 hours'
        ORDER BY created_at DESC
        LIMIT 20
      `, [symbol])
      if (dbResult.rows.length > 0) {
        return res.json({ symbol, results: dbResult.rows, source: 'db_fallback' })
      }
    } catch { /* fall through */ }
  }

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

// ─── Database endpoints ───────────────────────────────────────────────────────

// ── DB write queue ─────────────────────────────────────────────────────────────
// Supabase: 20 pool connections through PgBouncer (200 max client connections).
// Without a queue, 300+ fire-and-forget record-alpha calls on boot saturate
// the pool instantly — every query times out, DB becomes unusable for minutes.
// This queue caps DB writes at 2 concurrent, serialising the rest.
// Reads (history, beta-history) always get through because writes never hold
// all 5 connections.
// ─── Endpoint rate limiter ────────────────────────────────────────
// Prevents DB connection pool exhaustion when multiple endpoints fire
// simultaneously on startup. Simple per-endpoint cooldown map.
const _endpointLastCall = new Map()
const endpointCooldown = (key, ms) => {
  const last = _endpointLastCall.get(key) || 0
  const now  = Date.now()
  if (now - last < ms) return false  // still cooling
  _endpointLastCall.set(key, now)
  return true
}

const DB_WRITE_QUEUE = (() => {
  let running   = 0
  const MAX     = 2
  const waiting = []

  const next = () => {
    if (waiting.length > 0 && running < MAX) waiting.shift()()
  }

  const run = (fn) => new Promise((resolve, reject) => {
    const exec = async () => {
      running++
      try   { resolve(await fn()) }
      catch (err) { reject(err) }
      finally { running--; next() }
    }
    if (running < MAX) exec()
    else waiting.push(exec)
  })

  return { run, get size() { return running + waiting.length } }
})()

// POST /api/record-alphas  (batch — replaces /api/record-alpha)
// Called fire-and-forget from useAlphas.js with the full fresh alpha list.
// One request per refresh cycle instead of one per token — kills the connection
// storm. Batched upserts keep connection usage low.
// Body: { alphas: [{ address, symbol, name, logoUrl, marketCap, volume24h, priceChange24h, source, price }] }
// POST /api/novel-narrative
// Called by useNarrativeSzn when a novel Szn card forms (not in lore_map).
// Writes to the narratives table so new categories persist across sessions.
// Uses ON CONFLICT (slug) DO UPDATE to refresh token_count and last_seen.
// Fails silently — novel narrative recording is non-fatal.
app.post('/api/novel-narrative', async (req, res) => {
  const { slug, label, tokenCount, tokens } = req.body
  if (!slug || !label) return res.status(400).json({ error: 'slug and label required' })

  try {
    // Schema: key, label, tokens (JSONB), total_volume, score, timestamp
    // No UNIQUE constraint on key — insert only if key not already seen today
    const existing = await db.query(
      `SELECT id FROM narratives WHERE key = $1 AND timestamp > NOW() - INTERVAL '24 hours'`,
      [slug]
    )
    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO narratives (key, label, tokens, total_volume, score)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          slug,
          label,
          JSON.stringify((tokens || []).slice(0, 20)),
          0,
          tokenCount || (tokens?.length || 0),
        ]
      )
      console.log(`[Narratives] Recorded novel narrative: "${label}" (${tokenCount} tokens)`)
    }

    // Also write individual tokens to the tokens table
    if (Array.isArray(tokens) && tokens.length > 0) {
      for (const t of tokens.slice(0, 20)) {
        if (!t.address || !t.symbol) continue
        db.query(
          `INSERT INTO tokens (address, symbol, name, logo_url, last_seen)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (address) DO UPDATE SET last_seen = NOW()`,
          [t.address, t.symbol, t.name || t.symbol, t.logoUrl || null]
        ).catch(() => {})
      }
    }

    res.json({ ok: true })
  } catch (err) {
    console.warn('[Narratives] Write failed (non-fatal):', err.message)
    res.json({ ok: false, error: err.message })
  }
})

// GET /api/run-counts?addresses=addr1,addr2,...
// Returns how many times each token address has appeared in alpha_runs.
// Used to show re-entry strength badge on live alpha cards.
// Cached 5 minutes — run counts don't change faster than feed refresh.
app.get('/api/run-counts', async (req, res) => {
  const raw       = (req.query.addresses || '').trim()
  const addresses = raw.split(',').map(a => a.trim()).filter(Boolean).slice(0, 100)
  if (addresses.length === 0) return res.json({ counts: {} })

  try {
    const result = await db.query(
      `SELECT token_address,
              COUNT(DISTINCT DATE(timestamp))::int AS run_count
       FROM alpha_runs
       WHERE token_address = ANY($1)
       GROUP BY token_address`,
      [addresses]
    )
    const counts = {}
    for (const row of result.rows) {
      counts[row.token_address] = row.run_count
    }
    res.json({ counts })
  } catch (err) {
    console.warn('[RunCounts] Query failed:', err.message)
    res.json({ counts: {} })
  }
})

// GET /api/news-narrative
// Returns active real-world event categories derived from NewsAPI headlines.
// Cached 30min server-side — zero cost per frontend call.
// Response: { active: [{ category, confidence, matchCount, headline }] }
app.get('/api/news-narrative', async (req, res) => {
  try {
    const active = await newsService.getNewsNarratives()
    res.json({ active, cachedAt: new Date().toISOString() })
  } catch (err) {
    console.warn('[NewsNarrative] Error:', err.message)
    res.json({ active: [] })
  }
})

app.post('/api/record-alphas', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { alphas } = req.body
  if (!Array.isArray(alphas) || alphas.length === 0) return res.json({ ok: true, skipped: 'empty' })

  // Respond immediately — client doesn't wait for this
  res.json({ ok: true, queued: alphas.length })

  // Process in background via write queue — 10 at a time, serially within queue
  const valid = alphas.filter(a => a.address && a.symbol)
  const CHUNK = 10

  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK)
    await DB_WRITE_QUEUE.run(async () => {
      // Build a single multi-row upsert for the tokens table
      // Per-token upsert — batch multi-row not used here because ATH logic
      // requires per-token conditional (CASE WHEN mcap > ath_mcap).
      // Still runs in one DB_WRITE_QUEUE call per chunk — serialised correctly.
      for (const a of chunk) {
        try {
          const mcap  = a.marketCap || 0
          const price = a.price     || null
          await db.query(`
            INSERT INTO tokens (
              address, symbol, name, logo_url,
              peak_mcap, first_seen, last_seen,
              ath_mcap, ath_at, ath_price,
              first_run_at, last_run_at, total_run_count
            )
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $5, NOW(), $6, NOW(), NOW(), 1)
            ON CONFLICT (address) DO UPDATE SET
              last_seen       = NOW(),
              last_run_at     = NOW(),
              total_run_count = tokens.total_run_count + 1,
              name            = COALESCE(EXCLUDED.name,     tokens.name),
              logo_url        = COALESCE(EXCLUDED.logo_url, tokens.logo_url),
              peak_mcap       = GREATEST(tokens.peak_mcap,  EXCLUDED.peak_mcap),
              first_run_at    = COALESCE(tokens.first_run_at, NOW()),
              -- ATH: update only if incoming mcap beats stored ath_mcap
              ath_mcap  = CASE WHEN $5 > COALESCE(tokens.ath_mcap, 0)
                               THEN $5 ELSE tokens.ath_mcap END,
              ath_at    = CASE WHEN $5 > COALESCE(tokens.ath_mcap, 0)
                               THEN NOW() ELSE tokens.ath_at END,
              ath_price = CASE WHEN $5 > COALESCE(tokens.ath_mcap, 0)
                               THEN $6 ELSE tokens.ath_price END
          `, [a.address, a.symbol, a.name || null, a.logoUrl || null, mcap, price])
        } catch (err) {
          console.error('[DB] record-alphas token upsert error:', err.message)
        }
      }

      // Insert alpha_run rows — deduplicated to ONE row per token per DAY.
      // runCount = distinct days a token has been a runner. This is meaningful
      // to degens: "ran for 7 days" signals a recurring narrative token.
      // "appeared 168 times" (hourly) is just polling noise — meaningless.
      for (const a of chunk) {
        try {
          await db.query(`
            INSERT INTO alpha_runs (token_address, mcap, volume_24h, price_change_24h, source, price, is_revival, recovery_pct, liquidity)
            SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
            WHERE NOT EXISTS (
              SELECT 1 FROM alpha_runs
              WHERE token_address = $1
                AND timestamp > NOW() - INTERVAL '24 hours'
            )
          `, [a.address, a.marketCap || null, a.volume24h || null, a.priceChange24h || null,
              a.source || null, a.price || null,
              a.isRevival || false, a.recoveryPct || null, a.liquidity || null])
        } catch { /* non-fatal per-token */ }
      }
    }).catch(err => console.error('[DB] record-alphas chunk error:', err.message))

    // Small pause between chunks — lets read queries breathe
    if (i + CHUNK < valid.length) await new Promise(r => setTimeout(r, 100))
  }
})

// POST /api/record-alpha  (kept for backward compat — routes to queue)
// Old single-token endpoint. Kept so any cached frontend code still works.
app.post('/api/record-alpha', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { address, symbol, name, logoUrl, marketCap, volume24h, priceChange24h, source, price } = req.body
  if (!address || !symbol) return res.status(400).json({ error: 'address and symbol required' })

  res.json({ ok: true, queued: 1 })

  DB_WRITE_QUEUE.run(async () => {
    try {
      await db.query(`
        INSERT INTO tokens (address, symbol, name, logo_url, peak_mcap, last_seen)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (address) DO UPDATE SET
          last_seen = NOW(),
          name      = COALESCE(EXCLUDED.name, tokens.name),
          logo_url  = COALESCE(EXCLUDED.logo_url, tokens.logo_url),
          peak_mcap = GREATEST(tokens.peak_mcap, EXCLUDED.peak_mcap)
      `, [address, symbol, name || null, logoUrl || null, marketCap || 0])
      await db.query(`
        INSERT INTO alpha_runs (token_address, mcap, volume_24h, price_change_24h, source, price)
        SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (
          SELECT 1 FROM alpha_runs
          WHERE token_address = $1
            AND timestamp > NOW() - INTERVAL '24 hours'
        )
      `, [address, marketCap || null, volume24h || null, priceChange24h || null, source || null, price || null])
    } catch (err) {
      console.error('[DB] record-alpha error:', err.message)
    }
  }).catch(() => {})
})

// POST /api/refresh-prices
// Receives fresh DEXScreener price data for cooling/historical tokens.
// Called by refreshHistoricalPrices() in useAlphas.js after every 60s price
// refresh cycle. This is the missing link that keeps Supabase prices current
// for tokens that have left the live feed — enabling accurate revival detection
// for ALL users, not just the device that last refreshed.
//
// Deduplication: 1-hour window (vs record-alphas' 24h window) — cooling tokens
// need intra-day price updates for revival detection to work correctly.
//
// Writes:
//   tokens.peak_mcap  — updated if fresh mcap exceeds stored peak
//   tokens.last_seen  — updated to NOW()
//   alpha_runs        — one new row per token per hour max
//
// Fire-and-forget from frontend — responds immediately, writes in background.
app.post('/api/refresh-prices', (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { tokens } = req.body
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ error: 'tokens array required' })
  }

  // Respond immediately — client never waits for this
  res.json({ ok: true, count: tokens.length })

  // Process in background via write queue — same pattern as record-alphas
  const valid = tokens.filter(t => t.address && t.symbol)
  const CHUNK = 10

  ;(async () => {
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK)

      await DB_WRITE_QUEUE.run(async () => {
        // Upsert tokens table — update peak_mcap and mcap_at_first_seen
        // Per-token upsert for refresh-prices — ATH requires per-token conditional
        for (const t of chunk) {
          const mcap  = t.peakMarketCap || t.marketCap || 0
          const price = t.priceUsd || null
          try {
            await db.query(`
              INSERT INTO tokens (
                address, symbol, name, logo_url,
                peak_mcap, mcap_at_first_seen, last_seen,
                ath_mcap, ath_at, ath_price
              )
              VALUES ($1, $2, $3, $4, $5, $6, NOW(), $5, NOW(), $7)
              ON CONFLICT (address) DO UPDATE SET
                last_seen          = NOW(),
                name               = COALESCE(EXCLUDED.name,     tokens.name),
                logo_url           = COALESCE(EXCLUDED.logo_url, tokens.logo_url),
                peak_mcap          = GREATEST(tokens.peak_mcap,  EXCLUDED.peak_mcap),
                mcap_at_first_seen = COALESCE(
                  NULLIF(tokens.mcap_at_first_seen, 0),
                  NULLIF(EXCLUDED.mcap_at_first_seen, 0)
                ),
                ath_mcap  = CASE WHEN $5 > COALESCE(tokens.ath_mcap, 0)
                                 THEN $5 ELSE tokens.ath_mcap END,
                ath_at    = CASE WHEN $5 > COALESCE(tokens.ath_mcap, 0)
                                 THEN NOW() ELSE tokens.ath_at END,
                ath_price = CASE WHEN $5 > COALESCE(tokens.ath_mcap, 0)
                                 THEN $7 ELSE tokens.ath_price END
            `, [t.address, t.symbol, t.name || null, t.logoUrl || null,
                mcap, t.mcapAtFirstSeen || 0, price])
          } catch (err) {
            console.error('[DB] refresh-prices token upsert error:', err.message)
          }
        }

        // Insert alpha_runs — ONE row per token per HOUR (not per day like record-alphas).
        // Cooling tokens need intra-day updates so revival detection stays accurate.
        for (const t of chunk) {
          try {
            await db.query(`
              INSERT INTO alpha_runs (token_address, mcap, volume_24h, price_change_24h, source, price, is_revival, recovery_pct, liquidity)
              SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
              WHERE NOT EXISTS (
                SELECT 1 FROM alpha_runs
                WHERE token_address = $1
                  AND timestamp > NOW() - INTERVAL '1 hour'
              )
            `, [
              t.address,
              t.marketCap      || null,
              t.volume24h      || null,
              t.priceChange24h || null,
              t.source         || 'price_refresh',
              t.priceUsd       || null,
              t.isRevival      || false,
              t.recoveryPct    || null,
              t.liquidity      || null,
            ])
          } catch { /* non-fatal per-token */ }
        }
      }).catch(err => console.error('[DB] refresh-prices chunk error:', err.message))

      if (i + CHUNK < valid.length) await new Promise(r => setTimeout(r, 100))
    }

    console.log(`[PriceRefresh] Wrote ${valid.length} token price refresh(es) to Supabase`)
  })()
})

// POST /api/record-parent
// Records a confirmed derivative→parent relationship to Supabase.
// Called fire-and-forget from useParentAlpha.js whenever a parent is found.
// Writes parent_address + parent_symbol onto the derivative token's row
// so any user/device can read the map without relying on localStorage.
// Body: { derivativeAddress, derivativeSymbol, parentAddress, parentSymbol, parentName, parentLogoUrl, parentMarketCap }
app.post('/api/record-parent', (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { derivativeAddress, derivativeSymbol, parentAddress, parentSymbol, parentName, parentLogoUrl, parentMarketCap } = req.body
  if (!derivativeAddress || !parentAddress) {
    return res.status(400).json({ error: 'derivativeAddress and parentAddress required' })
  }

  res.json({ ok: true })

  DB_WRITE_QUEUE.run(async () => {
    try {
      // Upsert the derivative token — set its parent_address + parent_symbol
      await db.query(`
        INSERT INTO tokens (address, symbol, parent_address, parent_symbol, last_seen)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (address) DO UPDATE SET
          parent_address = EXCLUDED.parent_address,
          parent_symbol  = EXCLUDED.parent_symbol,
          last_seen      = NOW()
      `, [derivativeAddress, derivativeSymbol || '', parentAddress, parentSymbol || ''])

      // Also ensure the parent token exists in the tokens table
      await db.query(`
        INSERT INTO tokens (address, symbol, name, logo_url, peak_mcap, last_seen)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (address) DO UPDATE SET
          last_seen = NOW(),
          name      = COALESCE(EXCLUDED.name,     tokens.name),
          logo_url  = COALESCE(EXCLUDED.logo_url, tokens.logo_url),
          peak_mcap = GREATEST(tokens.peak_mcap,  EXCLUDED.peak_mcap)
      `, [parentAddress, parentSymbol || '', parentName || null, parentLogoUrl || null, parentMarketCap || 0])

      console.log(`[ParentMap] Recorded $${derivativeSymbol} → $${parentSymbol}`)
    } catch (err) {
      console.error('[DB] record-parent error:', err.message)
    }
  }).catch(() => {})
})

// GET /api/parent-map
// Returns all known derivative→parent mappings from Supabase.
// Shape: { [derivativeAddress]: { symbol: parentSymbol, address: parentAddress } }
// Cached in memory for 5 minutes — called frequently by every useBetas fetchBetas.
let _parentMapCache     = null
let _parentMapCacheTime = 0
const PARENT_MAP_TTL_MS = 5 * 60 * 1000

app.get('/api/parent-map', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ map: {} })

  // Serve from cache if fresh
  const now = Date.now()
  if (_parentMapCache && (now - _parentMapCacheTime) < PARENT_MAP_TTL_MS) {
    return res.json({ map: _parentMapCache })
  }

  try {
    const result = await db.query(`
      SELECT address, parent_address, parent_symbol
      FROM tokens
      WHERE parent_address IS NOT NULL
        AND parent_address != ''
    `)
    const map = {}
    for (const row of result.rows) {
      map[row.address] = { address: row.parent_address, symbol: row.parent_symbol }
    }
    _parentMapCache     = map
    _parentMapCacheTime = now
    return res.json({ map })
  } catch (err) {
    console.error('[DB] parent-map error:', err.message)
    // Return stale cache if available rather than erroring
    if (_parentMapCache) return res.json({ map: _parentMapCache })
    return res.status(500).json({ error: 'db read failed' })
  }
})

// ─── Community Flags ──────────────────────────────────────────────
// POST /api/flag-token
// Records a community flag (rug/honeypot/not_beta) for a beta token.
// Each row = one vote. Counts are aggregated on read.
// Body: { address, symbol, flagType }
app.post('/api/flag-token', (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { address, symbol, flagType } = req.body
  if (!address || !['rug','honeypot','not_beta'].includes(flagType)) {
    return res.status(400).json({ error: 'address and valid flagType required' })
  }
  res.json({ ok: true })
  DB_WRITE_QUEUE.run(async () => {
    try {
      await db.query(
        `INSERT INTO token_flags (address, symbol, flag_type) VALUES ($1, $2, $3)`,
        [address, symbol || '', flagType]
      )
      console.log(`[Flags] $${symbol} flagged as ${flagType}`)
    } catch (err) {
      console.error('[DB] flag-token error:', err.message)
    }
  }).catch(() => {})
})

// GET /api/flags?address=xxx
// Returns aggregated flag counts for a token (or all tokens if no address).
// Shape matches betaplays_flags_v1 localStorage format:
// { [address]: { rug: N, honeypot: N, not_beta: N, symbol: '...' } }
// Cached in memory for 2 minutes — no need to hit DB on every mount.
let _flagsCache     = null
let _flagsCacheTime = 0
const FLAGS_TTL_MS  = 2 * 60 * 1000

app.get('/api/flags', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ flags: {} })
  const { address } = req.query

  // Serve from cache for full-table requests (no address filter)
  if (!address) {
    const now = Date.now()
    if (_flagsCache && (now - _flagsCacheTime) < FLAGS_TTL_MS) {
      return res.json({ flags: _flagsCache })
    }
  }

  try {
    const params = address ? [address] : []
    const where  = address ? 'WHERE address = $1' : ''
    const result = await db.query(
      `SELECT address, symbol,
              SUM(CASE WHEN flag_type = 'rug'      THEN 1 ELSE 0 END) AS rug,
              SUM(CASE WHEN flag_type = 'honeypot' THEN 1 ELSE 0 END) AS honeypot,
              SUM(CASE WHEN flag_type = 'not_beta' THEN 1 ELSE 0 END) AS not_beta
       FROM token_flags ${where}
       GROUP BY address, symbol`,
      params
    )
    const flags = {}
    for (const row of result.rows) {
      flags[row.address] = {
        symbol:   row.symbol,
        rug:      parseInt(row.rug)      || 0,
        honeypot: parseInt(row.honeypot) || 0,
        not_beta: parseInt(row.not_beta) || 0,
      }
    }
    // Cache full-table results
    if (!address) {
      _flagsCache     = flags
      _flagsCacheTime = Date.now()
    }
    return res.json({ flags })
  } catch (err) {
    console.error('[DB] flags error:', err.message)
    if (!address && _flagsCache) return res.json({ flags: _flagsCache })
    return res.status(500).json({ error: 'db read failed' })
  }
})

// ─── Nominations ───────────────────────────────────────────────────
// POST /api/nominate
// Submits or updates an OG nomination. Upserts on address.
// Body: { address, symbol, name, note }
app.post('/api/nominate', (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { address, symbol, name, note } = req.body
  if (!address || !symbol) return res.status(400).json({ error: 'address and symbol required' })
  res.json({ ok: true })
  DB_WRITE_QUEUE.run(async () => {
    try {
      await db.query(
        `INSERT INTO nominations (address, symbol, name, note, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (address) DO UPDATE SET
           symbol     = EXCLUDED.symbol,
           name       = EXCLUDED.name,
           note       = EXCLUDED.note,
           updated_at = NOW()`,
        [address, symbol, name || null, note || null]
      )
      console.log(`[Nominations] Submitted $${symbol}`)
    } catch (err) {
      console.error('[DB] nominate error:', err.message)
    }
  }).catch(() => {})
})

// GET /api/nominations
// Returns all nominations. Admin panel reads from here.
// Shape: [ { address, symbol, name, note, status, created_at } ]
app.get('/api/nominations', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ nominations: [] })
  try {
    const result = await db.query(
      `SELECT address, symbol, name, note, status, created_at, updated_at
       FROM nominations
       ORDER BY created_at DESC`
    )
    return res.json({ nominations: result.rows })
  } catch (err) {
    console.error('[DB] nominations error:', err.message)
    return res.status(500).json({ error: 'db read failed' })
  }
})

// PATCH /api/nominations/:address
// Admin — update nomination status (pending → approved/rejected).
// Body: { status }
app.patch('/api/nominations/:address', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { address } = req.params
  const { status }  = req.body
  if (!['pending','approved','rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be pending, approved, or rejected' })
  }
  try {
    await db.query(
      `UPDATE nominations SET status = $1, updated_at = NOW() WHERE address = $2`,
      [status, address]
    )
    return res.json({ ok: true })
  } catch (err) {
    console.error('[DB] nomination status update error:', err.message)
    return res.status(500).json({ error: 'db update failed' })
  }
})

// GET /api/beta-count?address=xxx
// Returns the number of confirmed betas ever found for a given alpha address.
// Derived from beta_relations COUNT — no localStorage needed.
// Used by useAlphas.js to power the Legend algorithm across all users.
app.get('/api/beta-count', async (req, res) => {
  const { address } = req.query
  if (!address) return res.status(400).json({ error: 'address required' })
  if (!process.env.DATABASE_URL) return res.json({ count: 0 })
  try {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM beta_relations WHERE alpha_address = $1`,
      [address]
    )
    return res.json({ count: result.rows[0]?.count || 0 })
  } catch (err) {
    console.error('[DB] beta-count error:', err.message)
    return res.json({ count: 0 })
  }
})

// GET /api/history/full?days=7
// Returns token data for revival detection, cooling tab, and positioning tab.
//
// BANDWIDTH OPTIMISATIONS (Session 30 — Supabase egress exceeded):
//   1. Server-side cache (3min TTL) — one DB read serves ALL users simultaneously.
//      Cache is shared across requests; invalidated after 3 minutes.
//   2. Activity filter — only returns tokens with liq >= 1K OR vol >= 1K OR is_revival.
//      Dead tokens (zero activity) are excluded — they'll never pass detectReversal.
//   3. runCount subquery removed — was O(N) per row, expensive and unused by revival.
//   4. Slim SELECT — only columns needed by detectReversal + loadHistoricalByPriceAction.
//
// Result: ~80-90% egress reduction vs original implementation.
let _historyFullCache     = null
let _historyFullCacheTime = 0
const HISTORY_FULL_TTL_MS = 15 * 60 * 1000  // 15 minutes — aggressive cache to cut egress

app.get('/api/history/full', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ tokens: [] })
  const days = Math.min(parseInt(req.query.days) || 7, 30)

  // Serve from server-side cache — all users share one DB read per 15 minutes
  const now = Date.now()
  if (_historyFullCache && (now - _historyFullCacheTime) < HISTORY_FULL_TTL_MS) {
    return res.json({ tokens: _historyFullCache })
  }

  try {
    // Stripped to minimal columns — cuts payload/egress significantly
    const result = await db.query(`
      SELECT DISTINCT ON (r.token_address)
        r.token_address      AS address,
        t.symbol,
        t.name,
        t.logo_url           AS "logoUrl",
        t.peak_mcap          AS "peakMarketCap",
        t.ath_mcap           AS "athMcap",
        t.ath_at             AS "athAt",
        t.ath_price          AS "athPrice",
        t.parent_address     AS "parentAddress",
        t.parent_symbol      AS "parentSymbol",
        t.total_run_count    AS "totalRunCount",
        r.mcap               AS "marketCap",
        r.volume_24h         AS "volume24h",
        r.price_change_24h   AS "priceChange24h",
        r.price              AS "priceUsd",
        r.source,
        r.timestamp          AS "priceRefreshedAt",
        r.is_revival         AS "isRevival",
        r.recovery_pct       AS "recoveryPct",
        r.liquidity          AS "liquidity"
      FROM alpha_runs r
      JOIN tokens t ON t.address = r.token_address
      WHERE r.timestamp > NOW() - ($1 || ' days')::INTERVAL
        AND (
          r.liquidity  >= 1000 OR
          r.volume_24h >= 1000 OR
          r.is_revival = true
        )
      ORDER BY r.token_address, r.timestamp DESC
    `, [days])

    const tokens = result.rows.map(t => ({
      ...t,
      priceRefreshedAt: t.priceRefreshedAt ? new Date(t.priceRefreshedAt).getTime() : null,
      peakMarketCap:    parseFloat(t.peakMarketCap)  || 0,
      marketCap:        parseFloat(t.marketCap)      || 0,
      volume24h:        parseFloat(t.volume24h)      || 0,
      priceChange24h:   parseFloat(t.priceChange24h) || 0,
      recoveryPct:      t.recoveryPct ? parseFloat(t.recoveryPct) : null,
      isRevival:        t.isRevival || false,
      liquidity:        parseFloat(t.liquidity)      || 0,
      athMcap:          parseFloat(t.athMcap)        || 0,
      athAt:            t.athAt ? new Date(t.athAt).getTime() : null,
      athPrice:         parseFloat(t.athPrice)       || 0,
      totalRunCount:    parseInt(t.totalRunCount)    || 0,
    }))

    _historyFullCache     = tokens
    _historyFullCacheTime = now
    console.log(`[HistoryFull] Cached ${tokens.length} tokens (${days}d) — egress-optimised`)

    return res.json({ tokens })
  } catch (err) {
    console.error('[DB] history/full error:', err.message)
    // Serve stale cache on DB error rather than returning empty
    if (_historyFullCache) {
      console.warn('[HistoryFull] Serving stale cache due to DB error')
      return res.json({ tokens: _historyFullCache })
    }
    // No cache — return empty rather than 500 so frontend doesn't crash
    return res.json({ tokens: [] })
  }
})
// Replaces the localStorage betaplays_seen_alphas read in the History tab.
// Returns one row per token — the most recent run for that address.
app.get('/api/history', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ tokens: [] })
  const days = Math.min(parseInt(req.query.days) || 7, 30)  // max 30 days

  try {
    const result = await db.query(`
      SELECT DISTINCT ON (r.token_address)
        r.token_address  AS address,
        t.symbol,
        t.name,
        t.logo_url       AS "logoUrl",
        r.mcap           AS "marketCap",
        r.volume_24h     AS "volume24h",
        r.price_change_24h AS "priceChange24h",
        r.source,
        r.price,
        r.timestamp      AS "lastSeen",
        t.peak_mcap      AS "peakMcap"
      FROM alpha_runs r
      JOIN tokens t ON t.address = r.token_address
      WHERE r.timestamp > NOW() - ($1 || ' days')::INTERVAL
      ORDER BY r.token_address, r.timestamp DESC
    `, [days])

    return res.json({ tokens: result.rows })
  } catch (err) {
    console.error('[DB] history error:', err.message)
    return res.status(500).json({ error: 'db read failed' })
  }
})

// POST /api/record-betas
// Called fire-and-forget from useBetas.js after a scan completes.
// Routed through DB_WRITE_QUEUE to keep writes orderly.
app.post('/api/record-betas', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true, skipped: 'no db' })
  const { alphaAddress, betas } = req.body
  if (!alphaAddress || !Array.isArray(betas)) {
    return res.status(400).json({ error: 'alphaAddress and betas array required' })
  }

  // Respond immediately — client never waits for this
  res.json({ ok: true, queued: betas.length })

  const valid = betas.filter(b => b.address && b.symbol)
  const errors = []

  for (const beta of valid) {
    await DB_WRITE_QUEUE.run(async () => {
      try {
        await db.query(`
          INSERT INTO tokens (address, symbol, name, logo_url)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (address) DO UPDATE SET
            last_seen = NOW(),
            name      = COALESCE(EXCLUDED.name, tokens.name)
        `, [beta.address, beta.symbol, beta.name || null, beta.logoUrl || null])

        await db.query(`
          INSERT INTO beta_relations
            (alpha_address, beta_address, signals, score, relationship_type,
             beta_price_at_detection, alpha_price_at_detection, beta_mcap_at_detection)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (alpha_address, beta_address) DO UPDATE SET
            last_seen       = NOW(),
            signals         = EXCLUDED.signals,
            score           = EXCLUDED.score,
            confirmed_count = beta_relations.confirmed_count + 1
        `, [
          alphaAddress,
          beta.address,
          beta.signals || [],
          beta.score || null,
          beta.relationshipType || null,
          beta.betaPriceAtDetection   || null,
          beta.alphaPriceAtDetection  || null,
          beta.betaMcapAtDetection    || null,
        ])
      } catch (err) {
        errors.push(beta.address)
      }
    }).catch(err => errors.push(beta.address))
  }

  if (errors.length) console.error('[DB] record-betas partial errors:', errors)
})

// GET /api/beta-history?alpha=<address>&limit=50
// Returns historical beta relationships for a given alpha address.
// Ordered by confirmed_count desc — most consistently detected betas first.
app.get('/api/beta-history', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ betas: [] })
  const { alpha } = req.query
  if (!alpha) return res.status(400).json({ error: 'alpha address required' })
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)

  try {
    const result = await db.query(`
      SELECT
        br.beta_address   AS address,
        t.symbol,
        t.name,
        t.logo_url        AS "logoUrl",
        t.peak_mcap       AS "peakMarketCap",
        br.signals,
        br.score,
        br.relationship_type AS "relationshipType",
        br.first_seen     AS "firstSeen",
        br.last_seen      AS "lastSeen",
        br.confirmed_count AS "confirmedCount",
        br.beta_price_at_detection  AS "priceAtDetection",
        br.beta_mcap_at_detection   AS "mcapAtDetection"
      FROM beta_relations br
      JOIN tokens t ON t.address = br.beta_address
      WHERE br.alpha_address = $1
      ORDER BY br.confirmed_count DESC, br.last_seen DESC
      LIMIT $2
    `, [alpha, limit])

    return res.json({ betas: result.rows })
  } catch (err) {
    console.error('[DB] beta-history error:', err.message)
    return res.status(500).json({ error: 'db read failed' })
  }
})

// GET /api/past-runners?days=30&limit=50
// Powers the Past Runners tab. Returns historical alpha tokens with:
//   - how many times they ran (run_count)
//   - peak mcap ever recorded
//   - their confirmed beta relationships with performance data
//   - narrative category
//   - source breakdown
app.get('/api/past-runners', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ runners: [] })
  const days  = Math.min(parseInt(req.query.days)  || 30, 90)
  const limit = Math.min(parseInt(req.query.limit) || 50, 100)

  try {
    // One row per token — aggregate run data + latest snapshot
    const runnersResult = await db.query(`
      SELECT
        t.address,
        t.symbol,
        t.name,
        t.logo_url            AS "logoUrl",
        t.peak_mcap           AS "peakMcap",
        t.first_seen          AS "firstSeen",
        t.last_seen           AS "lastSeen",
        t.category,
        COUNT(r.id)           AS "runCount",
        MAX(r.mcap)           AS "maxMcap",
        MAX(r.price)          AS "maxPrice",
        AVG(r.price_change_24h) AS "avgChange24h",
        array_agg(DISTINCT r.source) FILTER (WHERE r.source IS NOT NULL) AS sources,
        (SELECT COUNT(*) FROM beta_relations br WHERE br.alpha_address = t.address) AS "betaCount",
        (SELECT MAX(br.confirmed_count) FROM beta_relations br WHERE br.alpha_address = t.address) AS "topBetaConfirmedCount"
      FROM tokens t
      JOIN alpha_runs r ON r.token_address = t.address
      WHERE r.timestamp > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY t.address, t.symbol, t.name, t.logo_url, t.peak_mcap, t.first_seen, t.last_seen, t.category
      ORDER BY COUNT(r.id) DESC, MAX(r.mcap) DESC
      LIMIT $2
    `, [days, limit])

    // For each runner, fetch its top 5 confirmed betas
    const runners = []
    for (const runner of runnersResult.rows) {
      const betasResult = await db.query(`
        SELECT
          br.beta_address                AS address,
          t.symbol,
          t.name,
          t.logo_url                     AS "logoUrl",
          br.signals,
          br.score,
          br.relationship_type           AS "relationshipType",
          br.confirmed_count             AS "confirmedCount",
          br.first_seen                  AS "firstSeen",
          br.beta_price_at_detection     AS "priceAtDetection",
          br.beta_mcap_at_detection      AS "mcapAtDetection",
          br.alpha_price_at_detection    AS "alphaPriceAtDetection"
        FROM beta_relations br
        JOIN tokens t ON t.address = br.beta_address
        WHERE br.alpha_address = $1
        ORDER BY br.confirmed_count DESC, br.score DESC
        LIMIT 5
      `, [runner.address])

      runners.push({
        ...runner,
        runCount:    parseInt(runner.runCount)    || 0,
        betaCount:   parseInt(runner.betaCount)   || 0,
        peakMcap:    parseFloat(runner.peakMcap)  || 0,
        maxMcap:     parseFloat(runner.maxMcap)   || 0,
        firstSeen:   runner.firstSeen  ? new Date(runner.firstSeen).getTime()  : null,
        lastSeen:    runner.lastSeen   ? new Date(runner.lastSeen).getTime()   : null,
        topBetas:    betasResult.rows.map(b => ({
          ...b,
          confirmedCount: parseInt(b.confirmedCount) || 0,
          firstSeen:      b.firstSeen ? new Date(b.firstSeen).getTime() : null,
          priceAtDetection:      parseFloat(b.priceAtDetection)      || null,
          mcapAtDetection:       parseFloat(b.mcapAtDetection)       || null,
          alphaPriceAtDetection: parseFloat(b.alphaPriceAtDetection) || null,
        })),
      })
    }

    return res.json({ runners })
  } catch (err) {
    console.error('[DB] past-runners error:', err.message)
    return res.status(500).json({ error: 'db read failed' })
  }
})
// Replaces per-user localStorage caches with a single server-side cache in Supabase.
// One API call serves all users. TTL: score=10min, vision=24h (matches old localStorage TTLs).

// GET /api/cache/score?key=<cacheKey>
// Frontend sends the same cache key it used to use for localStorage.
app.get('/api/cache/score', async (req, res) => {
  const { key } = req.query
  if (!key) return res.status(400).json({ error: 'key required' })
  const value = await cacheGet(`score:${key}`)
  if (value) return res.json({ hit: true, data: value })
  return res.json({ hit: false })
})

// POST /api/cache/score
// Body: { key, data } — frontend saves result after a successful AI score call.
app.post('/api/cache/score', async (req, res) => {
  const { key, data } = req.body
  if (!key || !data) return res.status(400).json({ error: 'key and data required' })
  await cacheSet(`score:${key}`, data, 6)  // 6 hours — beta narrative fit doesn't change
                                            // meaningfully in minutes. Was 10min (0.167h). 36x improvement.
  return res.json({ ok: true })
})

// GET /api/cache/vision?key=<address>
app.get('/api/cache/vision', async (req, res) => {
  const { key } = req.query
  if (!key) return res.status(400).json({ error: 'key required' })
  const value = await cacheGet(`vision:${key}`)
  if (value) return res.json({ hit: true, data: value })
  return res.json({ hit: false })
})

// POST /api/cache/vision
// Body: { key, data } — frontend saves result after a successful vision analysis call.
app.post('/api/cache/vision', async (req, res) => {
  const { key, data } = req.body
  if (!key || !data) return res.status(400).json({ error: 'key and data required' })
  await cacheSet(`vision:${key}`, data, 24)  // 24 hours — matches old betaplays_vision_cache_v1 TTL
  return res.json({ ok: true })
})

// GET /api/cache/szn?key=<key>
app.get('/api/cache/szn', async (req, res) => {
  const { key } = req.query
  if (!key) return res.status(400).json({ error: 'key required' })
  const value = await cacheGet(`szn:${key}`)
  if (value) return res.json({ hit: true, data: value })
  return res.json({ hit: false })
})

// POST /api/cache/szn
// Body: { key, data }
app.post('/api/cache/szn', async (req, res) => {
  const { key, data } = req.body
  if (!key || !data) return res.status(400).json({ error: 'key and data required' })
  await cacheSet(`szn:${key}`, data, 24)  // 24 hours — matches old betaplays_szn_cache_v1 TTL
  return res.json({ ok: true })
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
  // QUOTA CAP: max 30 per cycle, sorted by momentum — warmup the most
  // active tokens first. Remaining expand on-demand when user clicks them.
  // Was queuing 337+ at boot = 337 Groq calls before any user scan.
  const queuedAddresses = new Set(warmupQueue.map(t => t.address))
  let queued = 0

  const sortedAlphas = [...alphas].sort((a, b) =>
    ((b.volume24h || 0) * Math.abs(parseFloat(b.priceChange24h) || 0)) -
    ((a.volume24h || 0) * Math.abs(parseFloat(a.priceChange24h) || 0))
  )

  // Cap warmup at the actual number of live tokens — no point warming more
  // slots than there are tokens on the feed. Floor at 10 (cold start), ceil
  // at 50 (quota protection). Was hardcoded at 30 regardless of feed size.
  const WARMUP_CAP = Math.min(Math.max(alphas.length, 10), 50)
  for (const alpha of sortedAlphas) {
    if (queued >= WARMUP_CAP) break
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

// ─── Proactive Beta Scanner ───────────────────────────────────────
// Background job: runs every 5 minutes, fetches the top live alphas
// from DEXScreener and pre-computes betas for each one via the server's
// own endpoints (loopback). Results land in beta_relations so any user
// who clicks an alpha gets instant results instead of a cold scan.
//
// Why loopback instead of duplicating the engine here?
//   - The full scan pipeline (V1–V9 + V8 scoring) lives in useBetas.js
//     on the frontend. Rewriting it server-side creates a two-source-of-truth
//     maintenance problem. Instead, we call /api/expand-alpha and
//     /api/score-betas on ourselves — same logic, zero duplication.
//   - The only thing we do server-side is the DEX keyword search
//     (a simple fetch) and recording the results. The AI calls piggyback
//     on the existing fallback chain.
//
// Concurrency guard: proactiveScanRunning prevents overlapping runs.
// Rate limiting: 2s spacing between alphas, 400ms between requests within each.
// Resource ceiling: top 10 alphas only — avoids hammering AI quotas.

let proactiveScanRunning = false

// Fetch top N live alphas from DEXScreener boosted + profiles feeds.
// Mirrors the two cheapest alpha sources (no Birdeye key needed).
const fetchTopAlphasForScan = async (limit = 10) => {
  const seen    = new Set()
  const results = []

  const addFromFeed = (pairs) => {
    for (const p of (pairs || [])) {
      if (p.chainId !== 'solana') continue
      const addr = p.baseToken?.address
      if (!addr || seen.has(addr)) continue
      seen.add(addr)
      results.push({
        address:     addr,
        symbol:      p.baseToken.symbol  || '',
        name:        p.baseToken.name    || '',
        logoUrl:     p.info?.imageUrl    || null,
        marketCap:   p.marketCap || p.fdv || 0,
        volume24h:   p.volume?.h24       || 0,
        priceChange24h: parseFloat(p.priceChange?.h24) || 0,
        description: p.info?.description || '',
      })
      if (results.length >= limit) return true  // signal: done
    }
    return false
  }

  try {
    const [boostedRes, profilesRes] = await Promise.allSettled([
      fetch('https://api.dexscreener.com/token-boosts/top/v1', { signal: AbortSignal.timeout(8000) }),
      fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(8000) }),
    ])

    if (boostedRes.status === 'fulfilled' && boostedRes.value.ok) {
      const raw  = await boostedRes.value.json()
      const solana = (Array.isArray(raw) ? raw : [])
        .filter(t => t.chainId === 'solana' && t.tokenAddress)
        .slice(0, limit * 2)

      // Resolve boosted token addresses to pairs via DEXScreener
      if (solana.length > 0) {
        const addrs = solana.map(t => t.tokenAddress).join(',')
        try {
          const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`, { signal: AbortSignal.timeout(8000) })
          if (pairsRes.ok) {
            const pairsData = await pairsRes.json()
            if (addFromFeed(pairsData.pairs)) return results
          }
        } catch { /* non-fatal — try profiles next */ }
      }
    }

    if (results.length < limit && profilesRes.status === 'fulfilled' && profilesRes.value.ok) {
      const raw  = await profilesRes.value.json()
      const solana = (Array.isArray(raw) ? raw : [])
        .filter(t => t.chainId === 'solana' && t.tokenAddress)
        .slice(0, limit * 2)

      if (solana.length > 0) {
        const addrs = solana.map(t => t.tokenAddress).join(',')
        try {
          const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`, { signal: AbortSignal.timeout(8000) })
          if (pairsRes.ok) {
            const pairsData = await pairsRes.json()
            addFromFeed(pairsData.pairs)
          }
        } catch { /* non-fatal */ }
      }
    }
  } catch (err) {
    console.warn('[ProactiveScan] Feed fetch error:', err.message)
  }

  return results.slice(0, limit)
}

// Check if beta_relations for this alpha was updated recently.
// If fresh, skip — no point re-scanning what we just scanned.
const isBetaRelationsFresh = async (alphaAddress, maxAgeMinutes = 6) => {
  if (!process.env.DATABASE_URL) return false
  try {
    const result = await db.query(`
      SELECT MAX(last_seen) AS latest
      FROM beta_relations
      WHERE alpha_address = $1
    `, [alphaAddress])
    const latest = result.rows[0]?.latest
    if (!latest) return false
    const ageMs = Date.now() - new Date(latest).getTime()
    return ageMs < maxAgeMinutes * 60 * 1000
  } catch { return false }
}

// Run a lightweight beta scan for one alpha using loopback calls.
// Expand → keyword search → V8 score → record to beta_relations.
const runProactiveScanForAlpha = async (alpha, baseUrl) => {
  const { address, symbol, name, description, logoUrl, marketCap } = alpha

  // ── Step 1: Expand the alpha (uses existing server-side cache) ──
  let expansion = null
  try {
    const res = await fetch(`${baseUrl}/api/expand-alpha`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, symbol, name, description, logoUrl, marketCap, skipVision: true }),
      signal: AbortSignal.timeout(20000),
    })
    if (res.ok) expansion = await res.json()
  } catch (err) {
    console.warn(`[ProactiveScan] $${symbol} — expand-alpha failed:`, err.message)
    return 0
  }

  const searchTerms = [
    ...(expansion?.searchTerms  || []),
    ...(expansion?.visualTerms  || []),
    symbol.toLowerCase(),
  ].filter(Boolean).slice(0, 15)  // cap to avoid hammering DEX

  if (searchTerms.length === 0) return 0

  // ── Step 2: Keyword search on DEXScreener for each term ──
  const candidates = new Map()  // address → pair data

  for (const term of searchTerms.slice(0, 8)) {  // 8 terms max per alpha
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`,
        { signal: AbortSignal.timeout(6000) }
      )
      if (!res.ok) continue
      const data  = await res.json()
      const pairs = (data.pairs || []).filter(p =>
        p.chainId === 'solana' &&
        p.baseToken?.address &&
        p.baseToken.address !== address &&
        (p.liquidity?.usd || 0) >= 500 &&
        (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0) >= 3
      )

      for (const p of pairs.slice(0, 5)) {
        const addr = p.baseToken.address
        if (candidates.has(addr)) continue
        candidates.set(addr, {
          address:        addr,
          symbol:         p.baseToken.symbol || '',
          name:           p.baseToken.name   || '',
          logoUrl:        p.info?.imageUrl   || null,
          marketCap:      p.marketCap || p.fdv || 0,
          volume24h:      p.volume?.h24 || 0,
          liquidity:      p.liquidity?.usd || 0,
          priceChange24h: parseFloat(p.priceChange?.h24) || 0,
          priceUsd:       parseFloat(p.priceUsd) || 0,
          signals:        ['keyword'],
          signalSources:  term,
        })
      }

      await new Promise(r => setTimeout(r, 300))  // 300ms between searches
    } catch { /* non-fatal — continue with next term */ }
  }

  if (candidates.size === 0) return 0

  // ── Step 3: V8 AI scoring via loopback ──
  const candidateList = [...candidates.values()].slice(0, 20)

  const relHints = expansion?.relationshipHints || {}
  const alphaDesc = description
    ? `Description: "${description.slice(0, 200)}"`
    : `Symbol: $${symbol}${name ? ', Name: ' + name : ''}`

  const prompt = `You are classifying Solana meme tokens as potential beta plays for alpha token $${symbol}.

ALPHA TOKEN: $${symbol}${name ? ' (' + name + ')' : ''}
${alphaDesc}
Search terms that found these candidates: ${searchTerms.slice(0, 8).join(', ')}

CANDIDATES:
${candidateList.map((c, i) => `[${i}] $${c.symbol}${c.name ? ' (' + c.name + ')' : ''} — mcap $${Math.round((c.marketCap || 0) / 1000)}K, vol $${Math.round((c.volume24h || 0) / 1000)}K`).join('\n')}

For each candidate, determine if it is a genuine beta play for $${symbol}.
Score 0.0–1.0. Type: TWIN/COUNTER/ECHO/UNIVERSE/SECTOR/EVIL_TWIN/SPIN.

Rules:
- Score ≥ 0.5 = genuine beta. Score < 0.5 = not a beta.
- TWIN: near-identical concept. COUNTER: opposite. ECHO: derivative/consequence.
- UNIVERSE: same cultural world. SECTOR: same category. SPIN: loose derivative.
- Reject if the only connection is "both are crypto tokens".
- Partial match (one shared element) = 0.5–0.7, not rejection.

Respond ONLY with valid JSON array, no markdown:
[{"index":0,"score":0.85,"type":"TWIN","reason":"Same dog theme"},{"index":1,"score":0.2,"type":null,"reason":"Unrelated"}]`

  let scores = []
  try {
    const res = await fetch(`${baseUrl}/api/score-betas`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) {
      const raw = await res.json()
      scores = Array.isArray(raw) ? raw : []
    }
  } catch (err) {
    console.warn(`[ProactiveScan] $${symbol} — score-betas failed:`, err.message)
    // Continue — record keyword-only hits with score null
  }

  // ── Step 4: Record confirmed betas to beta_relations ──
  if (!process.env.DATABASE_URL) return 0

  const confirmed = scores.filter(s => (s.score || 0) >= 0.5)
  let recorded = 0

  for (const scored of confirmed) {
    const candidate = candidateList[scored.index]
    if (!candidate) continue

    try {
      // Ensure token exists in registry
      await db.query(`
        INSERT INTO tokens (address, symbol, name, logo_url)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (address) DO UPDATE SET
          last_seen = NOW(),
          name      = COALESCE(EXCLUDED.name, tokens.name),
          logo_url  = COALESCE(EXCLUDED.logo_url, tokens.logo_url)
      `, [candidate.address, candidate.symbol, candidate.name || null, candidate.logoUrl || null])

      // Upsert beta relationship
      await db.query(`
        INSERT INTO beta_relations
          (alpha_address, beta_address, signals, score, relationship_type,
           beta_price_at_detection, alpha_price_at_detection, beta_mcap_at_detection)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (alpha_address, beta_address) DO UPDATE SET
          last_seen       = NOW(),
          signals         = EXCLUDED.signals,
          score           = EXCLUDED.score,
          confirmed_count = beta_relations.confirmed_count + 1
      `, [
        address,
        candidate.address,
        ['keyword', scored.type ? 'ai_match' : null].filter(Boolean),
        scored.score || null,
        scored.type  || null,
        candidate.priceUsd    || null,
        alpha.priceUsd        || null,
        candidate.marketCap   || null,
      ])

      recorded++
    } catch { /* non-fatal per-token error */ }
  }

  if (recorded > 0 || candidates.size > 0) {
    console.log(`[ProactiveScan] $${symbol} — ${candidates.size} candidates, ${confirmed.length} scored ≥0.5, ${recorded} recorded`)
  }

  return recorded
}

// Main proactive scan loop — runs every 5 minutes
const startProactiveBetaScanner = (port) => {
  const baseUrl = `http://localhost:${port}`

  const runScan = async () => {
    if (proactiveScanRunning) {
      console.log('[ProactiveScan] Previous scan still running — skipping this cycle')
      return
    }
    proactiveScanRunning = true
    const scanStart = Date.now()

    try {
      console.log('[ProactiveScan] Starting scan cycle...')
      const alphas = await fetchTopAlphasForScan(10)

      if (alphas.length === 0) {
        console.log('[ProactiveScan] No alphas fetched — skipping cycle')
        return
      }

      console.log(`[ProactiveScan] ${alphas.length} alphas to scan: ${alphas.map(a => '$' + a.symbol).join(', ')}`)

      let totalRecorded = 0

      for (const alpha of alphas) {
        // Skip if beta_relations was updated in the last 6 minutes
        const fresh = await isBetaRelationsFresh(alpha.address, 6)
        if (fresh) {
          console.log(`[ProactiveScan] $${alpha.symbol} — fresh, skipping`)
          continue
        }

        try {
          const n = await runProactiveScanForAlpha(alpha, baseUrl)
          totalRecorded += n
        } catch (err) {
          console.warn(`[ProactiveScan] $${alpha.symbol} error:`, err.message)
        }

        // 2s spacing between alphas — avoids rate-limit cascades
        await new Promise(r => setTimeout(r, 2000))
      }

      const elapsed = Math.round((Date.now() - scanStart) / 1000)
      console.log(`[ProactiveScan] Cycle complete — ${totalRecorded} betas recorded in ${elapsed}s`)
    } catch (err) {
      console.error('[ProactiveScan] Cycle error:', err.message)
    } finally {
      proactiveScanRunning = false
    }
  }

  // First run after 60s (let server fully boot + warm up caches first)
  setTimeout(runScan, 60 * 1000)
  // Then every 5 minutes
  setInterval(runScan, 5 * 60 * 1000)
  console.log('[ProactiveScan] Scheduled — first run in 60s, then every 5min')
}

// ─── Auth — Wallet Connect (Session 31) ───────────────────────────────────────
// Flow: frontend requests a nonce → user signs it with their wallet →
//       backend verifies signature → issues JWT → frontend stores JWT in localStorage.
// JWT is stateless — no session table needed. Users table records first_seen/last_seen.
// Nonces are single-use and expire in 5 minutes.

const JWT_SECRET = process.env.JWT_SECRET || 'betaplays-dev-secret-change-in-prod'
const nonceStore = new Map() // walletAddress → { nonce, expiresAt }

function requireAuth (req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' })
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// GET /api/auth/nonce?wallet=<base58Address>
// Returns a random nonce string the wallet must sign.
app.get('/api/auth/nonce', (req, res) => {
  const { wallet } = req.query
  if (!wallet || wallet.length < 32 || wallet.length > 44) {
    return res.status(400).json({ error: 'Invalid wallet address' })
  }
  const nonce = `BetaPlays sign-in: ${Date.now()}-${Math.random().toString(36).slice(2)}`
  nonceStore.set(wallet, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 })
  res.json({ nonce })
})

// POST /api/auth/verify
// Body: { wallet: string, signature: number[] }
// Verifies the Ed25519 signature over the stored nonce, then issues a JWT.
app.post('/api/auth/verify', async (req, res) => {
  const { wallet, signature } = req.body
  if (!wallet || !Array.isArray(signature)) {
    return res.status(400).json({ error: 'wallet and signature required' })
  }

  const entry = nonceStore.get(wallet)
  if (!entry) return res.status(400).json({ error: 'No nonce found — request a new one' })
  if (Date.now() > entry.expiresAt) {
    nonceStore.delete(wallet)
    return res.status(400).json({ error: 'Nonce expired — request a new one' })
  }

  // Verify Ed25519 signature
  try {
    const msgBytes = new TextEncoder().encode(entry.nonce)
    const sigBytes = new Uint8Array(signature)
    const pubKey   = new PublicKey(wallet).toBytes()
    const valid   = nacl.sign.detached.verify(msgBytes, sigBytes, pubKey)
    if (!valid) return res.status(401).json({ error: 'Signature verification failed' })
  } catch (err) {
    console.error('[Auth] Signature verify error:', err.message)
    return res.status(401).json({ error: 'Signature verification failed' })
  }

  // Nonce is single-use — delete immediately after verification
  nonceStore.delete(wallet)

  // Upsert user record in Supabase — fire and forget, never blocks JWT issue
  db.query(
    `INSERT INTO users (wallet_address, first_seen, last_seen)
     VALUES ($1, NOW(), NOW())
     ON CONFLICT (wallet_address) DO UPDATE SET last_seen = NOW()`,
    [wallet]
  ).catch(err => console.error('[Auth] User upsert failed:', err.message))

  const token = jwt.sign({ wallet }, JWT_SECRET, { expiresIn: '30d' })
  console.log(`[Auth] Login: ${wallet.slice(0, 8)}...`)
  res.json({ token, wallet })
})

// GET /api/auth/me — returns user record (JWT required)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT wallet_address, first_seen, last_seen, display_name FROM users WHERE wallet_address = $1`,
      [req.user.wallet]
    )
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' })
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'DB error' })
  }
})

// GET /api/watchlist — returns wallet's saved tokens (JWT required)
app.get('/api/watchlist', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT token_address, symbol, name, added_at, price_at_add, logo_url, mcap_at_add, narrative_tag
       FROM watchlist WHERE wallet_address = $1 ORDER BY added_at DESC`,
      [req.user.wallet]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'DB error' })
  }
})

// POST /api/watchlist — add token to watchlist (JWT required)
// Body: { token_address, symbol, name, price_at_add, logo_url, mcap_at_add }
app.post('/api/watchlist', requireAuth, async (req, res) => {
  const { token_address, symbol, name, price_at_add, logo_url, mcap_at_add } = req.body
  if (!token_address) return res.status(400).json({ error: 'token_address required' })
  try {
    await db.query(
      `INSERT INTO watchlist (wallet_address, token_address, symbol, name, price_at_add, logo_url, mcap_at_add)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (wallet_address, token_address) DO NOTHING`,
      [req.user.wallet, token_address, symbol || null, name || null,
       price_at_add || null, logo_url || null, mcap_at_add || null]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'DB error' })
  }
})

// PATCH /api/watchlist/:address/tag — set narrative tag on a watchlist token (JWT required)
app.patch('/api/watchlist/:address/tag', requireAuth, async (req, res) => {
  const { narrative_tag } = req.body
  try {
    await db.query(
      `UPDATE watchlist SET narrative_tag = $1
       WHERE wallet_address = $2 AND token_address = $3`,
      [narrative_tag || null, req.user.wallet, req.params.address]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'DB error' })
  }
})

// DELETE /api/watchlist/:address — remove token from watchlist (JWT required)
app.delete('/api/watchlist/:address', requireAuth, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM watchlist WHERE wallet_address = $1 AND token_address = $2`,
      [req.user.wallet, req.params.address]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'DB error' })
  }
})

// Clean up expired nonces every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [wallet, entry] of nonceStore.entries()) {
    if (now > entry.expiresAt) nonceStore.delete(wallet)
  }
}, 10 * 60 * 1000)

// ─── End Auth ─────────────────────────────────────────────────────────────────

// ─── Folios (Session 31) ──────────────────────────────────────────────────────
// Multiple folios per wallet. Each folio has its own name, bio, public toggle.
// Calls belong to a specific folio. Leaderboard groups all folios by wallet.

let _leaderboardCache = null
let _leaderboardCacheAt = 0
const LEADERBOARD_TTL = 5 * 60 * 1000

// GET /api/folio/profile — current user profile (JWT required)
app.get('/api/folio/profile', requireAuth, async (req, res) => {
  try {
    await db.query(`INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO NOTHING`, [req.user.wallet])
    const result = await db.query(
      `SELECT wallet_address, folio_name, folio_bio, folio_public, first_seen FROM users WHERE wallet_address = $1`,
      [req.user.wallet]
    )
    res.json(result.rows[0] || { wallet_address: req.user.wallet })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/folios/mine — get all folios for current user (JWT required)
app.get('/api/folios/mine', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT f.id, f.name, f.bio, f.public, f.created_at,
              COUNT(fc.token_address) AS call_count
       FROM folios f
       LEFT JOIN folio fc ON fc.folio_id = f.id
       WHERE f.wallet_address = $1
       GROUP BY f.id ORDER BY f.created_at ASC`,
      [req.user.wallet]
    )
    res.json(result.rows)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/folios — create a new folio (JWT required)
app.post('/api/folios', requireAuth, async (req, res) => {
  const { name, bio, public: isPublic } = req.body
  try {
    await db.query(`INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO NOTHING`, [req.user.wallet])
    const result = await db.query(
      `INSERT INTO folios (wallet_address, name, bio, public) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.wallet, name || null, bio || null, isPublic ?? true]
    )
    _leaderboardCache = null
    res.json(result.rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PATCH /api/folios/:id — update folio name/bio/public (JWT required)
app.patch('/api/folios/:id', requireAuth, async (req, res) => {
  const { name, bio, public: isPublic } = req.body
  try {
    await db.query(
      `UPDATE folios SET name = COALESCE($1, name), bio = COALESCE($2, bio), public = COALESCE($3, public)
       WHERE id = $4 AND wallet_address = $5`,
      [name ?? null, bio ?? null, isPublic ?? null, req.params.id, req.user.wallet]
    )
    _leaderboardCache = null
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/folios/:id — delete folio and all its calls (JWT required)
app.delete('/api/folios/:id', requireAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM folios WHERE id = $1 AND wallet_address = $2`, [req.params.id, req.user.wallet])
    _leaderboardCache = null
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/folios/:id/calls — get calls for a specific folio
app.get('/api/folios/:id/calls', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT token_address, symbol, name, logo_url, price_at_call, mcap_at_call, called_at, narrative_tag
       FROM folio WHERE folio_id = $1 AND wallet_address = $2 ORDER BY called_at DESC`,
      [req.params.id, req.user.wallet]
    )
    res.json(result.rows)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/folio/call — add token to a specific folio (JWT required)
app.post('/api/folio/call', requireAuth, async (req, res) => {
  const { token_address, symbol, name, logo_url, price_at_call, mcap_at_call, folio_id } = req.body
  if (!token_address) return res.status(400).json({ error: 'token_address required' })
  if (!folio_id) return res.status(400).json({ error: 'folio_id required' })
  try {
    await db.query(`INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO NOTHING`, [req.user.wallet])
    // Verify folio belongs to this wallet
    const folioCheck = await db.query(`SELECT id FROM folios WHERE id = $1 AND wallet_address = $2`, [folio_id, req.user.wallet])
    if (!folioCheck.rows.length) return res.status(403).json({ error: 'Folio not found' })
    await db.query(
      `INSERT INTO folio (wallet_address, token_address, symbol, name, logo_url, price_at_call, mcap_at_call, folio_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (wallet_address, token_address) DO UPDATE SET folio_id = $8`,
      [req.user.wallet, token_address, symbol || null, name || null, logo_url || null, price_at_call || null, mcap_at_call || null, folio_id]
    )
    _leaderboardCache = null
    res.json({ ok: true })
  } catch (err) {
    console.error('[Folio] Call error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/folio/call/:address — remove a call (JWT required)
app.delete('/api/folio/call/:address', requireAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM folio WHERE wallet_address = $1 AND token_address = $2`, [req.user.wallet, req.params.address])
    _leaderboardCache = null
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PATCH /api/folio/call/:address/tag — set narrative tag (JWT required)
app.patch('/api/folio/call/:address/tag', requireAuth, async (req, res) => {
  const { narrative_tag } = req.body
  try {
    await db.query(`UPDATE folio SET narrative_tag = $1 WHERE wallet_address = $2 AND token_address = $3`, [narrative_tag || null, req.user.wallet, req.params.address])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/folio/search?q= — search token by ticker or CA
app.get('/api/folio/search', async (req, res) => {
  const { q } = req.query
  if (!q || q.length < 2) return res.json([])
  try {
    const isCA = q.length >= 32
    const url = isCA
      ? `https://api.dexscreener.com/latest/dex/tokens/${q}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`
    const r = await fetch(url, { headers: { 'User-Agent': 'BetaPlays/1.0' } })
    const data = await r.json()
    const pairs = (data.pairs || [])
      .filter(p => p.chainId === 'solana' && parseFloat(p.liquidity?.usd || 0) > 500)
      .slice(0, 5)
      .map(p => ({
        address: p.baseToken?.address, symbol: p.baseToken?.symbol, name: p.baseToken?.name,
        price: parseFloat(p.priceUsd || 0), mcap: p.marketCap || 0,
        liquidity: p.liquidity?.usd || 0, logoUrl: p.info?.imageUrl || null,
      }))
    res.json(pairs)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/folio/leaderboard — all folios ranked by avg P&L, grouped by wallet
app.get('/api/folio/leaderboard', async (req, res) => {
  try {
    if (_leaderboardCache && Date.now() - _leaderboardCacheAt < LEADERBOARD_TTL) {
      return res.json(_leaderboardCache)
    }
    const result = await db.query(`
      SELECT
        u.wallet_address,
        fl.id         AS folio_id,
        fl.name       AS folio_name,
        fl.bio        AS folio_bio,
        u.first_seen,
        COUNT(fc.token_address) AS call_count,
        json_agg(json_build_object(
          'address',       fc.token_address,
          'symbol',        fc.symbol,
          'name',          fc.name,
          'logo_url',      fc.logo_url,
          'price_at_call', fc.price_at_call,
          'mcap_at_call',  fc.mcap_at_call,
          'narrative_tag', fc.narrative_tag,
          'called_at',     fc.called_at
        ) ORDER BY fc.called_at DESC) AS calls
      FROM users u
      JOIN folios fl ON fl.wallet_address = u.wallet_address AND fl.public = TRUE
      JOIN folio fc ON fc.folio_id = fl.id
      GROUP BY u.wallet_address, fl.id, fl.name, fl.bio, u.first_seen
      HAVING COUNT(fc.token_address) >= 1
      ORDER BY COUNT(fc.token_address) DESC
      LIMIT 100
    `)

    const folios = result.rows
    // Batch fetch live prices
    const allAddresses = [...new Set(folios.flatMap(f => (f.calls || []).map(c => c.address).filter(Boolean)))]
    const livePrices = {}
    if (allAddresses.length > 0) {
      const batches = []
      for (let i = 0; i < allAddresses.length; i += 30) batches.push(allAddresses.slice(i, i + 30))
      await Promise.allSettled(batches.map(async batch => {
        try {
          const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, { headers: { 'User-Agent': 'BetaPlays/1.0' } })
          const data = await r.json()
          for (const pair of (data.pairs || [])) {
            const addr = pair.baseToken?.address
            if (addr) livePrices[addr] = parseFloat(pair.priceUsd || 0)
          }
        } catch {}
      }))
    }

    // Compute P&L per folio, group by wallet
    const walletMap = {}
    for (const folio of folios) {
      const callsWithPnl = (folio.calls || []).map(c => {
        const cur = livePrices[c.address]
        const entry = c.price_at_call
        const pnl = cur && entry && entry > 0 ? ((cur - entry) / entry) * 100 : null
        return { ...c, current_price: cur || null, pnl_pct: pnl }
      })
      const pnlVals = callsWithPnl.map(c => c.pnl_pct).filter(p => p !== null)
      const avgPnl = pnlVals.length > 0 ? pnlVals.reduce((a, b) => a + b, 0) / pnlVals.length : null
      const bestCall = callsWithPnl.reduce((b, c) => (!b || (c.pnl_pct !== null && c.pnl_pct > (b.pnl_pct ?? -Infinity))) ? c : b, null)
      const folioWithPnl = { ...folio, calls: callsWithPnl, avg_pnl: avgPnl, best_call: bestCall }

      if (!walletMap[folio.wallet_address]) {
        walletMap[folio.wallet_address] = { wallet_address: folio.wallet_address, first_seen: folio.first_seen, folios: [] }
      }
      walletMap[folio.wallet_address].folios.push(folioWithPnl)
    }

    // Compute overall wallet score = avg P&L across ALL folios
    const wallets = Object.values(walletMap).map(w => {
      const allPnl = w.folios.map(f => f.avg_pnl).filter(p => p !== null)
      const overallPnl = allPnl.length > 0 ? allPnl.reduce((a, b) => a + b, 0) / allPnl.length : null
      const totalCalls = w.folios.reduce((sum, f) => sum + Number(f.call_count), 0)
      return { ...w, overall_pnl: overallPnl, total_calls: totalCalls }
    }).sort((a, b) => {
      if (a.overall_pnl !== null && b.overall_pnl !== null) return b.overall_pnl - a.overall_pnl
      if (a.overall_pnl !== null) return -1
      if (b.overall_pnl !== null) return 1
      return b.total_calls - a.total_calls
    })

    _leaderboardCache = { wallets, updatedAt: Date.now() }
    _leaderboardCacheAt = Date.now()
    res.json(_leaderboardCache)
  } catch (err) {
    console.error('[Folio] Leaderboard error:', err.message)
    if (_leaderboardCache) return res.json(_leaderboardCache)
    res.json({ wallets: [], updatedAt: Date.now() })
  }
})

// PATCH /api/folio/settings — legacy single-folio settings (JWT required)
app.patch('/api/folio/settings', requireAuth, async (req, res) => {
  const { folioName, folioBio, folioPublic } = req.body
  try {
    await db.query(`INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO NOTHING`, [req.user.wallet])
    await db.query(
      `UPDATE users SET folio_name = COALESCE($1, folio_name), folio_bio = COALESCE($2, folio_bio), folio_public = COALESCE($3, folio_public) WHERE wallet_address = $4`,
      [folioName ?? null, folioBio ?? null, folioPublic ?? null, req.user.wallet]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('[Folio] Settings error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── End Folios ───────────────────────────────────────────────────────────────


const PORT = process.env.PORT || 3001
app.listen(PORT, async () => {
  console.log(`BetaPlays backend on port ${PORT}`)
  // Delay DB init by 15s — gives pool time to settle and avoids EMAXCONN
  // on cold starts where multiple processes race for connections simultaneously.
  setTimeout(async () => {
    await db.init()
    // Load persisted expansion cache from Supabase after schema is confirmed ready
    await loadExpansionCache(expansionCache)
  }, 15_000)
  // Initialise Telegram service after server is up
  telegramService.init().catch(err =>
    console.error('[TelegramService] Init failed:', err.message)
  )
  // Initialise Twitter service (stub — logs status, no-ops until credentials added)
  twitterService.init().catch(err =>
    console.error('[TwitterService] Init failed:', err.message)
  )
  newsService.init()
  console.log('[Warmup] Cache warming driven by live feed via report-alphas')
  console.log('[ProactiveScan] Disabled — re-enable when Groq Developer tier active')
})