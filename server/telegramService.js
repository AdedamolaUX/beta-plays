// ─── BetaPlays — Telegram Service (Vector 10) ─────────────────────
// Social Signal Intelligence — finds beta tokens from Telegram channels
//
// Architecture:
//   - Fully decoupled from frontend scan — runs on 15-min background interval
//   - All DEX quality checks happen at poll time, never on request
//   - Frontend calls /api/telegram-betas?symbol=X → reads cache instantly
//   - Known alpha list fed via updateKnownAlphas() from /api/report-alphas
//
// Extraction Rules (the key design decision):
//   - ALPHA identification: must have $ prefix OR already in known alpha list
//   - BETA identification: $ prefix OR any text term (loose, quality filter handles noise)
//   - Bare words WITHOUT $ are NEVER treated as unknown alphas
//   - This kills "lol", "gc", "all" false positives without any blocklist
//
// Per-concept Runner Selection:
//   momentumScore = (1hVol×0.4) + (1hChange%×0.3) + (liq×0.2) + (txnVelocity×0.1)
//   TIED: show 2 tokens if within 10% momentum of each other
// ──────────────────────────────────────────────────────────────────

const path                  = require('path')
const { TelegramClient }    = require('telegram')
const { StringSession }     = require('telegram/sessions')
const { TELEGRAM_CHANNELS } = require('./telegram_channels')

require('dotenv').config({ path: path.join(__dirname, '.env') })

// ─── Config ───────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 15 * 60 * 1000       // 15 minutes
const MESSAGE_MAX_AGE_MS  = 48 * 60 * 60 * 1000  // 48 hours
const CACHE_TTL_MS        = 30 * 60 * 1000       // 30 min result cache
const HOLDING_POOL_TTL_MS = 48 * 60 * 60 * 1000  // 48h holding pool
const DEX_BATCH_SIZE      = 30
const MIN_LIQUIDITY       = 2000
const MIN_TOKEN_AGE_MS    = 60 * 60 * 1000       // 1 hour
const MAX_BETAS_PER_ALPHA = 10                   // hard cap per alpha
const MAX_BETA_TERMS_MSG  = 3                    // max beta terms extracted per message

// ─── Generic words stripped during concept grouping ───────────────
const GENERIC_STRIP = new Set([
  'inu', 'coin', 'token', '2.0', 'v2', 'v3', 'the', 'a', 'of',
  'on', 'solana', 'sol', 'meme', 'baby', 'mini', 'little', 'og',
  'official', 'real', 'based', 'ai', 'dao', 'fi', 'defi', 'nft',
])

// ─── Relationship keywords (confidence boost) ─────────────────────
const RELATIONSHIP_KEYWORDS = [
  'beta', 'beta play', 'sister', 'sister token', 'derivative',
  'related', 'follow', 'next', 'evil twin', 'twin', 'if.*runs',
  'when.*pumps', 'watch', 'baby', 'mini', 'spin.?off', 'echo',
]

// ─── Pure hype — skip entire message ─────────────────────────────
const HYPE_ONLY_PATTERNS = [
  /^\s*[🚀💎🔥👀]+\s*$/,
  /^(wen|when|gm|gn|wagmi|ngmi|ser|fren|based|cope|rekt)\s*$/i,
  /^(buy|sell|hold|hodl|moon|pump|dump|rug|100x|1000x)\s*[🚀💎🔥👀]*\s*$/i,
]

// ─── Tiered txn count minimums (mirrors isActiveBeta) ─────────────
function minTxnCount (mcap) {
  if (mcap < 100_000)    return 3
  if (mcap < 1_000_000)  return 8
  if (mcap < 10_000_000) return 15
  return 30
}

// ─── State ────────────────────────────────────────────────────────
let telegramClient = null
let isConnected    = false
let pollTimer      = null
let knownAlphas    = []        // fed by /api/report-alphas from frontend
let knownAlphaSet  = new Set() // lowercase symbol + name lookup
let knownSymbolSet = new Set() // lowercase symbols only (for single-word matching)

const betaCache  = new Map()   // { [alphaSymbol_lower]: { results, ts } }
const holdingPool = []          // { term, type, channel, confidence, ts }

// ─── Update known alphas ──────────────────────────────────────────
function updateKnownAlphas (alphas) {
  if (!Array.isArray(alphas)) return
  const wasEmpty = knownAlphas.length === 0
  knownAlphas = alphas
  knownAlphaSet.clear()
  knownSymbolSet.clear()
  for (const a of alphas) {
    if (a.symbol) {
      knownAlphaSet.add(a.symbol.toLowerCase())
      knownSymbolSet.add(a.symbol.toLowerCase())
    }
    if (a.name) knownAlphaSet.add(a.name.toLowerCase())
  }
  // First time alphas arrive — immediately check holding pool
  if (wasEmpty && holdingPool.length > 0 && isConnected) {
    console.log(`[TelegramService] Alphas received — checking holding pool (${holdingPool.length} items)`)
    checkHoldingPool().catch(() => {})
  }
}

// ─── Get cached betas for a symbol ────────────────────────────────
function getTelegramBetas (symbol) {
  if (!symbol) return []
  const key    = symbol.toLowerCase()
  const cached = betaCache.get(key)
  if (!cached) return []
  if (Date.now() - cached.ts > CACHE_TTL_MS) { betaCache.delete(key); return [] }
  return cached.results
}

// ─── Extract $TICKER tokens ───────────────────────────────────────
// ONLY tokens with explicit $ prefix (or contract addresses).
// Greedy lookahead: "$Chibi Elon" → extracts "Chibi Elon" as one term.
// This is the ONLY source of unknown alpha identification.
function extractDollarTokens (text) {
  const found = []
  let m

  // Contract addresses (base58, 32–44 chars)
  const caPattern = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g
  while ((m = caPattern.exec(text)) !== null) {
    found.push({ term: m[1], type: 'address', confidence: 0.9 })
  }

  // $TICKER with greedy lookahead for spaced names
  const tickerPattern = /\$([A-Za-z][A-Za-z0-9]*)/g
  const words = text.split(/\s+/)

  while ((m = tickerPattern.exec(text)) !== null) {
    const base   = m[1]
    const pos    = text.indexOf('$' + base)
    const before = text.slice(0, pos).split(/\s+/).length - 1
    const w1 = words[before]?.replace(/^\$/, '') || ''
    const w2 = words[before + 1] || ''
    const w3 = words[before + 2] || ''

    const w2IsName = w2 && /^[A-Za-z][a-z]+$/.test(w2) && !w2.startsWith('$')
    const w3IsName = w3 && /^[A-Za-z][a-z]+$/.test(w3) && !w3.startsWith('$') && w2IsName

    if (w3IsName) {
      found.push({ term: (w1 + ' ' + w2 + ' ' + w3).trim(), type: 'dollar_ticker', confidence: 0.9 })
    } else if (w2IsName) {
      found.push({ term: (w1 + ' ' + w2).trim(), type: 'dollar_ticker', confidence: 0.9 })
    } else {
      found.push({ term: w1.trim(), type: 'dollar_ticker', confidence: 0.9 })
    }
  }

  return dedupTerms(found)
}

// ─── Find known alphas in text (no $ required) ───────────────────
// Matches ONLY against our verified known runner list.
// Single-word: symbol only, min 3 chars.
// Multi-word: symbol or name match.
// No false positives possible — every match is a verified runner.
function findKnownAlphasInText (text) {
  const found = []
  const lower = text.toLowerCase()
  const words = lower.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''))

  for (let i = 0; i < words.length; i++) {
    const w1 = words[i]
    const w2 = words[i + 1] || ''
    const w3 = words[i + 2] || ''

    // Try multi-word first (most specific)
    let matched = false
    for (const phrase of [
      (w1 + ' ' + w2 + ' ' + w3).trim(),
      (w1 + ' ' + w2).trim(),
      w1 + w2 + w3,
      w1 + w2,
    ]) {
      if (phrase.length < 4) continue
      if (knownAlphaSet.has(phrase)) {
        found.push({ term: phrase, type: 'known_match', confidence: 0.8 })
        matched = true
        break
      }
    }
    if (matched) continue

    // Single word — symbol only, min 3 chars
    // Short symbols safe now because BLOCKED_ALPHA_TERMS handles common words
    if (w1.length >= 3 && knownSymbolSet.has(w1)) {
      found.push({ term: w1, type: 'known_match', confidence: 0.75 })
    }
  }

  return dedupTerms(found)
}

// ─── Layer 3: AI inference (only when < 2 tokens found) ──────────
async function extractLayer3 (text) {
  const GROQ_KEY = process.env.GROQ_API_KEY
  if (!GROQ_KEY) return []

  const alphaList = knownAlphas.slice(0, 50).map(a => a.symbol).join(', ')
  const prompt = `Crypto Telegram message from Solana trading group:
"${text}"

Known running tokens: ${alphaList || 'unknown'}

Extract any crypto token tickers mentioned. Which is the alpha (running) and which are betas (derivatives)?
Tokens may lack $ prefix or be lowercase. Only return clearly mentioned tokens — no guessing.
Return JSON only: { "alpha": "SYMBOL or null", "betas": ["SYMBOL1"] }`

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body:    JSON.stringify({
        model: 'llama-3.1-8b-instant', max_tokens: 150, temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const data   = await res.json()
    const parsed = JSON.parse((data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim())
    const results = []
    if (parsed.alpha) results.push({ term: parsed.alpha, type: 'ai_extracted', confidence: 0.75 })
    for (const b of (parsed.betas || [])) results.push({ term: b, type: 'ai_extracted', confidence: 0.75 })
    return results
  } catch { return [] }
}

// ─── Dedup terms ──────────────────────────────────────────────────
function dedupTerms (terms) {
  const seen = new Set()
  return terms.filter(t => {
    const key = t.term.toLowerCase().replace(/\s+/g, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─── Terms that must never be treated as alphas ───────────────────
// Chain names, platform names, and generic crypto terms that happen
// to be token names but appear constantly in normal messages
const BLOCKED_ALPHA_TERMS = new Set([
  'solana', 'sol', 'ethereum', 'bitcoin', 'binance', 'coinbase',
  'pumpfun', 'raydium', 'jupiter', 'phantom', 'metamask',
  'yes', 'no', 'not', 'now', 'new', 'old', 'all', 'any',
])

// ─── Find alpha from extracted terms ─────────────────────────────
function findAlphaInTerms (terms) {
  for (const t of terms) {
    const lower = t.term.toLowerCase().replace(/\s+/g, '')
    if (BLOCKED_ALPHA_TERMS.has(lower)) continue  // never an alpha
    for (const alpha of knownAlphas) {
      const sym  = (alpha.symbol || '').toLowerCase()
      const name = (alpha.name   || '').toLowerCase().replace(/\s+/g, '')
      if (lower === sym || lower === name) return alpha
    }
  }
  return null
}

// ─── Extract core concept words ───────────────────────────────────
function extractCoreWords (term) {
  return term.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/[\s_]+/)
    .filter(w => w.length > 1 && !GENERIC_STRIP.has(w))
}

// ─── Group terms by concept ───────────────────────────────────────
function groupByConcept (terms) {
  const concepts = []
  for (const term of terms) {
    const coreWords = extractCoreWords(term)
    if (!coreWords.length) continue
    const existing = concepts.find(c =>
      c.coreWords.length === coreWords.length &&
      coreWords.every(w => c.coreWords.includes(w))
    )
    if (existing) existing.terms.push(term)
    else concepts.push({ coreWords, terms: [term] })
  }
  return concepts
}

// ─── DEX batch fetch ──────────────────────────────────────────────
async function fetchDEXBatch (addresses) {
  const results = []
  for (let i = 0; i < addresses.length; i += DEX_BATCH_SIZE) {
    try {
      const url = `https://api.dexscreener.com/tokens/v1/solana/${addresses.slice(i, i + DEX_BATCH_SIZE).join(',')}`
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (!res.ok) continue
      const data = await res.json()
      if (Array.isArray(data)) results.push(...data)
    } catch (err) { console.warn('[TelegramService] DEX batch error:', err.message) }
  }
  return results
}

// ─── DEX search ───────────────────────────────────────────────────
async function searchDEX (term) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return []
    return ((await res.json())?.pairs || []).filter(p => p.chainId === 'solana')
  } catch (err) { console.warn(`[TelegramService] DEX search error "${term}":`, err.message); return [] }
}

// ─── Quality filter ───────────────────────────────────────────────
function passesQualityFilter (pair) {
  const liq  = pair.liquidity?.usd || 0
  const mcap = pair.fdv || pair.marketCap || 0
  const txns = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)
  const age  = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : Infinity
  if (liq  < MIN_LIQUIDITY)                 return false
  if (age  < MIN_TOKEN_AGE_MS)              return false
  if (pair.info?.freezeAuthority)           return false
  if (pair.info?.mintAuthority)             return false
  if (txns < minTxnCount(mcap))             return false
  if (mcap > 1_000_000 && (pair.volume?.h24 || 0) < 100) return false
  return true
}

// ─── Momentum score ───────────────────────────────────────────────
function momentumScore (pair) {
  return (
    Math.min((pair.volume?.h1 || 0)                         / 50_000,  1) * 0.4 +
    Math.min(Math.max(pair.priceChange?.h1 || 0, 0)         / 100,     1) * 0.3 +
    Math.min((pair.liquidity?.usd || 0)                     / 100_000, 1) * 0.2 +
    Math.min(((pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0)) / 200, 1) * 0.1
  )
}

// ─── Select runner(s) per concept ────────────────────────────────
function selectRunner (pairs) {
  if (!pairs.length) return []
  const scored = pairs.filter(passesQualityFilter)
    .map(p => ({ pair: p, score: momentumScore(p) }))
    .sort((a, b) => b.score - a.score)
  if (!scored.length) return []
  const winner = scored[0]
  if (scored.length > 1) {
    const gap = winner.score > 0 ? (winner.score - scored[1].score) / winner.score : 1
    if (gap <= 0.10) return [
      { ...formatPair(winner.pair), tied: true },
      { ...formatPair(scored[1].pair), tied: true },
    ]
  }
  return [{ ...formatPair(winner.pair), tied: false }]
}

// ─── Format pair ──────────────────────────────────────────────────
function formatPair (pair) {
  return {
    address:     pair.baseToken?.address || '',
    symbol:      pair.baseToken?.symbol  || '',
    name:        pair.baseToken?.name    || '',
    priceUsd:    pair.priceUsd           || '0',
    liquidity:   pair.liquidity?.usd     || 0,
    volume24h:   pair.volume?.h24        || 0,
    priceChange: { h1: pair.priceChange?.h1 || 0, h24: pair.priceChange?.h24 || 0 },
    fdv:         pair.fdv                || 0,
    pairAddress: pair.pairAddress        || '',
    dexId:       pair.dexId              || '',
    url:         pair.url                || '',
  }
}

// ─── Store results ────────────────────────────────────────────────
async function storeBetaResults (alphaKey, alphaSymbol, pairs, channelHandle, confidence) {
  const runners = selectRunner(pairs)
  if (!runners.length) return
  const existing = betaCache.get(alphaKey) || { results: [], ts: Date.now() }
  if (existing.results.length >= MAX_BETAS_PER_ALPHA) return
  let stored = 0
  for (const runner of runners) {
    if (!runner.address) continue
    if (existing.results.length >= MAX_BETAS_PER_ALPHA) break
    if (existing.results.some(r => r.address === runner.address)) continue
    existing.results.push({ ...runner, alpha: alphaSymbol, signal: 'telegram_signal', channel: channelHandle, confidence, tied: runner.tied || false, ts: Date.now() })
    stored++
  }
  if (!stored) return
  existing.ts = Date.now()
  betaCache.set(alphaKey, existing)
  console.log(`[TelegramService] Stored ${stored} new beta(s) for ${alphaSymbol} from ${channelHandle} (total: ${existing.results.length})`)
}

// ─── Process beta terms for a known alpha ─────────────────────────
async function processBetaTerms (alpha, betaTerms, channelHandle, confidence) {
  const alphaKey = alpha.symbol.toLowerCase()
  for (const bt of betaTerms) {
    if (bt.type === 'address') {
      await storeBetaResults(alphaKey, alpha.symbol, await fetchDEXBatch([bt.term]), channelHandle, confidence)
      continue
    }
    const pairs = await searchDEX(bt.term)
    if (!pairs.length) continue
    const concepts = groupByConcept(pairs.map(p => p.baseToken?.name || p.baseToken?.symbol || ''))
    for (const concept of concepts) {
      const conceptPairs = pairs.filter(p => {
        const n = (p.baseToken?.name || '').toLowerCase()
        const s = (p.baseToken?.symbol || '').toLowerCase()
        return concept.coreWords.every(w => n.includes(w) || s.includes(w))
      })
      await storeBetaResults(alphaKey, alpha.symbol, conceptPairs, channelHandle, confidence)
    }
  }
}

// ─── Process a single message ─────────────────────────────────────
async function processMessage (text, channelHandle, channelWeight, msgTs) {
  if (!text || typeof text !== 'string') return
  if (Date.now() - msgTs > MESSAGE_MAX_AGE_MS) return
  if (HYPE_ONLY_PATTERNS.some(p => p.test(text.replace(/[^\w\s$]/g, '').trim()))) return

  // Step 1: Extract all $ tokens from message
  const dollarTokens = extractDollarTokens(text)

  // Step 2: Find known alphas mentioned without $ (already verified runners)
  const knownMatches = findKnownAlphasInText(text)

  // Merge — dollar tokens first
  let extracted = dedupTerms([...dollarTokens, ...knownMatches])

  // Step 3: AI fallback only if < 2 tokens found
  if (extracted.length < 2) {
    extracted = dedupTerms([...extracted, ...await extractLayer3(text)])
  }

  // Need at least 2 to proceed
  if (extracted.length < 2) return

  // Step 4: Identify alpha
  // Alpha must: have $ prefix in original text OR be in known alpha list
  // Known matches are already verified runners — no $ needed
  // Dollar tokens from unknown sources need to match known list to be alpha
  const alpha = findAlphaInTerms(extracted)

  const hasRelKw   = RELATIONSHIP_KEYWORDS.some(kw => new RegExp(kw, 'i').test(text))
  const confidence = channelWeight * (hasRelKw ? 0.85 : 0.70) + (hasRelKw ? 0.10 : 0)

  // Step 5: Beta candidates MUST have $ prefix or be a contract address
  // Known alpha list matching is for ALPHA identification only — not betas
  // This is the key rule: degens use $ when they mean a token intentionally
  // "if believe runs, $LOLZ is the play" → BELIEVE=alpha, $LOLZ=beta ✅
  // "if believe runs, fish may follow" → BELIEVE=alpha, fish rejected ✅
  // Layer 3 AI handles edge cases where neither token has $
  const betaTerms = extracted
    .filter(t => {
      // Only explicitly $ prefixed tokens or contract addresses as betas
      if (t.type !== 'dollar_ticker' && t.type !== 'address' && t.type !== 'ai_extracted') return false
      // Must not be the alpha
      if (!alpha) return true
      const lower = t.term.toLowerCase().replace(/\s+/g, '')
      return lower !== (alpha.symbol || '').toLowerCase() &&
             lower !== (alpha.name   || '').toLowerCase().replace(/\s+/g, '')
    })
    .slice(0, MAX_BETA_TERMS_MSG)

  if (!betaTerms.length) return

  if (!alpha) {
    // No alpha found — add to holding pool
    for (const bt of betaTerms) {
      holdingPool.push({ term: bt.term, type: bt.type, channel: channelHandle, confidence, ts: Date.now() })
    }
    const cutoff = Date.now() - HOLDING_POOL_TTL_MS
    while (holdingPool.length && holdingPool[0].ts < cutoff) holdingPool.shift()
    return
  }

  await processBetaTerms(alpha, betaTerms, channelHandle, confidence)
}

// ─── Check holding pool ───────────────────────────────────────────
async function checkHoldingPool () {
  if (!holdingPool.length || !knownAlphas.length) return
  const cutoff = Date.now() - HOLDING_POOL_TTL_MS
  const promoted = []
  const retained = []

  for (const item of holdingPool) {
    if (item.ts < cutoff) continue
    let matchedAlpha = null
    for (const alpha of knownAlphas) {
      const sym  = (alpha.symbol || '').toLowerCase()
      const term = item.term.toLowerCase().replace(/\s+/g, '')
      if (term === sym || term === (alpha.name || '').toLowerCase().replace(/\s+/g, '')) continue
      const alphaCore = extractCoreWords(alpha.symbol + ' ' + alpha.name)
      const termCore  = extractCoreWords(item.term)
      const overlap   = termCore.filter(w => alphaCore.includes(w))
      const termStartsWithSym = sym.length >= 4 && term.startsWith(sym)
      if (overlap.length >= 2 || (overlap.length >= 1 && termStartsWithSym)) {
        matchedAlpha = alpha; break
      }
    }
    if (matchedAlpha) promoted.push({ item, alpha: matchedAlpha })
    else retained.push(item)
  }

  holdingPool.length = 0
  holdingPool.push(...retained)

  for (const { item, alpha } of promoted) {
    console.log(`[TelegramService] Promoting held term "${item.term}" → alpha ${alpha.symbol}`)
    await processBetaTerms(alpha, [{ term: item.term, type: item.type }], item.channel, item.confidence)
  }
}

// ─── Poll a channel ───────────────────────────────────────────────
async function pollChannel (channel) {
  try {
    console.log(`[TelegramService] Polling @${channel.handle}`)
    const entity   = await telegramClient.getEntity(channel.handle)
    const cutoffTs = Date.now() - MESSAGE_MAX_AGE_MS
    const messages = await telegramClient.getMessages(entity, { limit: 100 })
    let processed  = 0
    for (const msg of messages) {
      const msgTs = (msg.date || 0) * 1000
      if (msgTs < cutoffTs) break
      const text = msg.message || msg.text || ''
      if (text) { await processMessage(text, channel.handle, channel.weight, msgTs); processed++ }
    }
    console.log(`[TelegramService] @${channel.handle} — processed ${processed} messages`)
  } catch (err) {
    console.warn(`[TelegramService] Error polling @${channel.handle}:`, err.message)
  }
}

// ─── Poll cycle ───────────────────────────────────────────────────
async function runPollCycle () {
  if (!isConnected) { console.warn('[TelegramService] Not connected — skipping'); return }
  console.log('[TelegramService] Starting poll cycle...')
  for (const channel of TELEGRAM_CHANNELS) {
    await pollChannel(channel)
    await new Promise(r => setTimeout(r, 2000))
  }
  await checkHoldingPool()
  const now = Date.now()
  for (const [k, v] of betaCache.entries()) { if (now - v.ts > CACHE_TTL_MS) betaCache.delete(k) }
  console.log('[TelegramService] Poll cycle complete.')
}

// ─── Init ─────────────────────────────────────────────────────────
async function init () {
  const API_ID      = parseInt(process.env.TELEGRAM_API_ID, 10)
  const API_HASH    = process.env.TELEGRAM_API_HASH
  const SESSION_STR = process.env.TELEGRAM_SESSION

  if (!API_ID || !API_HASH || !SESSION_STR) {
    console.warn('[TelegramService] Missing credentials in .env — Vector 10 disabled')
    return
  }

  try {
    telegramClient = new TelegramClient(
      new StringSession(SESSION_STR), API_ID, API_HASH,
      { connectionRetries: 5, useWSS: false }
    )
    await telegramClient.connect()
    isConnected = true
    console.log('[TelegramService] ✅ Connected to Telegram')
    console.log('[TelegramService] First poll in 30s (waiting for alpha list)...')
    setTimeout(async () => {
      await runPollCycle()
      pollTimer = setInterval(runPollCycle, POLL_INTERVAL_MS)
    }, 30_000)
  } catch (err) {
    console.error('[TelegramService] ❌ Failed to connect:', err.message)
    isConnected = false
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────
async function shutdown () {
  if (pollTimer) clearInterval(pollTimer)
  if (telegramClient && isConnected) { await telegramClient.disconnect(); console.log('[TelegramService] Disconnected') }
}

module.exports = { init, shutdown, getTelegramBetas, updateKnownAlphas }