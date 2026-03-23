// ─── BetaPlays — Telegram Service (Vector 10) ─────────────────────
// Social Signal Intelligence — finds beta tokens from Telegram channels
//
// Architecture:
//   - Fully decoupled from frontend scan — runs on 15-min background interval
//   - All DEX quality checks happen at poll time, never on request
//   - Frontend calls /api/telegram-betas?symbol=X → reads cache instantly
//   - Known alpha list fed via updateKnownAlphas() from /api/report-alphas
//
// 3-Layer Extraction:
//   L1: $TICKER pattern + greedy lookahead for spaced names
//   L2: Known alpha/token set matching (lowercase, no $ required)
//   L3: AI inference via Groq 8b (only when L1+L2 yield < 2 tokens)
//
// Per-concept Runner Selection:
//   momentumScore = (1hVol×0.4) + (1hChange%×0.3) + (liq×0.2) + (txnVelocity×0.1)
//   TIED: show 2 tokens if scores within 10% of each other
// ──────────────────────────────────────────────────────────────────

const path                       = require('path')
const { TelegramClient }         = require('telegram')
const { StringSession }          = require('telegram/sessions')
const { TELEGRAM_CHANNELS }      = require('./telegram_channels')

require('dotenv').config({ path: path.join(__dirname, '.env') })

// ─── Config ───────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 15 * 60 * 1000   // 15 minutes
const MESSAGE_MAX_AGE_MS  = 48 * 60 * 60 * 1000  // 48 hours
const CACHE_TTL_MS        = 30 * 60 * 1000   // 30 min result cache
const HOLDING_POOL_TTL_MS = 48 * 60 * 60 * 1000  // 48h holding pool
const DEX_BATCH_SIZE      = 30
const MIN_LIQUIDITY       = 2000
const MIN_TOKEN_AGE_MS    = 60 * 60 * 1000   // 1 hour
const MAX_TOP10_HOLDER_PCT = 80

// ─── Generic noise words stripped before concept core extraction ──
const GENERIC_STRIP = new Set([
  'inu', 'coin', 'token', '2.0', 'v2', 'v3', 'the', 'a', 'of',
  'on', 'solana', 'sol', 'meme', 'baby', 'mini', 'little', 'og',
  'official', 'real', 'based', 'ai', 'dao', 'fi', 'defi', 'nft',
])

// ─── Relationship keywords (boost confidence when present) ────────
const RELATIONSHIP_KEYWORDS = [
  'beta', 'beta play', 'sister', 'sister token', 'derivative',
  'related', 'follow', 'next', 'evil twin', 'twin', 'if.*runs',
  'when.*pumps', 'watch', 'baby', 'mini', 'spin.?off', 'echo',
]

// ─── Pure hype patterns — skip messages matching these with no tickers ─
const HYPE_ONLY_PATTERNS = [
  /^\s*[🚀💎🔥👀]+\s*$/,
  /^(wen|when|gm|gn|wagmi|ngmi|ser|fren|based|cope|rekt)\s*$/i,
  /^(buy|sell|hold|hodl|moon|pump|dump|rug|100x|1000x)\s*[🚀💎🔥👀]*\s*$/i,
]

// ─── Tiered txn count minimums (mirrors isActiveBeta) ─────────────
function minTxnCount(mcap) {
  if (mcap < 100_000)  return 3
  if (mcap < 1_000_000) return 8
  if (mcap < 10_000_000) return 15
  return 30
}

// ─── State ────────────────────────────────────────────────────────
let telegramClient  = null
let isConnected     = false
let pollTimer       = null
let knownAlphas     = []   // fed by /api/report-alphas from frontend
let knownAlphaSet   = new Set()  // symbol + name lookup (lowercase)

// Result cache: { [alphaSymbol_lower]: { results, ts } }
const betaCache = new Map()

// Holding pool: tokens seen with no alpha match yet
// { term, channel, confidence, ts }
const holdingPool = []

// ─── Update known alphas (called from index.js) ───────────────────
function updateKnownAlphas(alphas) {
  if (!Array.isArray(alphas)) return
  knownAlphas = alphas
  knownAlphaSet.clear()
  for (const a of alphas) {
    if (a.symbol) knownAlphaSet.add(a.symbol.toLowerCase())
    if (a.name)   knownAlphaSet.add(a.name.toLowerCase())
  }
}

// ─── Get cached betas for a symbol (endpoint handler) ────────────
function getTelegramBetas(symbol) {
  if (!symbol) return []
  const key    = symbol.toLowerCase()
  const cached = betaCache.get(key)
  if (!cached) return []
  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    betaCache.delete(key)
    return []
  }
  return cached.results
}

// ─── Layer 1: Pattern extraction ─────────────────────────────────
// Handles: $TICKER, $Spaced Name (greedy lookahead), bare UPPERCASE,
// and Solana contract addresses (base58 32-44 chars)
function extractLayer1(text) {
  const found = []

  // Contract addresses (base58, 32-44 chars, no spaces)
  const caPattern = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g
  let m
  while ((m = caPattern.exec(text)) !== null) {
    found.push({ term: m[1], type: 'address', confidence: 0.9 })
  }

  // $TICKER with greedy lookahead for spaced names
  // Matches $Word, $Word Word, $Word Word Word (up to 3 words)
  const tickerPattern = /\$([A-Za-z][A-Za-z0-9]*)/g
  const words = text.split(/\s+/)

  while ((m = tickerPattern.exec(text)) !== null) {
    const base  = m[1]
    const pos   = text.indexOf('$' + base)
    // Find word index in original split
    const before = text.slice(0, pos).split(/\s+/).length - 1
    const w1 = words[before]?.replace(/^\$/, '') || ''
    const w2 = words[before + 1] || ''
    const w3 = words[before + 2] || ''

    // Try 3-word, 2-word, 1-word — take longest that looks like a name
    const try3 = (w1 + ' ' + w2 + ' ' + w3).trim()
    const try2 = (w1 + ' ' + w2).trim()
    const try1 = w1.trim()

    // A "name" continuation: next word starts with uppercase or is all alpha
    const w2IsName = w2 && /^[A-Za-z][a-z]+$/.test(w2) && !w2.startsWith('$')
    const w3IsName = w3 && /^[A-Za-z][a-z]+$/.test(w3) && !w3.startsWith('$') && w2IsName

    if (w3IsName) {
      found.push({ term: try3, type: 'ticker_spaced', confidence: 0.85 })
    } else if (w2IsName) {
      found.push({ term: try2, type: 'ticker_spaced', confidence: 0.85 })
    } else {
      found.push({ term: try1, type: 'ticker', confidence: 0.85 })
    }
  }

  // Bare UPPERCASE (2-10 chars, not mid-sentence)
  const upperPattern = /(?<![A-Z])([A-Z]{2,10})(?![A-Z])/g
  while ((m = upperPattern.exec(text)) !== null) {
    const word = m[1]
    // Skip common non-ticker uppercase: URL fragments, common words
    if (['SOL', 'BTC', 'ETH', 'USD', 'USDC', 'USDT', 'NFT', 'DAO', 'DM', 'RT',
         'ATH', 'ATL', 'MC', 'FDV', 'TVL', 'LP', 'CA', 'TG', 'CT', 'DEX'].includes(word)) continue
    found.push({ term: word, type: 'bare_upper', confidence: 0.7 })
  }

  return dedupTerms(found)
}

// ─── Layer 2: Known alpha/token set matching ──────────────────────
// Scans 1, 2, 3-word phrases (lowercase) against known alpha list
// Handles: no $, lowercase, mixed case, spaced names
function extractLayer2(text) {
  const found  = []
  const lower  = text.toLowerCase()
  const words  = lower.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''))

  for (let i = 0; i < words.length; i++) {
    const w1 = words[i]
    const w2 = words[i + 1] || ''
    const w3 = words[i + 2] || ''

    const phrase1 = w1
    const phrase2 = (w1 + ' ' + w2).trim()
    const phrase3 = (w1 + ' ' + w2 + ' ' + w3).trim()
    const joined2 = w1 + w2
    const joined3 = w1 + w2 + w3

    for (const phrase of [phrase3, phrase2, joined3, joined2, phrase1]) {
      if (phrase.length < 2) continue
      if (knownAlphaSet.has(phrase)) {
        found.push({ term: phrase, type: 'known_match', confidence: 0.8 })
        break  // take longest match, don't double-count sub-phrases
      }
    }
  }

  return dedupTerms(found)
}

// ─── Layer 3: AI inference ────────────────────────────────────────
// Only called when L1+L2 yield < 2 distinct tokens
// Uses Groq 8b (cheapest, fastest) — extraction only, not scoring
async function extractLayer3(text) {
  const GROQ_KEY = process.env.GROQ_API_KEY
  if (!GROQ_KEY) return []

  const alphaList = knownAlphas.slice(0, 50).map(a => a.symbol).join(', ')

  const prompt = `You are a crypto token extractor. A Telegram message from a Solana trading group is shown below.

Known alpha tokens currently running: ${alphaList || 'unknown'}

Message: "${text}"

Task: Extract any crypto token names or tickers mentioned. Identify which is the alpha (the one running/pumping) and which are betas (derivatives/plays on the alpha).

Rules:
- Tokens may appear without $ prefix or in lowercase
- If you cannot identify an alpha, set alpha to null
- Only return tokens that are clearly mentioned — no guessing
- Return JSON only, no explanation

Return: { "alpha": "SYMBOL or null", "betas": ["SYMBOL1", "SYMBOL2"] }`

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model:       'llama-3.1-8b-instant',
        max_tokens:  200,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) return []
    const data  = await response.json()
    const raw   = data.choices?.[0]?.message?.content || ''
    const clean = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    const results = []
    if (parsed.alpha) results.push({ term: parsed.alpha, type: 'ai_extracted', confidence: 0.75 })
    for (const b of (parsed.betas || [])) {
      results.push({ term: b, type: 'ai_extracted', confidence: 0.75 })
    }
    return results
  } catch {
    return []
  }
}

// ─── Dedup extracted terms ────────────────────────────────────────
function dedupTerms(terms) {
  const seen = new Set()
  return terms.filter(t => {
    const key = t.term.toLowerCase().replace(/\s+/g, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─── Identify alpha from extracted terms ─────────────────────────
function findAlphaInTerms(terms) {
  for (const t of terms) {
    const lower = t.term.toLowerCase().replace(/\s+/g, '')
    for (const alpha of knownAlphas) {
      const sym  = (alpha.symbol || '').toLowerCase()
      const name = (alpha.name   || '').toLowerCase().replace(/\s+/g, '')
      if (lower === sym || lower === name) return alpha
    }
  }
  return null
}

// ─── Extract core concept words ───────────────────────────────────
function extractCoreWords(term) {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/[\s_]+/)
    .filter(w => w.length > 1 && !GENERIC_STRIP.has(w))
}

// ─── Group terms by concept ───────────────────────────────────────
// Two terms are same concept if they share ALL core words
function groupByConcept(terms) {
  const concepts = []

  for (const term of terms) {
    const coreWords = extractCoreWords(term)
    if (coreWords.length === 0) continue

    const existing = concepts.find(c =>
      c.coreWords.length === coreWords.length &&
      coreWords.every(w => c.coreWords.includes(w))
    )

    if (existing) {
      existing.terms.push(term)
    } else {
      concepts.push({ coreWords, terms: [term], conceptKey: coreWords.sort().join('_') })
    }
  }

  return concepts
}

// ─── DEX batch fetch ─────────────────────────────────────────────
async function fetchDEXBatch(addresses) {
  const results = []
  for (let i = 0; i < addresses.length; i += DEX_BATCH_SIZE) {
    const batch = addresses.slice(i, i + DEX_BATCH_SIZE)
    try {
      const url      = `https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(10000),
      })
      if (!response.ok) continue
      const data = await response.json()
      if (Array.isArray(data)) results.push(...data)
    } catch (err) {
      console.warn('[TelegramService] DEX batch fetch error:', err.message)
    }
  }
  return results
}

// ─── DEX search by keyword ────────────────────────────────────────
async function searchDEX(term) {
  try {
    const url      = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(10000),
    })
    if (!response.ok) return []
    const data  = await response.json()
    const pairs = data?.pairs || []
    // Filter to Solana only
    return pairs.filter(p => p.chainId === 'solana')
  } catch (err) {
    console.warn(`[TelegramService] DEX search error for "${term}":`, err.message)
    return []
  }
}

// ─── Quality filter ───────────────────────────────────────────────
function passesQualityFilter(pair) {
  const liq  = pair.liquidity?.usd   || 0
  const mcap = pair.fdv              || pair.marketCap || 0
  const txns = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)
  const age  = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : Infinity

  // Liquidity floor
  if (liq < MIN_LIQUIDITY) return false

  // Token age — must be at least 1 hour old
  if (age < MIN_TOKEN_AGE_MS) return false

  // Mint / freeze authority check
  if (pair.info?.freezeAuthority)  return false
  if (pair.info?.mintAuthority)    return false

  // Transaction count (tiered by mcap)
  if (txns < minTxnCount(mcap)) return false

  // Volume floor: if mcap > $1M but vol < $100 → dead
  const vol = pair.volume?.h24 || 0
  if (mcap > 1_000_000 && vol < 100) return false

  return true
}

// ─── Momentum score ───────────────────────────────────────────────
function momentumScore(pair) {
  const vol1h    = pair.volume?.h1    || 0
  const change1h = pair.priceChange?.h1 || 0
  const liq      = pair.liquidity?.usd  || 0
  const txns1h   = (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0)

  // Normalise each component to 0-1 scale (soft caps)
  const volNorm    = Math.min(vol1h    / 50_000, 1)
  const changeNorm = Math.min(Math.max(change1h, 0) / 100, 1)
  const liqNorm    = Math.min(liq      / 100_000, 1)
  const txnNorm    = Math.min(txns1h   / 200, 1)

  return (volNorm * 0.4) + (changeNorm * 0.3) + (liqNorm * 0.2) + (txnNorm * 0.1)
}

// ─── Select runner(s) from concept candidates ────────────────────
function selectRunner(pairs) {
  if (pairs.length === 0) return []

  const scored = pairs
    .filter(passesQualityFilter)
    .map(p => ({ pair: p, score: momentumScore(p) }))
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return []

  const winner = scored[0]

  // TIED: if #2 is within 10% of #1 → show both
  if (scored.length > 1) {
    const runnerUp = scored[1]
    const gap = winner.score > 0
      ? (winner.score - runnerUp.score) / winner.score
      : 1
    if (gap <= 0.10) {
      return [
        { ...formatPair(winner.pair), tied: true },
        { ...formatPair(runnerUp.pair), tied: true },
      ]
    }
  }

  return [{ ...formatPair(winner.pair), tied: false }]
}

// ─── Format pair for cache storage ───────────────────────────────
function formatPair(pair) {
  return {
    address:     pair.baseToken?.address || '',
    symbol:      pair.baseToken?.symbol  || '',
    name:        pair.baseToken?.name    || '',
    priceUsd:    pair.priceUsd           || '0',
    liquidity:   pair.liquidity?.usd     || 0,
    volume24h:   pair.volume?.h24        || 0,
    priceChange: {
      h1:  pair.priceChange?.h1  || 0,
      h24: pair.priceChange?.h24 || 0,
    },
    fdv:         pair.fdv               || 0,
    pairAddress: pair.pairAddress       || '',
    dexId:       pair.dexId             || '',
    url:         pair.url               || '',
  }
}

// ─── Process a single message ────────────────────────────────────
async function processMessage(text, channelHandle, channelWeight, msgTs) {
  if (!text || typeof text !== 'string') return

  // Age check
  if (Date.now() - msgTs > MESSAGE_MAX_AGE_MS) return

  // Pure hype check
  const stripped = text.replace(/[^\w\s$]/g, '').trim()
  if (HYPE_ONLY_PATTERNS.some(p => p.test(stripped))) return

  // ── 3-Layer extraction ────────────────────────────────────────
  let extracted = [
    ...extractLayer1(text),
    ...extractLayer2(text),
  ]
  extracted = dedupTerms(extracted)

  // Layer 3 only if we have < 2 tokens so far
  if (extracted.length < 2) {
    const l3 = await extractLayer3(text)
    extracted = dedupTerms([...extracted, ...l3])
  }

  // Need at least 2 token references
  if (extracted.length < 2) return

  // ── Identify alpha ────────────────────────────────────────────
  const alpha = findAlphaInTerms(extracted)

  // Relationship keyword present? → confidence boost
  const lowerText    = text.toLowerCase()
  const hasRelKw     = RELATIONSHIP_KEYWORDS.some(kw => new RegExp(kw, 'i').test(lowerText))
  const confBoost    = hasRelKw ? 0.10 : 0
  const baseConf     = channelWeight * (hasRelKw ? 0.85 : 0.70)

  // ── Identify beta terms (everything that isn't the alpha) ─────
  const betaTerms = extracted.filter(t => {
    if (!alpha) return true  // no alpha identified yet
    const lower = t.term.toLowerCase().replace(/\s+/g, '')
    const sym   = (alpha.symbol || '').toLowerCase()
    const name  = (alpha.name   || '').toLowerCase().replace(/\s+/g, '')
    return lower !== sym && lower !== name
  })

  if (betaTerms.length === 0) return

  if (!alpha) {
    // No alpha found — add to holding pool
    for (const bt of betaTerms) {
      holdingPool.push({
        term:       bt.term,
        type:       bt.type,
        channel:    channelHandle,
        confidence: baseConf + confBoost,
        ts:         Date.now(),
      })
    }
    // Prune expired holding pool entries
    const cutoff = Date.now() - HOLDING_POOL_TTL_MS
    while (holdingPool.length > 0 && holdingPool[0].ts < cutoff) holdingPool.shift()
    return
  }

  // ── We have alpha + beta terms → process now ──────────────────
  await processBetaTerms(alpha, betaTerms, channelHandle, baseConf + confBoost)
}

// ─── Process confirmed beta terms for a known alpha ───────────────
async function processBetaTerms(alpha, betaTerms, channelHandle, confidence) {
  const alphaKey = alpha.symbol.toLowerCase()

  for (const bt of betaTerms) {
    // Contract address → direct DEX fetch
    if (bt.type === 'address') {
      const pairs = await fetchDEXBatch([bt.term])
      await storeBetaResults(alphaKey, alpha.symbol, pairs, channelHandle, confidence)
      continue
    }

    // Text term → DEX search
    const pairs = await searchDEX(bt.term)
    if (pairs.length === 0) continue

    // Group by concept, select runner per concept
    const concepts = groupByConcept(pairs.map(p => p.baseToken?.name || p.baseToken?.symbol || ''))

    // For each concept, gather matching pairs and select runner
    for (const concept of concepts) {
      const conceptPairs = pairs.filter(p => {
        const tokenName = (p.baseToken?.name || '').toLowerCase()
        const tokenSym  = (p.baseToken?.symbol || '').toLowerCase()
        return concept.coreWords.every(w =>
          tokenName.includes(w) || tokenSym.includes(w)
        )
      })
      await storeBetaResults(alphaKey, alpha.symbol, conceptPairs, channelHandle, confidence)
    }
  }
}

// ─── Store runner selection results into cache ────────────────────
async function storeBetaResults(alphaKey, alphaSymbol, pairs, channelHandle, confidence) {
  const runners = selectRunner(pairs)
  if (runners.length === 0) return

  const existing = betaCache.get(alphaKey) || { results: [], ts: Date.now() }

  for (const runner of runners) {
    // Avoid duplicates by address
    const alreadyExists = existing.results.some(r => r.address === runner.address)
    if (alreadyExists) continue

    existing.results.push({
      ...runner,
      alpha:       alphaSymbol,
      signal:      'telegram_signal',
      channel:     channelHandle,
      confidence,
      tied:        runner.tied || false,
      ts:          Date.now(),
    })
  }

  existing.ts = Date.now()
  betaCache.set(alphaKey, existing)
  console.log(`[TelegramService] Stored ${runners.length} beta(s) for ${alphaSymbol} from ${channelHandle}`)
}

// ─── Check holding pool against newly updated alpha list ──────────
async function checkHoldingPool() {
  if (holdingPool.length === 0) return
  if (knownAlphas.length === 0) return

  const cutoff   = Date.now() - HOLDING_POOL_TTL_MS
  const promoted = []
  const retained = []

  for (const item of holdingPool) {
    // Expired → discard
    if (item.ts < cutoff) continue

    // Try to find a matching alpha now
    const fakeExtracted = [{ term: item.term, type: item.type, confidence: item.confidence }]

    // Re-run known set matching against the term
    let matchedAlpha = null
    for (const alpha of knownAlphas) {
      const sym  = (alpha.symbol || '').toLowerCase()
      const name = (alpha.name   || '').toLowerCase().replace(/\s+/g, '')
      const term = item.term.toLowerCase().replace(/\s+/g, '')
      // Check if the HELD TERM is a beta of a KNOWN ALPHA (not the alpha itself)
      if (term !== sym && term !== name) {
        // Check if the term is related to this alpha via core word overlap
        const alphaCore = extractCoreWords(alpha.symbol + ' ' + alpha.name)
        const termCore  = extractCoreWords(item.term)
        const overlap   = termCore.filter(w => alphaCore.includes(w))
        if (overlap.length > 0) {
          matchedAlpha = alpha
          break
        }
      }
    }

    if (matchedAlpha) {
      promoted.push({ item, alpha: matchedAlpha })
    } else {
      retained.push(item)
    }
  }

  // Clear pool and keep only unmatched, unexpired items
  holdingPool.length = 0
  holdingPool.push(...retained)

  // Process promoted items
  for (const { item, alpha } of promoted) {
    console.log(`[TelegramService] Promoting held term "${item.term}" → alpha ${alpha.symbol}`)
    const betaTerms = [{ term: item.term, type: item.type, confidence: item.confidence }]
    await processBetaTerms(alpha, betaTerms, item.channel, item.confidence)
  }
}

// ─── Poll a single channel ────────────────────────────────────────
async function pollChannel(channel) {
  try {
    console.log(`[TelegramService] Polling @${channel.handle}`)

    const entity   = await telegramClient.getEntity(channel.handle)
    const cutoffTs = Date.now() - MESSAGE_MAX_AGE_MS

    // Fetch recent messages (up to 100 per poll)
    const messages = await telegramClient.getMessages(entity, { limit: 100 })

    let processed = 0
    for (const msg of messages) {
      // gramjs timestamps are in seconds
      const msgTs = (msg.date || 0) * 1000
      if (msgTs < cutoffTs) break  // messages are chronological desc — stop early

      const text = msg.message || msg.text || ''
      if (!text) continue

      await processMessage(text, channel.handle, channel.weight, msgTs)
      processed++
    }

    console.log(`[TelegramService] @${channel.handle} — processed ${processed} messages`)
  } catch (err) {
    console.warn(`[TelegramService] Error polling @${channel.handle}:`, err.message)
  }
}

// ─── Main poll cycle ──────────────────────────────────────────────
async function runPollCycle() {
  if (!isConnected) {
    console.warn('[TelegramService] Not connected — skipping poll cycle')
    return
  }

  console.log('[TelegramService] Starting poll cycle...')

  for (const channel of TELEGRAM_CHANNELS) {
    await pollChannel(channel)
    // Small delay between channels to avoid flood
    await new Promise(r => setTimeout(r, 2000))
  }

  // After polling all channels, check holding pool
  await checkHoldingPool()

  // Prune expired cache entries
  const now = Date.now()
  for (const [key, val] of betaCache.entries()) {
    if (now - val.ts > CACHE_TTL_MS) betaCache.delete(key)
  }

  console.log('[TelegramService] Poll cycle complete.')
}

// ─── Initialise and start service ────────────────────────────────
async function init() {
  const API_ID      = parseInt(process.env.TELEGRAM_API_ID, 10)
  const API_HASH    = process.env.TELEGRAM_API_HASH
  const SESSION_STR = process.env.TELEGRAM_SESSION

  if (!API_ID || !API_HASH || !SESSION_STR) {
    console.warn('[TelegramService] Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION in .env — Vector 10 disabled')
    return
  }

  try {
    telegramClient = new TelegramClient(
      new StringSession(SESSION_STR),
      API_ID,
      API_HASH,
      {
        connectionRetries: 5,
        useWSS: false,
      }
    )

    await telegramClient.connect()
    isConnected = true
    console.log('[TelegramService] ✅ Connected to Telegram')

    // Run immediately on startup, then every 15 min
    await runPollCycle()
    pollTimer = setInterval(runPollCycle, POLL_INTERVAL_MS)

  } catch (err) {
    console.error('[TelegramService] ❌ Failed to connect:', err.message)
    isConnected = false
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────
async function shutdown() {
  if (pollTimer) clearInterval(pollTimer)
  if (telegramClient && isConnected) {
    await telegramClient.disconnect()
    console.log('[TelegramService] Disconnected')
  }
}

module.exports = {
  init,
  shutdown,
  getTelegramBetas,
  updateKnownAlphas,
}