import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import { getSearchTerms, getConcepts, generateTickerVariants, NARRATIVE_CATEGORIES, areCategoriesCompatible, inferCategoryFromTerms } from '../data/lore_map'
import classifyRelationships from './useAIBetaScoring'
import { compareLogos, shouldRunVision } from './useImageAnalysis'
import { hasNamingAnchor } from './useParentAlpha'


const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const BACKEND_URL      = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// ─── DEX Request Queue ─────────────────────────────────────────────
// Limits concurrent DEXScreener calls to max 4 inflight at once.
// All vectors share this queue — they fire simultaneously but the queue
// gates how many actually hit the API at the same time.
// Also deduplicates: identical URLs share one in-flight request.
// Cache TTL: 5 minutes — long enough to cover a full scan cycle.
const DEX_QUEUE = (() => {
  let running   = 0
  const MAX     = 4
  const waiting = []
  const cache   = new Map()   // url → Promise<response>
  const DELAY   = 250         // ms between requests leaving the queue

  const next = () => {
    if (waiting.length > 0 && running < MAX) waiting.shift()()
  }

  const get = async (url, options = {}) => {
    // Return cached promise if already in-flight or recently completed
    if (cache.has(url)) return cache.get(url)

    const req = (async () => {
      // Gate: wait if at capacity
      if (running >= MAX) {
        await new Promise(resolve => waiting.push(resolve))
      }
      running++
      try {
        const res = await axios.get(url, { ...options, timeout: options.timeout || 8000 })
        return res
      } finally {
        running--
        await new Promise(r => setTimeout(r, DELAY))
        next()
      }
    })()

    cache.set(url, req)
    // Auto-expire cache entry after 5 minutes
    req.then(() => setTimeout(() => cache.delete(url), 5 * 60 * 1000))
        .catch(() => cache.delete(url))  // Don't cache failures

    return req
  }

  return { get }
})()

// ─── Search term validator ─────────────────────────────────────────
// Prevents garbage queries that waste DEXScreener quota and trigger 400s.
// Rules:
//   - Must be at least 3 characters (DEX rejects shorter queries)
//   - Must not contain relationship operators (= < > : from lore map strings)
//   - Must not be a raw Solana address (44-char base58)
//   - Must not be a generic stop word that produces noise
// ─── Search term validator ────────────────────────────────────────
// Applied to ALL search terms before hitting DEX.
// Blocks structurally invalid inputs only — short terms, raw addresses,
// relationship operator strings. Does NOT block "coin", "digital", "green"
// etc. because those ARE valid token tickers.
//
// Visual attributes from Vector 0 (logo analysis) are handled separately —
// they go to the vision pipeline (compareLogos), NOT to DEX text search.
// That separation happens at the source (v0SearchTerms vs v0VisualTerms).
// Hard-blocked generic terms the AI occasionally emits despite prompt rules.
// These return thousands of unrelated tokens on DEX and pollute every beta list.
// Kept as a Set for O(1) lookup.
const BANNED_GENERIC_TERMS = new Set([
  // Chains / infrastructure
  'solana','sol','ethereum','eth','bitcoin','btc','blockchain','crypto','defi',
  'web3','nft','dao','dex','cex','swap','bridge','layer','mainnet','testnet',
  // Generic crypto vocab
  'token','coin','chain','contract','wallet','hodl','hold','buy','sell',
  'moon','pump','dump','rug','launch','fair','presale','airdrop','stake',
  'yield','farm','pool','liquidity','market','price','chart','volume',
  // Generic adjectives the AI loves
  'cute','cool','nice','good','bad','big','small','tiny','little','great',
  'best','first','new','old','real','based','pure','mega','ultra','super',
  'wild','dark','bright','funny','fun','happy','sad','angry','mad',
  // Generic nouns that match everything
  'animal','pet','friend','buddy','pal','mate','guy','dude','bro','sir',
  'king','queen','lord','master','hero','legend','god','devil','boss',
  'thing','stuff','item','object','entity','creature','being','life',
  // Single letters / non-words
  'the','and','for','with','from','into','onto','upon','over','under',
])

const isValidSearchTerm = (term) => {
  if (!term || typeof term !== 'string') return false
  const t = term.trim()
  // Use codepoint count (not .length) for the minimum length check.
  // JS .length counts UTF-16 code units: emoji like 🚀 = length 2, ⚡ = length 1.
  // But both are single meaningful characters that DEX indexes as valid tickers.
  // [...t].length counts actual Unicode codepoints — 🚀 = 1, "abc" = 3.
  // Rule: allow single emoji as-is; require ≥3 chars for plain text terms.
  const isEmoji = [...t].length === 1 && /\p{Emoji}/u.test(t)
  if (!isEmoji && t.length < 3) return false                // Too short for DEX (non-emoji)
  if (/[=<>:]/.test(t)) return false                        // Relationship operator string
  // Allow spaces for multi-word name searches ("shiba inu", "zero sum", "risk all")
  // but block more than 3 words — those are sentences, not token names
  if (/\s/.test(t) && t.split(/\s+/).length > 3) return false
  if (/^[1-9A-HJ-NP-Za-km-z]{40,}$/.test(t)) return false  // Raw Solana address
  // Pure numbers ARE valid — $420, $69, $11 are real tokens
  // Emoji bypass BANNED_GENERIC_TERMS — $🔥 is a real ticker, not a generic term
  if (!isEmoji && BANNED_GENERIC_TERMS.has(t.toLowerCase())) return false
  return true
}

// Normalise and expand search terms from the AI before sending to DEX.
//
// Token names and tickers are different things on DEXScreener:
//   Token name: "Shiba Inu", "Empty Hand", "Zero Sum"  (can have spaces)
//   Ticker/symbol: $SHIBA, $EMPTYHAND, $ZEROSUM        (no spaces, all caps)
// DEX searches BOTH name and symbol, so we need BOTH forms of a compound term
// to get full coverage.
//
// This function takes a single AI-generated term and returns 1 or 2 terms:
//   "EmptyHand"  → ["emptyhand", "empty hand"]  (ticker form + name form)
//   "RiskAll"    → ["riskall",   "risk all"]
//   "zerosum"    → ["zerosum",   "zero sum"]
//   "raccoon"    → ["raccoon"]                   (single word, no expansion needed)
//   "FART"       → ["FART"]                      (already a ticker, no expansion)
const normaliseSearchTerm = (term) => {
  if (!term || typeof term !== 'string') return [term]
  const t = term.trim()

  // Detect CamelCase: has lowercase→uppercase transition (EmptyHand, RiskAll)
  const isCamel = /[a-z][A-Z]/.test(t)
  // Detect run-together lowercase compound: no spaces, no caps, multiple syllables
  // heuristic: all-lowercase, no spaces, longer than 7 chars (emptyhand, zerosum)
  const isLowercaseCompound = /^[a-z]{8,}$/.test(t)

  if (isCamel) {
    // Split on uppercase boundaries: EmptyHand → ["Empty", "Hand"]
    const parts = t.replace(/([A-Z])/g, ' $1').trim().split(/\s+/)
    const spaced = parts.join(' ').toLowerCase()      // "empty hand" — finds by name
    const joined = parts.join('').toLowerCase()       // "emptyhand"  — finds by ticker
    return [...new Set([joined, spaced])]
  }

  if (isLowercaseCompound) {
    // Already joined lowercase (e.g. "riskall", "zerosum") — return as-is.
    // The AI prompt instructs it to also output the spaced form separately,
    // so this form will already have a companion "risk all" / "zero sum" entry.
    return [t]
  }

  // Already-spaced phrase ("risk all", "zero sum", "shiba inu") — pass through as-is.
  // DEX searches token names with spaces, so these are valid and useful.
  if (/\s/.test(t)) return [t.toLowerCase()]

  // Single word — return as-is
  return [t]
}

// Expand a list of AI terms into the full set of DEX search queries
// (each compound becomes two entries: ticker form + name form)
const expandSearchTerms = (terms) =>
  [...new Set(terms.flatMap(normaliseSearchTerm))].filter(isValidSearchTerm)

// ─── Vector 0: Fetch AI concept expansion from server ────────────
// Server caches per alpha address — shared across all users.
// Client detects re-entry via mcap growth and sends forceRefresh.
// skipVision: true skips the V0B image analysis — used by background
// warmup calls to avoid burning Gemini quota on tokens nobody is viewing.
const fetchAlphaExpansion = async (alpha, { skipVision = false } = {}) => {
  let forceRefresh = false
  try {
    const localCache = JSON.parse(localStorage.getItem('betaplays_v0_cache') || '{}')
    const prev = localCache[alpha.address]
    if (prev) {
      const mcapGrew = alpha.marketCap && prev.mcap && alpha.marketCap > prev.mcap * 1.5
      const stale    = Date.now() - prev.timestamp > 6 * 60 * 60 * 1000  // 6h local TTL
      forceRefresh   = mcapGrew || stale
      if (forceRefresh) console.log(`[Vector0] Force refresh for $${alpha.symbol} — ${mcapGrew ? 'mcap grew' : 'stale'}`)
    }
  } catch {}

  const res = await axios.post(`${BACKEND_URL}/api/expand-alpha`, {
    address:     alpha.address,
    symbol:      alpha.symbol,
    name:        alpha.name     || '',
    description: alpha.description || '',
    logoUrl:     alpha.logoUrl  || null,
    marketCap:   alpha.marketCap || 0,
    forceRefresh,
    skipVision,   // tells server to skip V0B image analysis (warmup calls)
  }, { timeout: 45000 })

  // If server returned a cached result but we suspect the prompt has been updated
  // (indicated by a PROMPT_VERSION mismatch), force a fresh expansion.
  // This prevents stale cached expansions from bleeding old terms after prompt fixes.
  const PROMPT_VERSION = 'v8'  // Bump this whenever the expansion prompt changes
  const data = res.data || {}
  if (data.fromCache && data.promptVersion && data.promptVersion !== PROMPT_VERSION) {
    console.log(`[Vector0] Prompt version mismatch for $${alpha.symbol} — forcing refresh`)
    const fresh = await axios.post(`${BACKEND_URL}/api/expand-alpha`, {
      address: alpha.address, symbol: alpha.symbol,
      name: alpha.name || '', description: alpha.description || '',
      logoUrl: alpha.logoUrl || null, marketCap: alpha.marketCap || 0,
      forceRefresh: true,
    }, { timeout: 45000 })
    return fresh.data || { searchTerms: [], visualTerms: [], relationshipHints: {} }
  }

  // Track locally for re-entry detection
  try {
    const localCache = JSON.parse(localStorage.getItem('betaplays_v0_cache') || '{}')
    localCache[alpha.address] = { timestamp: Date.now(), mcap: alpha.marketCap || 0 }
    localStorage.setItem('betaplays_v0_cache', JSON.stringify(localCache))
  } catch {}

  return res.data || { searchTerms: [], visualTerms: [], relationshipHints: {} }
}
const MIN_LIQUIDITY    = 1000   // Lowered from 5000 — small derivatives matter

// ─── Beta persistence ─────────────────────────────────────────────
// Betas disappear when they fall off DEXScreener search results.
// We persist them to localStorage keyed by alphaAddress so they
// survive page refresh and feed drops. Max 50 betas per alpha,
// max 7 days TTL. On load we merge stored + fresh, deduplicate,
// then update stored prices from fresh data where available.
const BETA_STORE_KEY = 'betaplays_betas_v2'
const BETA_TTL_MS    = 7 * 24 * 60 * 60 * 1000  // 7 days
const MAX_STORED     = 50

// Signals that are weak on their own and need AI corroboration to survive storage.
// 'lore' is included because lore alone (without AI) is easily triggered by
// common narrative words and produces false positives like $LOLA in $Whatif.
const WEAK_SOLO_SIGNALS = new Set(['keyword', 'morphology', 'description', 'lore'])

const loadStoredBetas = (alphaAddress) => {
  try {
    const store = JSON.parse(localStorage.getItem(BETA_STORE_KEY) || '{}')
    const bucket = store[alphaAddress] || []
    const now = Date.now()
    return bucket
      .filter(b => (now - (b.storedAt || 0)) < BETA_TTL_MS)
      // HARD FILTER on load: only return betas that were AI-confirmed or
      // structurally verified (lp_pair / og_match). This kills contaminated
      // data written by old scans before the lore/filter fixes were applied.
      // A stored beta with only weak signals and no AI score has no business
      // reappearing — it was a false positive that survived by luck.
      .filter(b => {
        const srcs = b.signalSources || []
        const isConfirmed =
          srcs.includes('ai_match')        ||
          srcs.includes('lp_pair')         ||
          srcs.includes('og_match')        ||
          srcs.includes('direct_derivative')
        if (!isConfirmed) {
          console.log(`[BetaStore] Dropped on load $${b.symbol} — no AI/structural confirmation | signals:[${srcs.join(',')}]`)
          return false
        }
        // Also drop stored betas that passed AI but with a score below the
        // current threshold — these were borderline passes from older, looser
        // prompt versions (e.g. $PISSTINA scoring 0.1 in an old scan).
        if (srcs.includes('ai_match') && b.aiScore != null && b.aiScore < 0.45) {
          console.log(`[BetaStore] Dropped on load $${b.symbol} — ai_match but score ${b.aiScore} below threshold`)
          return false
        }
        return true
      })
      .map(b => ({
        ...b,
        dexUrl: b.address
          ? `https://dexscreener.com/solana/${b.address}`
          : b.dexUrl,
      }))
  } catch { return [] }
}

const saveStoredBetas = (alphaAddress, betas) => {
  try {
    const store = JSON.parse(localStorage.getItem(BETA_STORE_KEY) || '{}')
    const now   = Date.now()
    store[alphaAddress] = betas
      .slice(0, MAX_STORED)
      .map(b => ({ ...b, storedAt: b.storedAt || now, isHistorical: true }))
    localStorage.setItem(BETA_STORE_KEY, JSON.stringify(store))
  } catch (err) {
    console.warn('[BetaStore] Save failed:', err.message)
  }
}

const mergeBetas = (fresh, stored) => {
  // Fresh data takes priority — update prices on stored betas when available
  const freshMap = new Map(fresh.map(b => [b.address, b]))
  const mergedMap = new Map()

  // Add all fresh betas first
  fresh.forEach(b => mergedMap.set(b.address, b))

  // Add stored betas not in fresh (they fell off the feed)
  stored.forEach(b => {
    if (!mergedMap.has(b.address)) {
      mergedMap.set(b.address, {
        ...b,
        isHistorical: true,
        coolingLabel: b.coolingLabel || 'Last seen ' + timeSince(b.storedAt),
      })
    }
  })

  return Array.from(mergedMap.values())
    .sort((a, b) => {
      // Fresh betas first, then by 24h change
      if (!a.isHistorical && b.isHistorical) return -1
      if (a.isHistorical && !b.isHistorical) return 1
      return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
    })
}

// ─── Beta price refresh ───────────────────────────────────────────
// PumpFun API returns bonding-curve mcap (~$36K) and priceChange24h: 0
// for ALL tokens. After a token graduates to PumpSwap/Raydium the
// PumpFun feed no longer has it — so stored prices freeze at bonding level.
//
// This runs after every fetch and hits DEXScreener's token endpoint for
// any beta whose data looks stale:
//   - priceChange24h === 0  (PumpFun placeholder — never real)
//   - pumpfun is the ONLY source (never confirmed by DEXScreener search)
//   - no fresh DEXScreener price seen yet (marketCap <= 80K safety window)
//
// Batches of 30 addresses per request — DEXScreener's token endpoint
// accepts comma-separated addresses and returns all pairs in one call.

const PRICE_REFRESH_BATCH = 30
const PRICE_REFRESH_TTL   = 5 * 60 * 1000  // 5 minutes — after this, stored prices are stale

const isStalePrice = (b) => {
  const sources = b.signalSources || []
  const onlyPumpFun      = sources.every(s => s === 'pumpfun')
  const zeroPriceChange  = parseFloat(b.priceChange24h) === 0
  const bondingMcap      = (b.marketCap || 0) <= 50_000

  // Time-based staleness — any stored beta not refreshed in last 5 min
  // gets a live price check. This is the main fix for frozen stored prices
  // like $Claw showing $73K while DEXScreener shows $18K.
  const lastRefresh      = b.priceRefreshedAt || b.storedAt || 0
  const priceIsOld       = (Date.now() - lastRefresh) > PRICE_REFRESH_TTL

  return onlyPumpFun || (zeroPriceChange && bondingMcap) || priceIsOld
}

const refreshBetaPrices = async (betas) => {
  const stale = betas.filter(b => isStalePrice(b) && b.address)
  if (!stale.length) return betas

  console.log(`[BetaRefresh] Refreshing prices for ${stale.length} stale betas...`)

  const updated = new Map()

  for (let i = 0; i < stale.length; i += PRICE_REFRESH_BATCH) {
    const batch   = stale.slice(i, i + PRICE_REFRESH_BATCH)
    const addrs   = batch.map(b => b.address).join(',')
    try {
      const res   = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${addrs}`
      )
      const pairs = res.data?.pairs || []

      // For each address, pick the highest-volume Solana pair as canonical price
      const bestPair = {}
      pairs
        .filter(p => p.chainId === 'solana')
        .forEach(p => {
          const addr = p.baseToken?.address
          if (!addr) return
          const prev = bestPair[addr]
          if (!prev || (p.volume?.h24 || 0) > (prev.volume?.h24 || 0)) {
            bestPair[addr] = p
          }
        })

      batch.forEach(b => {
        const pair = bestPair[b.address]
        if (!pair) return
        updated.set(b.address, {
          priceUsd:       pair.priceUsd         || b.priceUsd,
          priceChange24h: pair.priceChange?.h24 ?? b.priceChange24h,
          volume24h:      pair.volume?.h24      || b.volume24h,
          marketCap:      pair.marketCap || pair.fdv || b.marketCap,
          liquidity:      pair.liquidity?.usd   || b.liquidity,
          logoUrl:        pair.info?.imageUrl   || b.logoUrl,
          // Correct the dexUrl now that we know the active pair
          dexUrl:         `https://dexscreener.com/solana/${b.address}`,
          priceRefreshedAt: Date.now(),
        })
        console.log(`[BetaRefresh] ✅ $${b.symbol}: mcap $${b.marketCap?.toLocaleString()} → $${(pair.marketCap || pair.fdv || 0).toLocaleString()} | 24h: ${pair.priceChange?.h24 ?? 0}%`)
      })

      if (i + PRICE_REFRESH_BATCH < stale.length) {
        await new Promise(r => setTimeout(r, 500))
      }
    } catch (err) {
      console.warn(`[BetaRefresh] Batch failed (non-fatal):`, err.message)
    }
  }

  if (!updated.size) return betas

  // Merge fresh prices into the full beta list
  return betas.map(b =>
    updated.has(b.address) ? { ...b, ...updated.get(b.address) } : b
  )
}

const timeSince = (ts) => {
  if (!ts) return '?'
  const h = Math.floor((Date.now() - ts) / 3600000)
  if (h < 1) return '<1h ago'
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

// ─── Compound ticker decomposition ──────────────────────────────
const DECOMP_SUFFIXES = [
  'SCOPE', 'COIN', 'TOKEN', 'SWAP', 'PLAY', 'GAME', 'WORLD',
  'LAND', 'ZONE', 'CAT', 'DOG', 'HAT', 'WIF', 'INU', 'DAO',
  'MOON', 'PUMP', 'STAR', 'KING', 'LORD', 'APE', 'BOY', 'MAN',
  'GIRL', 'SON', 'ZEN', 'FI', 'PAD', 'NET', 'BIT', 'PAY',
  // Extended — catches $CUMIFY, $CUMRIO style affixes
  'IFY', 'FY', 'RIO', 'IO', 'LY', 'ER', 'EST', 'ISH',
  'STER', 'LING', 'ETTE', 'TION', 'NESS', 'MENT', 'ABLE',
  'FUN', 'GUY', 'LAD', 'BRO', 'SIS', 'MAX', 'PRO', 'XL',
]
const DECOMP_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
  'REAL', 'TURBO', 'CHAD', 'FAT', 'TINY', 'DARK', 'ULTRA',
  'MEAN', 'EVIL', 'BASED', 'LITTLE', 'BIG', 'GOOD',
  'BAD', 'MAD', 'WILD', 'HOLY', 'DEGEN', 'PURE',
]

// ─── Dictionary for compound ticker splitting ───────────────────
// When a ticker is two real words joined (GROKHOUSE, BABYPEPE, DOGWIF),
// we want to search for BOTH components. This dict contains high-value
// roots — terms specific enough to find narrative betas on DEX.
// Adding a word here doesn't remove anything — it's purely additive.
const COMPOUND_ROOTS = new Set([
  // Animals
  'DOG','CAT','FROG','BEAR','BULL','APE','BIRD','FISH','WOLF','FOX',
  'LION','TIGER','SNAKE','HORSE','PIG','COW','RAT','BAT','DUCK','OWL',
  'SHIBA','DOGE','PEPE','BONK','POPCAT',
  // AI / tech
  'GROK','GPT','AI','BOT','ROBOT','AGENT','MODEL','NEURAL','CHIP',
  'CLAUDE','CURSOR','DEVIN','VIBE',
  // Housing / shelter
  'HOUSE','HOME','CRIB','LODGE','CABIN','SHELTER','MANOR','FLAT',
  // People / roles
  'BOY','GIRL','MAN','WOMAN','KING','QUEEN','LORD','BABY','CHAD',
  'DEGEN','APE','CHAD','SIR','LAD','BRO','KID',
  // Places / worlds
  'WORLD','LAND','ZONE','CITY','TOWN','ISLAND','PLANET','MARS','MOON',
  // Concepts
  'DARK','LIGHT','GOOD','EVIL','WILD','FIRE','ICE','GOLD','STAR',
  'POWER','FORCE','MAGIC','LIFE','TIME','CHAOS','ORDER','WAR','PEACE',
  // Philosophy / duality / abstract
  'YIN','YANG','ZEN','TAO','KARMA','VOID','SOUL','MIND','FATE','DOOM',
  'HOPE','FEAR','LOVE','HATE','TRUTH','LIE','REAL','FAKE','PURE','NULL',
  'ZERO','HERO','NONE','SOME','ALL','ANY','FULL','EMPTY','HALF','WHOLE',
  // Colors (used in compound tokens like BLACKCAT, WHITEDOG)
  'BLACK','WHITE','RED','BLUE','PINK','GREY','GRAY',
  // Internet/culture
  'LOL','MEME','COPE','SEETHE','BASED','VIBES','PUNK','DEGEN',
  // Famous names commonly combined
  'TRUMP','ELON','MUSK','MARIO','SONIC','JOKER','BATMAN','PEPE','WOJAK',
])

const decomposeSymbol = (symbol) => {
  const s = symbol.toUpperCase()
  const parts = new Set()

  // ── CJK fast-path ──────────────────────────────────────────────
  // Chinese/Japanese/Korean symbols can't be decomposed by suffix stripping.
  // Return the whole symbol as the search root + 2-char substrings.
  const CJK_REGEX = /[　-鿿가-힯豈-﫿]/
  if (CJK_REGEX.test(symbol)) {
    parts.add(symbol)
    if (symbol.length >= 4) {
      for (let i = 0; i <= symbol.length - 2; i++) {
        const sub = symbol.slice(i, i + 2)
        if (CJK_REGEX.test(sub)) parts.add(sub)
      }
    }
    return Array.from(parts)
  }

  // ── Fallback stem extractor ────────────────────────────────────
  // When no suffix/prefix matches, strip 2-4 chars from end to find root.
  // e.g. CUMIFY → CUM, CUMRIO → CUM — they share the root and find each other.
  const tryFallbackStem = (sym) => {
    for (let stripLen = 2; stripLen <= 4; stripLen++) {
      const stem = sym.slice(0, sym.length - stripLen)
      if (stem.length >= 3) return stem
    }
    return null
  }

  DECOMP_SUFFIXES.forEach((suffix) => {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      const root = s.slice(0, s.length - suffix.length)
      if (root.length >= 3) { parts.add(root); parts.add(suffix) }
    }
  })

  DECOMP_PREFIXES.forEach((prefix) => {
    if (s.startsWith(prefix) && s.length > prefix.length + 2) {
      const root = s.slice(prefix.length)
      if (root.length >= 3) parts.add(root)
    }
  })

  // CamelCase split: AlienScope → ALIEN, SCOPE
  const camelParts = symbol
    .replace(/([A-Z][a-z]+)/g, ' $1')
    .replace(/([A-Z]+)(?=[A-Z][a-z])/g, ' $1')
    .trim().split(/\s+/)
    .filter(p => p.length >= 3)
  camelParts.forEach(p => parts.add(p.toUpperCase()))

  // ── Dictionary-based compound split ──────────────────────────
  // For all-caps tickers like GROKHOUSE, BABYPEPE, DOGWIF:
  // try every cut point and check if either half is a known root.
  // This is purely additive — existing decomposition runs first.
  if (s.length >= 6) {
    for (let i = 3; i <= s.length - 3; i++) {
      const left  = s.slice(0, i)
      const right = s.slice(i)
      if (
        (COMPOUND_ROOTS.has(left)  && right.length >= 3) ||
        (COMPOUND_ROOTS.has(right) && left.length  >= 3)
      ) {
        if (left.length  >= 3) parts.add(left.toLowerCase())
        if (right.length >= 3) parts.add(right.toLowerCase())
        console.log(`[Decompose] $${symbol} → "${left}" + "${right}"`)
      }
    }
  }

  // Fallback stem: if nothing found yet, strip 2-4 chars from end
  // This catches affixes not in our list (IFY, RIO, etc.)
  if (parts.size === 0) {
    const stem = tryFallbackStem(s)
    if (stem) parts.add(stem)
  }

  parts.delete(s)
  return Array.from(parts)
}

// ─── Name term extractor ─────────────────────────────────────────
// Extracts search terms from a token's full name when it differs from
// its symbol. Works for all languages — CJK, Latin, mixed.
// e.g. symbol=MOYU  name=摸鱼  → ['摸鱼']
//      symbol=WIF   name=Dog Wif Hat → ['dog', 'hat']  ('wif' already in symbol)
//      symbol=PEPE  name=Pepe → []  (same, skip)
const getNameTerms = (symbol, name) => {
  if (!name || name === 'Unknown') return []
  // If name matches symbol (case-insensitive), nothing new to add
  if (name.toLowerCase() === symbol.toLowerCase()) return []

  const CJK_REGEX = /[　-鿿가-힯豈-﫿]/

  // CJK name: return the full native name as a single search term
  // DEXScreener indexes CJK characters directly — one search is enough
  if (CJK_REGEX.test(name)) {
    const terms = [name]
    // Also extract any Latin words mixed in (e.g. "摸鱼 Moyu Fish")
    const latinWords = name
      .toLowerCase()
      .replace(/[^　-鿿a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && w.toLowerCase() !== symbol.toLowerCase())
    return [...new Set([...terms, ...latinWords])]
  }

  // Latin name: split into words, drop words already covered by symbol
  const symLower = symbol.toLowerCase()
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !w.includes(symLower) && !symLower.includes(w))
    .slice(0, 4)  // cap at 4 extra name-words — beyond this it's noise
}

// ─── Vector 1: Description keyword extraction ────────────────────
// Fetch the token's DEXScreener profile and extract meaningful
// keywords from its description text. This surfaces betas that
// share narrative universe without sharing ticker similarity.
// e.g. $AlienScope description: "alien surveillance files trump"
//      → search for alien, surveillance, trump → finds $ALIEN, $TRUMP etc

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
  'for', 'of', 'with', 'by', 'from', 'up', 'is', 'are', 'was',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our',
  'you', 'your', 'they', 'their', 'he', 'she', 'his', 'her',
  'not', 'no', 'so', 'if', 'as', 'all', 'any', 'can', 'just',
  'than', 'then', 'when', 'where', 'who', 'how', 'what', 'which',
  'about', 'into', 'through', 'token', 'coin', 'crypto', 'solana',
  'pump', 'moon', 'hold', 'buy', 'sell', 'trading', 'market',
  'price', 'chart', 'wallet', 'contract', 'launch', 'fair',
  // Chinese filler characters
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
  '都', '一', '上', '也', '很', '到', '说', '要', '去',
  '你', '会', '着', '看', '好', '自己', '这',
  // Japanese particles
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'か', 'な',
  // Korean particles
  '이', '가', '은', '는', '을', '를', '의', '에', '와', '과',
])

const extractDescriptionKeywords = (description, symbol = '', name = '') => {
  if (!description || description.length < 10) return []

  const CJK_REGEX = /[　-鿿가-힯豈-﫿]/
  const hasCJK = CJK_REGEX.test(description)

  if (hasCJK) {
    // CJK text: extract 2-4 char n-grams + any Latin words mixed in
    const cjkRuns = description.match(/[　-鿿가-힯豈-﫿]+/g) || []
    const latinWords = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    const cjkNgrams = []
    cjkRuns.forEach(run => {
      for (let len = 2; len <= 4 && len <= run.length; len++) {
        for (let i = 0; i <= run.length - len; i++) {
          cjkNgrams.push(run.slice(i, i + len))
        }
      }
      if (run.length >= 2 && run.length <= 6) cjkNgrams.push(run)
    })
    return [...new Set([...cjkNgrams, ...latinWords])]
      .filter(w => !STOP_WORDS.has(w))
      .sort((a, b) => b.length - a.length)
      .slice(0, 8)
  }

  // Latin path — frequency + identity ranked
  // Scoring: identity words (in symbol/name) get +6 bonus, always surface first.
  // Non-identity words rank by frequency in description (repeated = important),
  // with word length as a minor tiebreaker only.
  // This correctly surfaces short identity words like "beer", "dog", "ape"
  // over long generic words like "tokenomics", "community", "blockchain".
  const GENERIC_VERBS = new Set([
    'travel', 'travels', 'discover', 'discovers', 'discovering',
    'dance', 'dances', 'dancing', 'moves', 'move', 'moving',
    'world', 'places', 'place', 'friends', 'friend', 'across',
    'tiny', 'little', 'great', 'best',
  ])
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w =>
      w.length >= 3 &&
      w.length <= 20 &&
      !STOP_WORDS.has(w) &&
      !GENERIC_VERBS.has(w) &&
      !/^\d+$/.test(w)
    )
  const symWords  = symbol ? symbol.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean) : []
  const nameWords = name   ? name.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean) : []

  const descLower = description.toLowerCase()
  const scored = [...new Set(words)].map(w => {
    const isIdentity = symWords.includes(w) || nameWords.includes(w)
    const escaped    = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const freq       = (descLower.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length
    // Identity words always win. Frequent words beat rare long words.
    // Length is a minor tiebreaker only — not the primary signal.
    return { w, score: (isIdentity ? 6 : 0) + (freq * 1.5) + (w.length * 0.1) }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .map(x => x.w)
    .slice(0, 8)
}

// ─── V1b Description Noise Filter ────────────────────────────────
// Scoped ONLY to description keywords — never touches V0A terms.
// Removes marketing copy that passes extractDescriptionKeywords but
// has no anchor in the token's actual identity (symbol or name).
//
// Scoring:
//   symbol hit (exact word boundary) = 3pts
//   name hit   (exact word boundary) = 2pts
//   description-only                 = 1pt + 0.3/extra mention, cap 1.9
//
// A keyword only survives if its score ≥ 1.3pts OR its cluster total ≥ 3pts.
// This means a pure-description word needs to appear 2+ times to survive alone,
// OR appear alongside other related description words that together form a cluster.
//
// V0A terms bypass this entirely — they go straight to search.

const DESC_NOISE_TERMS = new Set([
  // Marketing/project copy
  'community','resilience','loyalty','driven','inspired','project','celebrates',
  'mission','vision','utility','governance','ecosystem','protocol','platform',
  'innovative','revolutionary','pioneering','official','exclusive','unique',
  // Generic crypto/finance
  'solana','sol','ethereum','eth','bitcoin','btc','coin','token','chain','web3',
  'defi','nft','dao','wallet','contract','launch','presale','airdrop','staking',
  // Generic descriptors
  'cute','cool','funny','happy','sad','good','bad','new','real','best','great',
])

// Semantic clusters for V1b — same logic as before but scoped to description only
const V1B_CLUSTER_MAP = {
  dog:    ['dog','doge','shiba','puppy','pup','doggo','hound','canine'],
  cat:    ['cat','kitten','meow','neko','kitty','feline','tabby'],
  frog:   ['frog','pepe','toad','kermit','ribbit'],
  bear:   ['bear','berenstain','grizzly','panda','teddy','ursus','honey','forest'],
  ape:    ['ape','monkey','gorilla','chimp','kong','primate','orangutan','bonobo'],
  wolf:   ['wolf','wolfpack','howl'],
  dragon: ['dragon','drago','drake','wyrm'],
  elon:   ['elon','musk','tesla','spacex'],
  trump:  ['trump','donald','maga','melania'],
  pepe:   ['pepe','wojak','chad','feels'],
  anime:  ['anime','manga','chibi','kawaii','otaku'],
  ai:     ['ai','gpt','llm','neural','agent','bot','grok','claude'],
  space:  ['space','mars','rocket','galaxy','alien','ufo','orbit'],
}

const V1B_TERM_TO_CLUSTER = new Map()
Object.entries(V1B_CLUSTER_MAP).forEach(([label, terms]) => {
  terms.forEach(t => { if (!V1B_TERM_TO_CLUSTER.has(t)) V1B_TERM_TO_CLUSTER.set(t, label) })
  if (!V1B_TERM_TO_CLUSTER.has(label)) V1B_TERM_TO_CLUSTER.set(label, label)
})

const scoreDescKeyword = (kw, symbol, name, description) => {
  const kwLower   = kw.toLowerCase()
  const symLower  = symbol.toLowerCase()
  const nameLower = (name || '').toLowerCase()
  const descLower = (description || '').toLowerCase()

  // Exact word boundary check — fixes the "redapes contains ape" substring bug
  const symWords  = symLower.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean)
  const nameWords = nameLower.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean)

  if (symWords.includes(kwLower))  return 3.0
  if (nameWords.includes(kwLower)) return 2.0

  // Keyword is component of symbol/name (e.g. "carrot" in "carrotjak")
  if (kwLower.length >= 4 && symLower.includes(kwLower))  return 2.5
  if (kwLower.length >= 4 && nameLower.includes(kwLower)) return 1.8

  // Capitalised proper noun in original description → name-level confidence
  // e.g. "Jotchua was tired..." — 'jotchua' keyword capitalised in source = 2.0
  const capitalisedInDesc = new RegExp(`\\b${kw[0].toUpperCase()}${kw.slice(1)}\\b`).test(description || '')
  if (capitalisedInDesc) return 2.0

  // Description-only: base 1pt + frequency bonus, cap 1.9
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches  = descLower.match(new RegExp(`\\b${escaped}\\b`, 'g'))
  const freq     = matches ? matches.length : 1
  return Math.min(1.0 + Math.max(0, freq - 1) * 0.3, 1.9)
}

const filterDescriptionKeywords = (rawKeywords, symbol, name, description) => {
  if (!rawKeywords || rawKeywords.length === 0) return rawKeywords

  // Strip obvious noise terms first
  const filtered = rawKeywords.filter(kw => !DESC_NOISE_TERMS.has(kw.toLowerCase()))

  // If everything was noise — return empty, let V0A terms carry the search
  // Do NOT fall back to raw keywords — that's exactly what we're trying to prevent
  if (filtered.length === 0) {
    console.log(`[V1bFilter] $${symbol} — all keywords were noise, returning empty (V0A takes over)`)
    return []
  }

  // Score each keyword
  const scored = filtered.map(kw => ({
    kw: kw.toLowerCase(),
    score: scoreDescKeyword(kw, symbol, name, description),
    cluster: V1B_TERM_TO_CLUSTER.get(kw.toLowerCase()) || kw.toLowerCase(),
  }))

  // Group into clusters and sum scores
  const clusterTotals = new Map()
  scored.forEach(({ cluster, score }) => {
    clusterTotals.set(cluster, (clusterTotals.get(cluster) || 0) + score)
  })

  // Keep keyword if: score ≥ 1.3, cluster ≥ 3.0, or keyword IS the ticker/name
  const symLowerF  = symbol.toLowerCase()
  const nameLowerF = (name || '').toLowerCase()
  const survivors = scored.filter(({ kw, score, cluster }) => {
    if (kw === symLowerF || kw === nameLowerF) return true
    if (symLowerF.includes(kw) && kw.length >= 4) return true
    if (nameLowerF.includes(kw) && kw.length >= 4) return true
    return score >= 1.3 || (clusterTotals.get(cluster) || 0) >= 3.0
  })

  // If nothing survived scoring — same logic: return empty, let V0A carry
  if (survivors.length === 0) {
    console.log(`[V1bFilter] $${symbol} — nothing passed score gate, returning empty (V0A takes over)`)
    return []
  }

  const result = [...new Set(survivors.map(s => s.kw))]
  const dropped = filtered.filter(kw => !result.includes(kw.toLowerCase()))
  if (dropped.length > 0) {
    console.log(`[V1bFilter] $${symbol} — dropped noise: [${dropped.join(', ')}]`)
  }
  return result
}

const fetchDescriptionKeywords = async (alpha) => {
  try {
    // ── Source 1: already on the alpha object (best case) ────────
    if (alpha.description && alpha.description.length > 10) {
      const raw      = extractDescriptionKeywords(alpha.description, alpha.symbol, alpha.name)
      const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', alpha.description)
      console.log(`[Vector1b] $${alpha.symbol} description (cached): "${alpha.description.slice(0, 60)}..."`)
      console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
      return { keywords, description: alpha.description }
    }

    // ── Source 2: DEX /tokens/{address} ──────────────────────────
    const res = await DEX_QUEUE.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${alpha.address}`
    )
    const pairs = res.data?.pairs || []
    const tokenDesc =
      pairs[0]?.info?.description ||
      pairs[0]?.baseToken?.description ||
      ''

    if (tokenDesc && tokenDesc.length > 10) {
      const raw      = extractDescriptionKeywords(tokenDesc, alpha.symbol, alpha.name)
      const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', tokenDesc)
      console.log(`[Vector1b] $${alpha.symbol} description (tokens endpoint): "${tokenDesc.slice(0, 60)}..."`)
      console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
      return { keywords, description: tokenDesc }
    }

    // ── Source 3: DEX /search?q={symbol} ─────────────────────────
    console.log(`[Vector1b] $${alpha.symbol} tokens endpoint empty — trying search fallback`)
    try {
      const searchRes = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(alpha.symbol)}`
      )
      const searchPairs = (searchRes.data?.pairs || [])
        .filter(p => p.chainId === 'solana' && p.baseToken?.address === alpha.address)
      const searchDesc =
        searchPairs[0]?.info?.description ||
        searchPairs[0]?.baseToken?.description ||
        ''

      if (searchDesc && searchDesc.length > 10) {
        const raw      = extractDescriptionKeywords(searchDesc, alpha.symbol, alpha.name)
        const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', searchDesc)
        console.log(`[Vector1b] $${alpha.symbol} description (search endpoint): "${searchDesc.slice(0, 60)}..."`)
        console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
        return { keywords, description: searchDesc }
      }
    } catch { /* silent — fall through to source 4 */ }

    // ── Source 4: DEX /search?q={address} ────────────────────────
    try {
      const addrRes = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/latest/dex/search?q=${alpha.address}`
      )
      const addrPairs = (addrRes.data?.pairs || [])
        .filter(p => p.chainId === 'solana')
      const addrDesc =
        addrPairs[0]?.info?.description ||
        addrPairs[0]?.baseToken?.description ||
        ''

      if (addrDesc && addrDesc.length > 10) {
        const raw      = extractDescriptionKeywords(addrDesc, alpha.symbol, alpha.name)
        const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', addrDesc)
        console.log(`[Vector1b] $${alpha.symbol} description (address search): "${addrDesc.slice(0, 60)}..."`)
        console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
        return { keywords, description: addrDesc }
      }
    } catch { /* silent */ }

    // ── Source 5: search by name (if different from symbol) ─────
    if (alpha.name && alpha.name.toLowerCase() !== alpha.symbol.toLowerCase()) {
      try {
        const nameRes = await DEX_QUEUE.get(
          `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(alpha.name)}`
        )
        const namePairs = (nameRes.data?.pairs || [])
          .filter(p => p.chainId === 'solana' && p.baseToken?.address === alpha.address)
        const nameDesc =
          namePairs[0]?.info?.description ||
          namePairs[0]?.baseToken?.description ||
          ''

        if (nameDesc && nameDesc.length > 10) {
          const raw      = extractDescriptionKeywords(nameDesc, alpha.symbol, alpha.name)
          const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', nameDesc)
          console.log(`[Vector1b] $${alpha.symbol} description (name search): "${nameDesc.slice(0, 60)}..."`)
          console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
          return { keywords, description: nameDesc }
        }
      } catch { /* silent */ }
    }

    // ── No description found — name fallback ──────────────────────
    const symbolDesc = alpha.name && alpha.name.toLowerCase() !== alpha.symbol.toLowerCase()
      ? alpha.name
      : ''
    if (symbolDesc) {
      const raw      = extractDescriptionKeywords(symbolDesc, alpha.symbol, alpha.name)
      const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', symbolDesc)
      console.log(`[Vector1b] $${alpha.symbol} — using name as description fallback: "${symbolDesc}"`)
      return { keywords, description: symbolDesc }
    }

    // ── Source 6: DEXScreener targeted profile lookup ─────────────
    // Targeted address lookup — more reliable than the rolling list.
    // Finds profiles regardless of when they were claimed.
    // MUST filter by tokenAddress — the endpoint may return profiles for
    // other tokens with the same symbol (e.g. a different $ROCKET).
    try {
      const profileRes = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1?tokenAddress=${alpha.address}`
      )
      const profiles = profileRes.data || []
      const profileDesc = Array.isArray(profiles)
        ? (profiles.find(p =>
            p.chainId === 'solana' &&
            p.tokenAddress === alpha.address
          )?.description || '')
        : (profileRes.data?.tokenAddress === alpha.address
            ? (profileRes.data?.description || '')
            : '')

      if (profileDesc && profileDesc.length > 10) {
        const raw      = extractDescriptionKeywords(profileDesc, alpha.symbol, alpha.name)
        const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', profileDesc)
        console.log(`[Vector1b] $${alpha.symbol} description (DEX profile targeted): "${profileDesc.slice(0, 60)}..."`)
        console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
        return { keywords, description: profileDesc }
      }
    } catch { /* silent */ }

    // ── Source 6b: DEXScreener rolling profiles (original fallback) ─
    try {
      const profileRes = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1`
      )
      const profiles = profileRes.data || []
      const match = Array.isArray(profiles)
        ? profiles.find(p =>
            p.chainId === 'solana' &&
            (p.tokenAddress === alpha.address ||
             p.header?.toLowerCase().includes(alpha.symbol.toLowerCase()))
          )
        : null

      const profileDesc = match?.description || ''
      if (profileDesc && profileDesc.length > 10) {
        const raw      = extractDescriptionKeywords(profileDesc, alpha.symbol, alpha.name)
        const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', profileDesc)
        console.log(`[Vector1b] $${alpha.symbol} description (DEX profiles rolling): "${profileDesc.slice(0, 60)}..."`)
        console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
        return { keywords, description: profileDesc }
      }
    } catch { /* silent */ }

    // ── Source 7: Birdeye token_overview ─────────────────────────
    // Birdeye maintains its own token metadata including descriptions.
    // Goes through backend proxy — BIRDEYE_API_KEY already configured.
    // Covers tokens that never claimed DEXScreener profile.
    try {
      const birdeyeRes = await fetch(
        `${BACKEND_URL}/api/birdeye?endpoint=token_overview&address=${alpha.address}`
      )
      if (birdeyeRes.ok) {
        const birdeyeData = await birdeyeRes.json()
        const birdeyeDesc = birdeyeData?.data?.extensions?.description ||
                            birdeyeData?.data?.description || ''
        if (birdeyeDesc && birdeyeDesc.length > 10) {
          const raw      = extractDescriptionKeywords(birdeyeDesc, alpha.symbol, alpha.name)
          const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', birdeyeDesc)
          console.log(`[Vector1b] $${alpha.symbol} description (Birdeye): "${birdeyeDesc.slice(0, 60)}..."`)
          console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
          return { keywords, description: birdeyeDesc }
        }
      }
    } catch { /* silent */ }

    // ── Source 8: PumpFun API (via backend proxy) ─────────────────
    // PumpFun blocks direct browser fetch (CORS) — goes through backend.
    // PumpFun-launched tokens store descriptions in their own API,
    // not DEXScreener or Birdeye. Most meme tokens ($Dunald, $ROCKET)
    // launch on PumpFun — "tired of wunning" lives here and nowhere else.
    try {
      const pumpRes = await fetch(
        `${BACKEND_URL}/api/pumpfun-metadata?address=${alpha.address}`
      )
      if (pumpRes.ok) {
        const pumpData = await pumpRes.json()
        const pumpDesc = pumpData?.description || ''
        if (pumpDesc && pumpDesc.length > 10) {
          const raw      = extractDescriptionKeywords(pumpDesc, alpha.symbol, alpha.name)
          const keywords = filterDescriptionKeywords(raw, alpha.symbol, alpha.name || '', pumpDesc)
          console.log(`[Vector1b] $${alpha.symbol} description (PumpFun): "${pumpDesc.slice(0, 60)}..."`)
          console.log(`[Vector1b] $${alpha.symbol} description keywords:`, keywords)
          return { keywords, description: pumpDesc }
        }
      }
    } catch { /* silent */ }

    console.log(`[Vector1b] $${alpha.symbol} — no description found across all sources`)
    return { keywords: [], description: '' }

  } catch (err) {
    console.warn('Description fetch failed:', err.message)
    return { keywords: [], description: '' }
  }
}

// ─── Vector 6: LP Pair Scraping ──────────────────────────────────
// The most explicit beta signal: a token paired directly against
// the alpha token (not SOL/USDC). If $HARVEY/$SHIRLEY pool exists,
// that's an undeniable relationship. No ambiguity, no scoring.

// Well-known base tokens that appear in almost every pool — not beta signals
const COMMON_BASE_TOKENS = new Set([
  'So11111111111111111111111111111111111111112',  // SOL (wrapped)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
])

const fetchLPPairBetas = async (alpha) => {
  if (!alpha.address) return []

  try {
    const res = await DEX_QUEUE.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${alpha.address}`
    )

    const pairs = res.data?.pairs || []

    return pairs
      .filter(p => {
        if (p.chainId !== 'solana') return false
        if ((p.liquidity?.usd || 0) < MIN_LIQUIDITY) return false
        if (!isHealthyBetaLiquidity(p)) return false

        const quoteAddr = p.quoteToken?.address || ''
        const baseAddr  = p.baseToken?.address  || ''
        const alphaAddr = alpha.address

        // Alpha must be one side of the pair
        const isDirectPair = quoteAddr === alphaAddr || baseAddr === alphaAddr
        if (!isDirectPair) return false

        // The OTHER token must not be the alpha itself
        const otherAddr = baseAddr === alphaAddr ? quoteAddr : baseAddr
        if (!otherAddr || otherAddr === alphaAddr) return false

        // The OTHER token must not be a common base currency (SOL, USDC, USDT etc)
        // A token paired with SOL is just a normal AMM pool — not a beta signal
        // We want: Alpha/Beta pairs, not Alpha/SOL pairs
        if (COMMON_BASE_TOKENS.has(otherAddr)) return false

        return true
      })
      .map(p => ({ pair: p, sources: ['lp_pair'] }))
  } catch (err) {
    console.warn('LP pair scraping failed:', err.message)
    return []
  }
}

// ─── Wave Phase (Vector 3) ───────────────────────────────────────
export const getWavePhase = (alpha, beta) => {
  const betaAge = beta?.pairCreatedAt ? Date.now() - beta.pairCreatedAt : null
  if (!betaAge) return { label: 'UNKNOWN', color: 'var(--text-muted)', tier: 0 }
  const betaHours = betaAge / 3600000
  if (betaHours < 6)   return { label: '🌊 WAVE',    color: 'var(--neon-green)',     tier: 3 }
  if (betaHours < 24)  return { label: '📈 2ND LEG', color: 'var(--amber)',          tier: 2 }
  if (betaHours < 168) return { label: '🕐 LATE',    color: 'var(--text-secondary)', tier: 1 }
  return                      { label: '🧊 COLD',    color: 'var(--text-muted)',     tier: 0 }
}

// ─── MCAP Ratio (Vector 4) ───────────────────────────────────────
export const getMcapRatio = (alphaMcap, betaMcap) => {
  if (!alphaMcap || !betaMcap || betaMcap === 0) return null
  return Math.round(alphaMcap / betaMcap)
}

// ─── OG / RIVAL / SPIN classifier ───────────────────────────────
const classifyTokens = (betas, alphaSymbol = '') => {
  const alphaUpper = alphaSymbol.toUpperCase()
  const groups = {}
  betas.forEach((b) => {
    const sym = b.symbol.toUpperCase()
    // Never group a beta whose symbol matches the alpha symbol itself —
    // those are og_match candidates, not PVP rivals of each other.
    // Also skip classification for betas that share a symbol but whose
    // ONLY signals are weak cross-alpha paths (keyword/lore/description alone).
    // Without at least one strong signal or 2+ signals, we can't confirm
    // they're competing for the same narrative as this alpha.
    const srcs = new Set(b.signalSources || [])
    const STRONG = new Set(['lp_pair','og_match','morphology','telegram_signal','desc_match','ai_match','visual_match'])
    const hasStrongSignal = [...srcs].some(s => STRONG.has(s))
    const hasConvergence  = [...srcs].filter(s => s !== 'sibling').length >= 2
    if (!hasStrongSignal && !hasConvergence) {
      // Weak solo signal — don't classify, just pass through
      return
    }
    if (!groups[sym]) groups[sym] = []
    groups[sym].push(b)
  })

  // Pass-through for unclassified (weak signal) betas
  const unclassified = betas.filter(b => {
    const srcs = new Set(b.signalSources || [])
    const STRONG = new Set(['lp_pair','og_match','morphology','telegram_signal','desc_match','ai_match','visual_match'])
    const hasStrongSignal = [...srcs].some(s => STRONG.has(s))
    const hasConvergence  = [...srcs].filter(s => s !== 'sibling').length >= 2
    return !hasStrongSignal && !hasConvergence
  }).map(b => ({ ...b, tokenClass: null }))

  const classified = []
  Object.values(groups).forEach((group) => {
    if (group.length === 1) { classified.push({ ...group[0], tokenClass: null }); return }
    const sorted = [...group].sort((a, b) => (a.pairCreatedAt || Infinity) - (b.pairCreatedAt || Infinity))
    const og = sorted[0]
    sorted.forEach((token, i) => {
      if (i === 0) { classified.push({ ...token, tokenClass: 'OG' }); return }
      const isRival =
        (token.marketCap || 0) >= (og.marketCap || 1) * 0.8 ||
        (token.volume24h || 0) > (og.volume24h || 1)
      classified.push({ ...token, tokenClass: isRival ? 'RIVAL' : 'SPIN' })
    })
  })
  return [...classified, ...unclassified]
}

// ─── Signal scoring ──────────────────────────────────────────────
export const getSignal = (beta) => {
  const s = beta.signalSources || []
  // LP pair is the strongest possible signal — direct pairing
  if (s.includes('lp_pair'))                                     return { label: 'MULTI',    tier: 6 }
  // AI + visual = highest text-based tier — two independent systems agree
  if (s.includes('ai_match')   && s.includes('visual_match'))    return { label: 'MULTI',    tier: 5 }
  // AI + any other signal = MULTI tier
  if (s.includes('ai_match')   && s.includes('keyword'))         return { label: 'MULTI',    tier: 5 }
  if (s.includes('ai_match')   && s.includes('morphology'))      return { label: 'MULTI',    tier: 5 }
  if (s.includes('ai_match')   && s.includes('og_match'))        return { label: 'MULTI',    tier: 5 }
  // Telegram/Twitter + any mechanical signal = MULTI tier
  if (s.includes('telegram_signal') && (s.includes('keyword') || s.includes('ai_match') || s.includes('morphology') || s.includes('og_match')))
                                                                  return { label: 'MULTI',    tier: 5 }
  if (s.includes('twitter_signal')  && (s.includes('keyword') || s.includes('ai_match') || s.includes('morphology') || s.includes('og_match')))
                                                                  return { label: 'MULTI',    tier: 5 }
  // Visual match alone = STRONG (image comparison, not just text)
  if (s.includes('visual_match'))                                 return { label: 'VISUAL',   tier: 3 }
  if (s.includes('pumpfun')    && s.includes('keyword'))         return { label: 'MULTI',    tier: 4 }
  if (s.includes('morphology') && s.includes('keyword'))         return { label: 'MULTI',    tier: 4 }
  if (s.includes('desc_match') && s.includes('keyword'))          return { label: 'MULTI',    tier: 5 }
  if (s.includes('desc_match') && s.includes('ai_match'))         return { label: 'MULTI',    tier: 5 }
  if (s.includes('desc_match') && s.includes('morphology'))       return { label: 'MULTI',    tier: 5 }
  if (s.includes('description')&& s.includes('keyword'))         return { label: 'MULTI',    tier: 4 }
  if (s.includes('desc_match'))                                   return { label: 'NAMED',    tier: 4 }
  if (s.includes('og_match'))                                    return { label: 'OG',       tier: 4 }
  if (s.includes('pumpfun'))                                     return { label: 'TRENDING', tier: 3 }
  // Social signals alone — their own tier
  if (s.includes('telegram_signal'))                             return { label: 'TELEGRAM', tier: 2.5 }
  if (s.includes('twitter_signal'))                              return { label: 'TWITTER',  tier: 2.5 }
  if (s.includes('ai_match'))                                    return { label: 'AI',       tier: 3 }
  if (s.includes('description'))                                 return { label: 'KEYWORD',  tier: 2 }
  if (s.includes('morphology'))                                  return { label: 'KEYWORD',  tier: 2 }
  if (s.includes('keyword'))                                     return { label: 'KEYWORD',  tier: 2 }
  if (s.includes('lore'))                                        return { label: 'LORE',     tier: 1 }
  return                                                                { label: 'WEAK',     tier: 0 }
}

// ─── Beta Ranking System ─────────────────────────────────────────
// Two dimensions: Signal Confidence × Relationship Strength
// Plus convergence bonus (multiple signals) and recency factor.
//
// Signal Tiers:
//   T5 = lp_pair (structural, on-chain proof)
//   T4 = morphology, keyword (creator consciously referenced alpha)
//   T3 = description, lore, ai_match ≥ 0.75 (strong contextual)
//   T2 = pumpfun, ai_match 0.45–0.74, sibling (weak/unverified)
//   T1 = fallback
//
// Relationship Tiers:
//   R4 = TWIN, EVIL_TWIN (direct derivative)
//   R3 = UNIVERSE, COUNTER (narrative family)
//   R2 = ECHO, SECTOR (narrative consequence)
//   R1 = SPIN, unclassified

const SIGNAL_TIER_MAP = {
  direct_derivative: 5,
  lp_pair:     5,
  og_match:    4,  // exact same ticker — highest non-structural signal
  morphology:  4,
  keyword:     4,
  desc_match:  4,  // beta's own description explicitly references alpha narrative
  description: 3,
  lore:        3,
  pumpfun:     2,
  sibling:     2,
}

const RELATIONSHIP_TIER_MAP = {
  TWIN:      4,
  EVIL_TWIN: 4,
  UNIVERSE:  3,
  COUNTER:   3,
  ECHO:      2,
  SECTOR:    2,
  SPIN:      1,
}

export const computeBetaRank = (beta) => {
  const sources = beta.signalSources || []

  // Signal tier: highest among all sources
  let signalTier = 1
  sources.forEach(s => {
    if (s === 'ai_match') {
      // ai_match tier depends on score quality
      const aiTier = (beta.aiScore || 0) >= 0.75 ? 3 : 2
      signalTier = Math.max(signalTier, aiTier)
    } else {
      signalTier = Math.max(signalTier, SIGNAL_TIER_MAP[s] || 1)
    }
  })

  // Relationship tier — default 1 (unclassified = SPIN-level)
  const relTier = RELATIONSHIP_TIER_MAP[beta.relationshipType] || 1

  // Convergence bonus: each extra unique signal source adds +0.5, max +1.5
  // Exclude 'sibling' — it's a meta-tag, not a detection signal
  const uniqueSources = new Set(sources.filter(s => s !== 'sibling')).size
  const convergenceBonus = Math.min((uniqueSources - 1) * 0.5, 1.5)

  // Recency factor: fresh betas (≤7 days) are more relevant
  const ageMs = beta.ageMs || (beta.pairCreatedAt ? Date.now() - beta.pairCreatedAt : null)
  const recencyFactor = ageMs && ageMs < 7 * 24 * 60 * 60 * 1000 ? 1.2 : 1.0

  const rank = signalTier * relTier * (1 + convergenceBonus) * recencyFactor
  return Math.round(rank * 10) / 10
}

// ─── Format pair → beta ──────────────────────────────────────────
const formatBeta = (pair, sources = []) => {
  const ageMs    = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null
  const ageDays  = ageMs ? Math.floor(ageMs / 86400000)                  : null
  const ageHours = ageMs ? Math.floor((ageMs % 86400000) / 3600000)      : null
  const ageLabel = ageDays > 0 ? `${ageDays}d` : ageHours > 0 ? `${ageHours}h` : ageMs !== null ? '<1h' : '—'
  return {
    id:             pair.pairAddress || pair.baseToken?.address,
    symbol:         pair.baseToken?.symbol || '???',
    name:           pair.baseToken?.name   || 'Unknown',
    address:        pair.baseToken?.address || '',
    pairAddress:    pair.pairAddress || '',
    priceUsd:       pair.priceUsd || '0',
    priceChange24h: pair.priceChange?.h24 || 0,
    volume24h:      pair.volume?.h24    || 0,
    marketCap:      pair.marketCap || pair.fdv || 0,
    liquidity:      pair.liquidity?.usd || 0,
    logoUrl:        pair.info?.imageUrl || null,
    pairCreatedAt:  pair.pairCreatedAt  || null,
    // ── Description: saved so Vector 8 has context ─────────────
    description:    pair.info?.description || pair.baseToken?.description || pair._description || '',
    ageLabel, ageMs,
    txns24h:        (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
    signalSources:  sources,
    tokenClass:     null,
    // Use TOKEN address not pair address — pairs change when pools migrate (PumpFun → PumpSwap etc)
    // Token address is permanent; DEXScreener always routes to the active pool
    dexUrl:         `https://dexscreener.com/solana/${pair.baseToken?.address || pair.pairAddress}`,
  }
}

// ─── Emoji + Number ticker expansion ─────────────────────────────
// When an alpha ticker is emoji or numeric, expand to searchable terms.
// DEX search handles emoji natively but also needs text equivalents.
const EMOJI_MAP = {
  '🐸': ['frog','pepe','kermit','toad'],
  '💀': ['skull','dead','death','rip'],
  '🚀': ['rocket','moon','launch','pump'],
  '🍀': ['clover','lucky','shamrock','luck'],
  '🐶': ['dog','doge','shiba','puppy'],
  '🐱': ['cat','kitten','meow','neko'],
  '🐻': ['bear','ursus','grizzly'],
  '🦊': ['fox','foxy','firefox'],
  '🐺': ['wolf','wolfpack','howl'],
  '🦁': ['lion','pride','roar'],
  '🐲': ['dragon','drago','drake'],
  '🔥': ['fire','flame','hot','blaze'],
  '💎': ['diamond','gem','jewel','crystal'],
  '⚡': ['lightning','thunder','bolt','zap'],
  '🌙': ['moon','luna','lunar','night'],
  '☀️': ['sun','solar','dawn','light'],
  '🌊': ['wave','ocean','sea','surf'],
  '💩': ['poop','shit','crap','turd'],
  '🤡': ['clown','joker','circus','honk'],
  '👽': ['alien','ufo','extraterrestrial'],
  '🧠': ['brain','mind','smart','think'],
  '❤️': ['heart','love','valentine'],
  '💸': ['money','cash','flying','rich'],
  '🎯': ['target','aim','bullseye'],
  '🏆': ['trophy','winner','champion'],
}

const MEME_NUMBERS = {
  '420': ['weed','cannabis','stoner','herb','blaze'],
  '69':  ['funny','nice','nsfw','dirty'],
  '11':  ['eleven','stranger','supernatural'],
  '100': ['perfect','based','full','complete'],
  '1000':['thousand','grand','1000x'],
  '777': ['lucky','jackpot','slot','sevens'],
  '666': ['devil','satan','evil','demon','beast'],
  '404': ['notfound','error','missing'],
  '42':  ['meaning','universe','hitchhiker','ultimate'],
  '88':  ['heil','speed','luck','infiniti'],
}

const expandTickerForSearch = (symbol) => {
  const extra = new Set()
  // Emoji expansion
  Object.entries(EMOJI_MAP).forEach(([emoji, terms]) => {
    if (symbol.includes(emoji)) terms.forEach(t => extra.add(t))
  })
  // Number expansion
  const numOnly = symbol.replace(/[^0-9]/g, '')
  if (numOnly && MEME_NUMBERS[numOnly]) {
    MEME_NUMBERS[numOnly].forEach(t => extra.add(t))
  }
  return [...extra]
}

// ─── Signal 9: Vector 9 — Bidirectional Description Match ──────
// Checks each beta candidate's OWN description for:
//   1. Explicit alpha symbol/name reference ("the dog version of $PIPPIN")
//   2. Keyword overlap with alpha's narrative keywords
//
// This is the only signal sourced from the BETA side — all other signals
// are sourced by searching for things related to the ALPHA.
// No API calls. No AI quota. Pure text matching.
//
// ⚠️ NOTE ON NUMBERING: Vector numbers are signal identities, not execution order.
// Actual execution order: 1 → 1b → 2 → 3 → 4 → 5 → 6 → sibling scan → 9 → 8
// Vector 9 runs BEFORE Vector 8 (AI) despite lower number — it pre-enriches
// candidates with desc_match so Vector 8 classifies with more confidence.
// Vector 8 runs last because it is the most expensive signal (AI quota).
//
// Returns: array of { address, matchType, matchedTerms }
// Generic words stripped before keyword overlap counting —
// these appear in almost every token description and carry no signal.
const DESC_GENERIC_WORDS = new Set([
  'sol','solana','meme','memecoin','coin','token','the','a','an','is','on',
  'of','to','and','in','for','with','this','that','are','was','has','have',
  'its','our','your','from','just','like','crypto','defi','web3','based',
])

const scoreDescriptionMatch = (betas, alphaSymbol, alphaName, alphaKeywords) => {
  if (!betas?.length) return []

  const alphaSymLow  = alphaSymbol.toLowerCase()
  const alphaNameLow = alphaName.toLowerCase()
  const dollarSymbol = `$${alphaSymLow}`

  // Strip generics from keyword list before overlap check
  const cleanKeywords = (alphaKeywords || [])
    .map(k => k.toLowerCase())
    .filter(k => k.length >= 5 && !DESC_GENERIC_WORDS.has(k))

  const matches = []
  betas.forEach(b => {
    const desc = (b.description || '').toLowerCase()
    if (!desc || desc.length < 10) return

    const matchedTerms = []

    // Check 1: explicit alpha symbol/name in description (strongest signal)
    // e.g. "the dog version of $PIPPIN" or "sister token to TRUMP"
    if (desc.includes(dollarSymbol)) {
      matchedTerms.push(dollarSymbol)
    } else if (alphaSymLow.length >= 3 && desc.includes(alphaSymLow)) {
      matchedTerms.push(alphaSymLow)
    } else if (alphaNameLow.length >= 4 && desc.includes(alphaNameLow)) {
      matchedTerms.push(alphaNameLow)
    }

    // Check 2: keyword overlap — 2+ specific (non-generic) alpha keywords in description
    const keywordHits = cleanKeywords.filter(k => desc.includes(k))
    if (keywordHits.length >= 2) {
      keywordHits.forEach(k => matchedTerms.push(k))
    }

    if (matchedTerms.length > 0) {
      const isExplicit = matchedTerms.some(t =>
        t === dollarSymbol ||
        t === alphaSymLow  ||
        t === alphaNameLow
      )
      matches.push({
        address:      b.address,
        matchType:    isExplicit ? 'explicit' : 'keyword_overlap',
        matchedTerms: [...new Set(matchedTerms)],
      })
    }
  })
  return matches
}

// ─── Signal 1: Keyword + compound decomposition ──────────────────
// ─── Signals V1 + V1b + V2: Unified DEX search ───────────────────
// Merges fetchKeywordBetas, fetchDescriptionBetas, fetchLoreBetas into one.
// Builds a single deduplicated term list tracking provenance per term.
// One DEX call per unique term — ~40% fewer calls vs three separate functions.
// Signal source diversity fully preserved: a term from both keyword and lore
// origins tags hits with sources:['keyword','lore'] — convergence bonus intact.
//
// Also incorporates V0B visual terms (direct + counter) as additional
// search signals with their own source tags.
const fetchDEXSearchBetas = async (alpha, descKeywords = [], extraTerms = [], visualTerms = [], visualCounters = [], onHit = null) => {
  const alphaSymbol = alpha.symbol
  const alphaName   = alpha.name || ''

  // term → Set<source> provenance map — each unique term tracks ALL origins
  const termSources = new Map()
  const addTerms = (terms, source) => {
    for (const t of terms) {
      if (!isValidSearchTerm(t)) continue
      if (!termSources.has(t)) termSources.set(t, new Set())
      termSources.get(t).add(source)
    }
  }

  // V1 keyword origins
  addTerms(getNameTerms(alphaSymbol, alphaName), 'keyword')
  addTerms(getSearchTerms(alphaSymbol),          'keyword')
  addTerms(decomposeSymbol(alphaSymbol),         'keyword')
  addTerms(expandTickerForSearch(alphaSymbol),   'keyword')
  addTerms(extraTerms,                           'keyword')

  // V1b description origins (cap at 4 unique terms)
  const descUnique = [...new Set(descKeywords)].filter(isValidSearchTerm).slice(0, 4)
  addTerms(descUnique, 'description')

  // V2 lore origins
  const symbolConcepts = getConcepts(alphaSymbol)
  const nameConcepts   = alphaName.toLowerCase() !== alphaSymbol.toLowerCase()
    ? getConcepts(alphaName) : []
  addTerms(symbolConcepts,                       'lore')
  addTerms(nameConcepts,                         'lore')
  addTerms(getNameTerms(alphaSymbol, alphaName), 'lore')
  addTerms(extraTerms,                           'lore')

  // V0B visual terms — proper nouns/animals/characters only (filter generic descriptors)
  // "panda", "trump", "shiba" → searchable | "red shirt", "blond hair" → skip
  const VISUAL_NOISE = /^(blond|dark|light|red|blue|green|black|white|hair|shirt|suit|hat|glasses|eyes|face|background|color|colour|big|small|cute|funny|cartoon|anime|style|expression|angry|happy|sad|stoic|evil|good|holding|wearing|standing|sitting|pointing)$/i
  const searchableVisual = visualTerms.filter(t => t.split(' ').length <= 2 && !VISUAL_NOISE.test(t.trim()))
  addTerms(searchableVisual, 'visual_term')

  // V0B visual counters (antonyms/opposites of what the logo depicts)
  const searchableCounters = visualCounters.filter(t => t.split(' ').length <= 2 && !VISUAL_NOISE.test(t.trim()))
  addTerms(searchableCounters, 'visual_counter')

  const uniqueTerms = Array.from(termSources.keys())
  console.log(`[V1+V1b+V2] $${alphaSymbol} unified search: ${uniqueTerms.length} unique terms (keyword+desc+lore${searchableVisual.length ? '+visual' : ''})`)
  console.log(`  [V1+V2] terms: [${uniqueTerms.slice(0,12).join(', ')}${uniqueTerms.length > 12 ? '...' : ''}]`)

  const results = []
  for (const term of uniqueTerms) {
    try {
      const res  = await DEX_QUEUE.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(term)}`)
      const srcs = Array.from(termSources.get(term))
      // V1 relevance filter: keyword/description terms must literally appear
      // in the beta's symbol or name. Lore, visual, and counter terms are
      // concept-based (not literal) — they bypass this check intentionally.
      const isLiteralSourceOnly = srcs.every(s => s === 'keyword' || s === 'description')
      const termLower = term.toLowerCase()

      const hits = (res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          isHealthyBetaLiquidity(p) &&
          isActiveBeta(p) &&
          p.baseToken?.address !== alpha.address &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol) &&
          (!isLiteralSourceOnly || (
            p.baseToken?.symbol?.toLowerCase().includes(termLower) ||
            p.baseToken?.name?.toLowerCase().includes(termLower)
          ))
        )
      if (hits.length > 0) {
        console.log(`  [V1+V2] "${term}" [${srcs.join('+')}] → ${hits.length} hits: [${hits.slice(0,5).map(p => '$'+p.baseToken?.symbol).join(', ')}${hits.length > 5 ? '...' : ''}]`)
        const newHits = hits.map(p => ({ pair: p, sources: srcs }))
        newHits.forEach(h => results.push(h))
        // Approach A: fire callback immediately so UI can show hits as they arrive
        if (onHit) onHit(newHits)
      }
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 3: Morphology engine ────────────────────────────────
// Runs ticker variant generation on BOTH the alpha symbol AND its key V0 terms.
// This catches meme-suffix derivatives like $RATWIF when $HANTA is the alpha:
//   $HANTA → V0 generates "rat" → morphology on "rat" → searches RATWIF, RATCAT, etc.
// Only the most distinctive V0 terms are used (not all 15-20) to avoid DEX spam.
const MEME_SUFFIXES = ['WIF', 'CAT', 'HAT', 'INU', 'MASK', 'PEPE', 'BABY', 'EVIL', 'DARK']
const buildCrossTermVariants = (v0Terms = []) => {
  // Take up to 5 most distinctive V0 terms (skip generic ones)
  const SKIP = new Set(['coin','token','sol','solana','crypto','meme','baby','evil','dark','the','a','of'])
  const distinctive = v0Terms
    .filter(t => t.length >= 3 && !SKIP.has(t.toLowerCase()))
    .slice(0, 5)
  const variants = []
  for (const term of distinctive) {
    for (const suffix of MEME_SUFFIXES) {
      const joined = `${term}${suffix}`.toLowerCase()
      if (joined.length >= 5 && isValidSearchTerm(joined)) variants.push(joined)
    }
  }
  return [...new Set(variants)]
}

const fetchMorphologyBetas = async (alphaSymbol, v0SearchTerms = []) => {
  const symbolVariants = generateTickerVariants(alphaSymbol)
    .filter(isValidSearchTerm)
  const crossTermVariants = buildCrossTermVariants(v0SearchTerms)
  const variants = [...new Set([...symbolVariants, ...crossTermVariants])]
  const results  = []
  // Instead of batched Promise.allSettled (which fires everything at once),
  // send variants through the shared DEX queue one at a time — the queue
  // controls concurrency globally across all vectors.
  for (const variant of variants.slice(0, 25)) {
    try {
      const res = await DEX_QUEUE.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(variant)}`)
      ;(res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          isHealthyBetaLiquidity(p) &&
          isActiveBeta(p) &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          p.baseToken?.symbol?.toUpperCase() === variant.toUpperCase() &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
        )
        .forEach(p => results.push({ pair: p, sources: ['morphology'] }))
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 3b: Exact-match OG scan ─────────────────────────────
// Searches for tokens with the EXACT same symbol as the alpha.
// Catches dormant OGs (low volume, low liquidity) that are invisible
// to normal search ranking but are the most obvious beta play:
// when a new token launches with the same ticker, traders pile into
// the OG expecting a sympathy pump — this is one of the most reliable
// patterns on Solana (PVP narrative arbitrage).
//
// Uses a much lower liquidity floor ($250) since OGs often go dormant
// after the original cycle but revive instantly when a new version launches.
// Results tagged 'og_match' — distinct from morphology (variants)
// so Vector 8 can classify them as TWIN or OG correctly.

const MIN_LIQUIDITY_OG = 250  // OGs go dormant — they won't have $1K+ liquidity

// ─── Beta liquidity health check ─────────────────────────────────
// Mirrors the dynamic ratio check in useParentAlpha.js but with
// slightly relaxed ratios — betas can be smaller/newer than parents.
//
// Tiers (minimum liq/mcap ratio):
//   < $100K   → 0.5%  (tiny beta, some liq still required)
//   $100K–$1M → 1.0%  (small beta, should have meaningful liq)
//   $1M–$10M  → 0.8%  (mid cap)
//   $10M–$100M→ 0.3%  (large cap)
//   > $100M   → 0.1%  (mega — $OO with $908M mcap / $3.6M liq = 0.4%, passes)
//
// Absolute floor: $500 liq — catches ghost tokens like $Pikachu ($6 liq)
// Note: $OO had $908M mcap / $3.6M liq = 0.4% which PASSES the $100M tier.
// We also check freezable flag from DEX to block scam tokens.
const getBetaMinLiqRatio = (mcap) => {
  // Relaxed mid/large cap ratios (Review 22 — mid-cap betas were being filtered out)
  if (mcap < 100_000)     return 0.005
  if (mcap < 1_000_000)   return 0.010
  if (mcap < 10_000_000)  return 0.005  // was 0.8%, now 0.5% — allows more mid-caps
  if (mcap < 100_000_000) return 0.002  // was 0.3%, now 0.2% — allows large-caps
  return 0.001
}

const isHealthyBetaLiquidity = (p) => {
  const liq  = p.liquidity?.usd || 0
  const mcap = p.marketCap || p.fdv || 0

  // Absolute floor — ghost tokens have < $500 liq
  if (liq < 500) return false

  // Freezable tokens are scam vectors — always reject
  if (p.info?.freezable === true) {
    console.log(`[BetaFilter] Rejected $${p.baseToken?.symbol} — token is freezable`)
    return false
  }

  // For tokens with no mcap data, just apply the absolute floor
  if (mcap === 0) return liq >= MIN_LIQUIDITY

  const minRatio = getBetaMinLiqRatio(mcap)
  const liqRatio = liq / mcap
  const passes   = liqRatio >= minRatio

  if (!passes) {
    console.log(
      `[BetaFilter] Rejected $${p.baseToken?.symbol} — ` +
      `liq $${Math.round(liq).toLocaleString()} / mcap $${Math.round(mcap).toLocaleString()} ` +
      `= ${(liqRatio * 100).toFixed(2)}% (need ${(minRatio * 100).toFixed(1)}%)`
    )
  }
  return passes
}

// ─── Beta transaction count + volume check ───────────────────────
// Catches fraudulent tokens with inflated mcap but zero real trading.
// $MAX: $118M mcap, 2 txns total, $3 volume — textbook ghost token.
// $00: $908M mcap, 7 txns, $2.6K volume — manipulated market.
//
// Tiered minimums scale with mcap — larger tokens should have more activity:
//   < $100K     →  3 txns  (tiny derivative, may be new)
//   $100K–$1M   →  8 txns  (should have some genuine trading)
//   $1M–$10M    → 15 txns  (active market expected)
//   > $10M      → 30 txns  (large cap = many traders)
//
// Also checks volume floor: mcap > $1M with < $100 volume = fake market.
// New tokens (< 2 hours old) bypass txn check — they haven't had time yet.
const isActiveBeta = (p) => {
  const mcap      = p.marketCap || p.fdv || 0
  const vol       = p.volume?.h24 || 0
  const txns      = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)
  const ageMs     = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : null
  const isNew     = ageMs !== null && ageMs < 2 * 60 * 60 * 1000  // < 2 hours old

  // Brand new tokens get a pass — they haven't had time to accumulate txns
  if (isNew) return true

  // Volume floor: > $1M mcap with < $100 volume in 24h = no real market
  if (mcap > 1_000_000 && vol < 100) {
    console.log(`[BetaFilter] Rejected $${p.baseToken?.symbol} — mcap $${Math.round(mcap).toLocaleString()} but only $${vol.toFixed(0)} volume`)
    return false
  }

  // Tiered transaction minimum
  // Relaxed mid/large cap floors (Review 22 — betas not only small-caps)
  // $1M–$10M: 15→10, >$10M: 30→20
  const getMinTxns = (mcap) => {
    if (mcap < 100_000)    return 3
    if (mcap < 1_000_000)  return 8
    if (mcap < 10_000_000) return 10
    return 20
  }

  const minTxns = getMinTxns(mcap)
  if (txns < minTxns) {
    console.log(
      `[BetaFilter] Rejected $${p.baseToken?.symbol} — ` +
      `only ${txns} txns in 24h (need ${minTxns} for $${Math.round(mcap).toLocaleString()} mcap)`
    )
    return false
  }

  return true
}

// ─── Dead beta detection ─────────────────────────────────────────
// Multi-signal approach: a token needs 3+ signals to be marked dead.
// Single signals are unreliable — a token can have low volume on a quiet
// day, or a low 24h change after a large prior move, without being dead.
// Convergence of multiple signals is the reliable dead indicator.
//
// Signals:
//   1. Severe 24h price drop (≤ -75%) — approximates dump from peak
//   2. Near-zero 24h volume (< $500) — no real trading activity
//   3. Stalled transactions (< 3 txns in 24h) — market completely inactive
//   4. Draining liquidity (< $1,000) — pool being pulled
//   5. Old + dormant (> 30 days AND < $5,000 vol) — abandoned token
//
// Returns: { isDead: boolean, signals: string[], signalCount: number }
// Callers can use signalCount for UI badges if needed.
//
// Does NOT replace isActiveBeta or isHealthyBetaLiquidity — those are
// entry gates. This is a post-filter for tokens that passed entry but
// have since decayed. Think of it as the difference between:
//   entry gate: "is this token tradeable right now?"
//   dead check:  "has this token stopped being tradeable since we found it?"
const isDeadBeta = (b) => {
  const signals    = []
  const change24h  = parseFloat(b.priceChange24h) || 0
  const vol24h     = b.volume24h  || 0
  const txns24h    = b.txns24h    || 0
  const liq        = b.liquidity  || 0
  const ageMs      = b.ageMs      || (b.pairCreatedAt ? Date.now() - b.pairCreatedAt : null)
  const ageDays    = ageMs ? ageMs / 86400000 : null

  if (change24h  <= -75)                             signals.push('dumped')
  if (vol24h     <  500)                             signals.push('no_volume')
  if (txns24h    <  3)                               signals.push('no_txns')
  if (liq        <  1000)                            signals.push('low_liq')
  if (ageDays    !== null && ageDays > 30 && vol24h < 5000) signals.push('abandoned')

  const isDead = signals.length >= 3
  if (isDead) {
    console.log(
      `[DeadFilter] ☠️  $${b.symbol} — dead (${signals.length}/5 signals: ${signals.join(', ')})`
    )
  }
  return { isDead, signals, signalCount: signals.length }
}

const fetchExactMatchOGs = async (alphaSymbol, alphaAddress) => {
  const results  = []
  const seen     = new Set()

  const addResult = (pair) => {
    const addr = pair.baseToken?.address
    if (!addr || addr === alphaAddress || seen.has(addr)) return
    if ((pair.liquidity?.usd || 0) < MIN_LIQUIDITY_OG) return
    if (['SOL','USDC','USDT'].includes(pair.baseToken?.symbol)) return
    if (pair.baseToken?.symbol?.toUpperCase() !== alphaSymbol.toUpperCase()) return
    seen.add(addr)
    results.push({ pair, sources: ['og_match'] })
  }

  // ── Pass 1: standard search ──────────────────────────────────
  if (isValidSearchTerm(alphaSymbol)) {
    try {
      const res = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(alphaSymbol)}`
      )
      ;(res.data?.pairs || [])
        .filter(p => p.chainId === 'solana')
        .forEach(p => addResult(p))
    } catch (err) {
      console.warn('[OGScan] Pass 1 failed:', err.message)
    }
  }

  // ── Pass 2: name-based search ────────────────────────────────
  const lcSymbol = alphaSymbol.toLowerCase()
  if (isValidSearchTerm(lcSymbol)) {
    try {
      const res = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(lcSymbol)}`
      )
      ;(res.data?.pairs || [])
        .filter(p => p.chainId === 'solana')
        .forEach(p => addResult(p))
    } catch { /* silent */ }
  }

  // ── Pass 3: recover known OG addresses from localStorage ─────
  try {
    const store  = JSON.parse(localStorage.getItem(BETA_STORE_KEY) || '{}')
    const stored = store[alphaAddress] || []
    const ogAddresses = stored
      .filter(b =>
        b.signalSources?.includes('og_match') &&
        b.address &&
        !seen.has(b.address)
      )
      .map(b => b.address)

    if (ogAddresses.length > 0) {
      const addrs = ogAddresses.join(',')
      const res = await DEX_QUEUE.get(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${addrs}`
      )
      ;(res.data?.pairs || [])
        .filter(p => p.chainId === 'solana')
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
        .forEach(p => addResult(p))
      console.log(`[OGScan] Pass 3 recovered ${ogAddresses.length} known OG address(es) from localStorage`)
    }
  } catch { /* silent */ }

  if (results.length > 0) {
    console.log(`[OGScan] Found ${results.length} exact-match OG(s) for $${alphaSymbol} across all passes`)
  }
  return results
}

// ─── Signal 4: PumpFun trending ──────────────────────────────────
const fetchPumpFunBetas = async (alphaSymbol, descKeywords = [], alphaName = '', extraTerms = []) => {
  const nameTerms  = getNameTerms(alphaSymbol, alphaName).map(t => t.toLowerCase())
  const concepts   = getConcepts(alphaSymbol)
  const decomposed = decomposeSymbol(alphaSymbol).map(d => d.toLowerCase())
  const aiTerms    = extraTerms.map(t => t.toLowerCase())
  // AI expansion terms included — catches betas by concept even without ticker similarity
  const allTerms   = [...new Set([...nameTerms, ...aiTerms, ...concepts, ...decomposed, ...descKeywords])]
  const results    = []

  try {
    // Scan 1: top 100 recent — via backend proxy to avoid CORS
    const res = await axios.get(
      `${BACKEND_URL}/api/pumpfun?path=coins&sort=last_trade_timestamp&order=DESC&limit=100&includeNsfw=false`,
      { timeout: 8000 }
    )
    ;(res.data || [])
      .filter(coin => {
        const hay = `${coin.name} ${coin.symbol} ${coin.description || ''}`.toLowerCase()
        return allTerms.some(t => hay.includes(t))
      })
      .slice(0, 15)
      .forEach(coin => results.push({
        pair: {
          pairAddress:  coin.mint,
          baseToken:    { symbol: coin.symbol, name: coin.name, address: coin.mint },
          priceUsd:     coin.usd_market_cap ? String(coin.usd_market_cap / (coin.total_supply || 1e9)) : '0',
          priceChange:  { h24: 0 },
          volume:       { h24: coin.volume || 0 },
          marketCap:    coin.usd_market_cap || 0,
          liquidity:    { usd: coin.virtual_sol_reserves ? coin.virtual_sol_reserves * 150 : 0 },
          info:         { imageUrl: coin.image_uri || null, description: coin.description || '' },
          url:          `https://pump.fun/${coin.mint}`,
          pairCreatedAt: coin.created_timestamp,
        },
        sources: ['pumpfun'],
      }))
  } catch (err) {
    console.warn('PumpFun fetch failed:', err.message)
  }

  // Scan 2: top 100 by market cap — catches graduated/mid-cap derivatives
  // that dropped out of the recent feed but are still active
  try {
    const res2 = await axios.get(
      `${BACKEND_URL}/api/pumpfun?path=coins&sort=market_cap&order=DESC&limit=100&includeNsfw=false`,
      { timeout: 8000 }
    )
    ;(res2.data || [])
      .filter(coin => {
        const hay = `${coin.name} ${coin.symbol} ${coin.description || ''}`.toLowerCase()
        return allTerms.some(t => hay.includes(t))
      })
      .slice(0, 10)
      .forEach(coin => results.push({
        pair: {
          pairAddress:  coin.mint,
          baseToken:    { symbol: coin.symbol, name: coin.name, address: coin.mint },
          priceUsd:     coin.usd_market_cap ? String(coin.usd_market_cap / (coin.total_supply || 1e9)) : '0',
          priceChange:  { h24: 0 },
          volume:       { h24: coin.volume || 0 },
          marketCap:    coin.usd_market_cap || 0,
          liquidity:    { usd: coin.virtual_sol_reserves ? coin.virtual_sol_reserves * 150 : 0 },
          info:         { imageUrl: coin.image_uri || null, description: coin.description || '' },
          url:          `https://pump.fun/${coin.mint}`,
          pairCreatedAt: coin.created_timestamp,
        },
        sources: ['pumpfun'],
      }))
  } catch (err) {
    console.warn('PumpFun mcap scan failed (non-fatal):', err.message)
  }

  return results
}

// ─── Vector 10: Telegram Social Signal ──────────────────────────
// Reads pre-computed cached results from the backend Telegram poller.
// Zero processing on request — backend already ran quality filters,
// concept grouping, and Runner selection during its 15-min poll cycle.
// Returns results in { pair, sources } format for mergeAndScore.
const fetchTelegramBetas = async (alphaSymbol) => {
  try {
    const url      = `${BACKEND_URL}/api/telegram-betas?symbol=${encodeURIComponent(alphaSymbol)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return []

    const data    = await response.json()
    const results = data?.results || []
    if (results.length === 0) return []

    console.log(`[V10/Telegram] $${alphaSymbol} — ${results.length} social signal beta(s)`)

    // Convert telegramService format → { pair, sources } for mergeAndScore
    return results.map(r => ({
      pair: {
        chainId:     'solana',
        pairAddress: r.pairAddress || r.address,
        dexId:       r.dexId       || '',
        url:         r.url         || '',
        baseToken: {
          address: r.address,
          symbol:  r.symbol,
          name:    r.name,
        },
        priceUsd:    r.priceUsd    || '0',
        liquidity:   { usd: r.liquidity || 0 },
        volume:      { h24: r.volume24h  || 0 },
        priceChange: {
          h1:  r.priceChange?.h1  || 0,
          h24: r.priceChange?.h24 || 0,
        },
        fdv:         r.fdv         || 0,
        // Pass tied flag through for badge rendering
        _telegramTied: r.tied      || false,
        _telegramChannel: r.channel || '',
        _telegramConfidence: r.confidence || 0.7,
      },
      sources: r.tied
        ? ['telegram_signal', 'telegram_tied']
        : ['telegram_signal'],
    }))
  } catch (err) {
    console.warn('[V10/Telegram] fetch failed (non-fatal):', err.message)
    return []
  }
}

// ─── Vector 11: Twitter/X Social Signal (STUB) ───────────────────
// Same interface as fetchTelegramBetas. Returns [] until backend
// twitterService is activated with credentials in .env.
// Wired into the parallel fetch — activates automatically when data flows.
const fetchTwitterBetas = async (alphaSymbol) => {
  try {
    const url      = `${BACKEND_URL}/api/twitter-betas?symbol=${encodeURIComponent(alphaSymbol)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return []

    const data    = await response.json()
    const results = data?.results || []
    if (results.length === 0) return []

    console.log(`[V11/Twitter] $${alphaSymbol} — ${results.length} social signal beta(s)`)

    // Same format conversion as fetchTelegramBetas
    return results.map(r => ({
      pair: {
        chainId:     'solana',
        pairAddress: r.pairAddress || r.address,
        dexId:       r.dexId       || '',
        url:         r.url         || '',
        baseToken: {
          address: r.address,
          symbol:  r.symbol,
          name:    r.name,
        },
        priceUsd:    r.priceUsd    || '0',
        liquidity:   { usd: r.liquidity || 0 },
        volume:      { h24: r.volume24h  || 0 },
        priceChange: {
          h1:  r.priceChange?.h1  || 0,
          h24: r.priceChange?.h24 || 0,
        },
        fdv: r.fdv || 0,
      },
      sources: r.tied
        ? ['twitter_signal', 'twitter_tied']
        : ['twitter_signal'],
    }))
  } catch (err) {
    console.warn('[V11/Twitter] fetch failed (non-fatal):', err.message)
    return []
  }
}

// ─── Merge + dedupe ──────────────────────────────────────────────
const mergeAndScore = (rawResults, alphaSymbol, alphaMcap) => {
  const seen = new Map()
  rawResults.forEach(({ pair, sources }) => {
    const key = pair.baseToken?.address || pair.pairAddress
    const sym = (pair.baseToken?.symbol || '').toUpperCase()
    if (!key || sym === alphaSymbol.toUpperCase()) return
    if (seen.has(key)) {
      seen.get(key).signalSources = [...new Set([...seen.get(key).signalSources, ...sources])]
    } else {
      seen.set(key, formatBeta(pair, sources))
    }
  })

  const deduped = Array.from(seen.values())
    .filter(b => !['SOL','USDC','USDT'].includes(b.symbol))

  // Second-pass dedup by token contract address (b.address).
  // mergeAndScore keys by pair.baseToken?.address || pair.pairAddress, so
  // the same token can enter twice if one result had it on baseToken.address
  // and another had it on pairAddress (different pool). classifyTokens then
  // assigns OG/RIVAL to both, and React throws duplicate key warnings.
  // This dedup keeps the highest-ranked entry for each contract address.
  const classified = classifyTokens(deduped, alphaSymbol)
    .map(b => ({ ...b, mcapRatio: getMcapRatio(alphaMcap, b.marketCap), betaRank: computeBetaRank(b) }))
    .sort((a, b) => {
      const aIsLP = a.signalSources?.includes('lp_pair') ? 1 : 0
      const bIsLP = b.signalSources?.includes('lp_pair') ? 1 : 0
      if (bIsLP !== aIsLP) return bIsLP - aIsLP
      return b.betaRank - a.betaRank
    })

  // Dedup by baseToken.address (contract address) — not pairAddress.
  // Same token on different pools (Raydium / PumpSwap / Jupiter route) should
  // collapse to one entry with merged signal sources.
  // Different tokens with same symbol ($WAR PVP) have different addresses → kept separate.
  const addrSeen = new Map()
  for (const b of classified) {
    const addr = b.address  // baseToken.address — permanent, pool-agnostic
    if (!addr) continue
    if (!addrSeen.has(addr)) {
      addrSeen.set(addr, b)
    } else {
      // Same contract, different pool — merge signal sources, keep higher rank
      const existing = addrSeen.get(addr)
      const mergedSources = [...new Set([...(existing.signalSources || []), ...(b.signalSources || [])])]
      if ((b.betaRank || 0) > (existing.betaRank || 0)) {
        addrSeen.set(addr, { ...b, signalSources: mergedSources })
      } else {
        addrSeen.set(addr, { ...existing, signalSources: mergedSources })
      }
    }
  }

  return Array.from(addrSeen.values()).slice(0, 30)
}

// ─── Main hook ───────────────────────────────────────────────────
// parentAlpha: if provided, also scans parent's namespace to find siblings
// Siblings are tagged as RIVAL so they appear in the beta list with correct signal
// ─── Free AI taste tracking ────────────────────────────────────────
// Free users get AI scoring for 2 alphas per day (UTC day reset).
// Using localStorage so the gate persists across tab refreshes — this
// also helps manage Groq quota by preventing unlimited AI calls per day.
const AI_GATE_KEY = 'bp_free_ai_v2'
const getFreeAiData = () => {
  try {
    const raw = localStorage.getItem(AI_GATE_KEY)
    if (!raw) return { count: 0, day: '' }
    return JSON.parse(raw)
  } catch { return { count: 0, day: '' } }
}
const todayUTC = () => new Date().toISOString().slice(0, 10) // 'YYYY-MM-DD'
const getFreeAiCount = () => {
  const data = getFreeAiData()
  if (data.day !== todayUTC()) return 0 // new day — quota reset
  return data.count
}
const bumpFreeAiCount = () => {
  const count = getFreeAiCount()
  localStorage.setItem(AI_GATE_KEY, JSON.stringify({ count: count + 1, day: todayUTC() }))
}

const useBetas = (alpha, parentAlpha = null, options = {}) => {
  const { metaSeedEnabled = true, isPro = false } = options
  const [betas,               setBetas]               = useState([])
  const [loading,             setLoading]             = useState(false)
  const [error,               setError]               = useState(null)
  const [scanPhase,           setScanPhase]           = useState(null)
  const [resolvedDescription, setResolvedDescription] = useState(null)
  // scanPhase: null | 'expanding' | 'searching' | 'scoring' | 'complete'
  // Race condition guard — each fetch gets a unique ID.
  // ── Alpha address signature system ───────────────────────────────
  // Every fetchBetas call is "signed" with the alpha address it was
  // started for (myAddress). Every setBetas call checks two things:
  //   1. fetchId — no newer fetch has started
  //   2. activeAlphaRef — the UI alpha hasn't changed since we started
  // If either check fails, the result is discarded silently.
  // This prevents Token A's betas from ever appearing in Token B's panel,
  // regardless of network speed, re-renders, or React batching order.
  const fetchIdRef      = useRef(0)
  const activeAlphaRef  = useRef(null)  // ground truth: what alpha the UI is showing RIGHT NOW
  const parentAlphaRef  = useRef(null)  // always-fresh parentAlpha — read inside fetchBetas without triggering re-run

  // Keep parentAlphaRef always fresh — updated every render
  // so fetchBetas reads current parentAlpha without it being a useCallback dep
  parentAlphaRef.current = parentAlpha

  // useEffect is the SOLE owner of activeAlphaRef.
  // It updates immediately on alpha change and clears the beta panel.
  useEffect(() => {
    const newAddress = alpha?.address || null
    if (activeAlphaRef.current !== newAddress) {
      activeAlphaRef.current = newAddress
      setBetas([])
      setScanPhase(null)
      setResolvedDescription(null)
      console.log(`[BetaPanel] Switched → ${newAddress ? `$${alpha.symbol}` : 'none'} — cleared`)
    }
  }, [alpha?.address])

  const fetchBetas = useCallback(async () => {
    if (!alpha?.address) { setBetas([]); return }

    const myFetchId = ++fetchIdRef.current
    const myAddress = alpha.address  // this fetch's address signature

    // Dual guard — stale if: newer fetch started OR active alpha changed
    const isStale = () =>
      fetchIdRef.current !== myFetchId ||
      activeAlphaRef.current !== myAddress

    // ── Preload parent map from Supabase ────────────────────────────
    // Pre-loaded once here and passed into sibling detection below.
    // Avoids multiple async calls inside the scan loop — one fetch,
    // shared across all sibling reads in this fetchBetas call.
    // Falls back to localStorage automatically inside loadParentMap.
    let cachedParentMap = {}
    try {
      const res = await fetch(`${BACKEND_URL}/api/parent-map`)
      if (res.ok) {
        const { map } = await res.json()
        if (map && Object.keys(map).length > 0) {
          // Merge with localStorage so locally-discovered parents aren't lost
          const local = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
          cachedParentMap = { ...local, ...map }
          localStorage.setItem('betaplays_parent_map', JSON.stringify(cachedParentMap))
          console.log(`[ParentMap] Pre-loaded ${Object.keys(map).length} parent relationship(s) from Supabase`)
        }
      }
    } catch {
      // Fall back to localStorage silently
      try { cachedParentMap = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}') } catch {}
    }

    // ── Preload stored betas for this address ─────────────────────
    // Two sources, Supabase-first:
    //   1. Supabase beta_relations — cross-device, shared across all users
    //   2. localStorage — fast session cache, falls back when Supabase unavailable
    //
    // Supabase is tried first. If it returns betas, show them immediately
    // while the fresh scan runs. localStorage fills the gap if Supabase
    // is cold or unavailable.
    let storedNow = []
    try {
      const res = await fetch(`${BACKEND_URL}/api/beta-history?address=${myAddress}`)
      if (res.ok) {
        const { betas: dbBetas } = await res.json()
        if (Array.isArray(dbBetas) && dbBetas.length > 0) {
          const shaped = dbBetas
            .filter(b => b.beta_address && b.beta_symbol)
            .map(b => ({
              address:          b.beta_address,
              symbol:           b.beta_symbol,
              name:             b.beta_name   || b.beta_symbol,
              logoUrl:          b.beta_logo   || null,
              signalSources:    Array.isArray(b.signals) ? b.signals : [],
              aiScore:          b.score       || null,
              relationshipType: b.relationship_type || null,
              marketCap:        b.beta_mcap_at_detection || 0,
              priceUsd:         b.beta_price_at_detection || null,
              isHistorical:     true,
              storedAt:         b.last_seen ? new Date(b.last_seen).getTime() : Date.now(),
              dexUrl:           `https://dexscreener.com/solana/${b.beta_address}`,
              coolingLabel:     'From database',
            }))
            .filter(b => {
              const srcs = b.signalSources
              return srcs.includes('ai_match') || srcs.includes('lp_pair') || srcs.includes('og_match')
            })
          if (shaped.length > 0) {
            storedNow = shaped
            if (!isStale()) {
              setBetas(shaped)
              // Keep localStorage in sync as session cache
              saveStoredBetas(myAddress, shaped)
              console.log(`[BetaStore] Loaded ${shaped.length} betas from Supabase for $${alpha.symbol}`)
            }
          }
        }
      }
    } catch { /* fall through to localStorage */ }

    // localStorage fallback — fires only if Supabase returned nothing
    if (storedNow.length === 0) {
      storedNow = loadStoredBetas(myAddress)
      if (storedNow.length > 0 && !isStale()) {
        setBetas(storedNow)
        console.log(`[BetaStore] Loaded ${storedNow.length} betas from localStorage (Supabase unavailable) for $${alpha.symbol}`)
      }
    }

    setLoading(true)
    setError(null)

    // Silently refresh stored prices in background while fresh fetch runs.
    // Both guards (fetchId + address) must pass before writing to screen.
    if (storedNow.length > 0) {
      const bgFetchId = myFetchId
      refreshBetaPrices(storedNow).then(refreshed => {
        if (fetchIdRef.current !== bgFetchId || activeAlphaRef.current !== myAddress) return
        saveStoredBetas(myAddress, refreshed)
        setBetas(prev => {
          const hasFreshData = prev.some(b => !b.isHistorical)
          return hasFreshData ? prev : refreshed
        })
      }).catch(() => {})
    }

    try {
      // Fetch description keywords first — feeds into multiple signals
      const { keywords: descKeywords, description: alphaDescription } =
        await fetchDescriptionKeywords(alpha)

      // Enrich alpha with description if we got a fresh one
      const enrichedAlpha = alphaDescription
        ? { ...alpha, description: alphaDescription }
        : alpha

      // Expose resolved description so useParentAlpha can use it
      if (alphaDescription) setResolvedDescription(alphaDescription)

      // ── Vector 0: AI concept expansion ───────────────────────────
      // Runs first — generates semantically targeted search terms.
      // Server caches per alpha, shared across all users.
      //
      // TWO separate outputs — used differently:
      //   searchTerms → DEX text search (narrative concepts: "pepe", "frog", "maga")
      //   visualTerms → vision logo comparison ONLY (image attributes: "green", "tuxedo")
      //
      // visualTerms must NEVER go to DEX text search — "green" or "cartoon"
      // returns thousands of unrelated tokens. They belong in the vision pipeline
      // where logos are compared image-to-image, not text-to-text.
      if (!isStale()) setScanPhase('expanding')
      let v0SearchTerms     = []   // → DEX search vectors (1, 1b, 2, 4)
      let v0VisualTerms     = []   // → vision comparison + filtered DEX search
      let v0VisualCounters  = []   // → visual antonyms/opposites for counter beta search
      let relationshipHints = {}
      let v0Category        = []   // AI-inferred categories array from V0A
      try {
        const expansion   = await fetchAlphaExpansion(enrichedAlpha)
        // Expand search terms — each CamelCase compound becomes two entries:
        // "EmptyHand" → ["emptyhand", "empty hand"] to find both tickers and named tokens.
        v0SearchTerms      = expandSearchTerms(expansion.searchTerms || [])
        v0VisualTerms      = expansion.visualTerms    || []
        v0VisualCounters   = expansion.visualCounters || []
        relationshipHints  = expansion.relationshipHints || {}
        v0Category         = expansion.categories || []  // AI-inferred categories array — drives seeding below
        console.log(
          `[Vector0] $${enrichedAlpha.symbol} → ${v0SearchTerms.length} search terms, ` +
          `${v0VisualTerms.length} visual terms (vision only)` +
          `${expansion.fromCache ? ' (cached)' : ''}`
        )
        if (v0SearchTerms.length) console.log(`  [V0] search: [${v0SearchTerms.join(', ')}]`)
        if (v0VisualTerms.length) console.log(`  [V0] visual (vision only): [${v0VisualTerms.join(', ')}]`)

        // ── V0 stale-cache fix ────────────────────────────────────
        // If server cache was built when description was empty, it returns
        // 0 search terms. Now that we have a resolved description, force
        // a fresh expansion so the description informs term generation.
        if (expansion.fromCache && v0SearchTerms.length === 0 && alphaDescription) {
          console.log(`[Vector0] Stale cache (0 terms, desc now available) — forcing re-expansion for $${enrichedAlpha.symbol}`)
          try {
            const freshExpansion = await axios.post(`${BACKEND_URL}/api/expand-alpha`, {
              address:      enrichedAlpha.address,
              symbol:       enrichedAlpha.symbol,
              name:         enrichedAlpha.name     || '',
              description:  alphaDescription,
              logoUrl:      enrichedAlpha.logoUrl  || null,
              marketCap:    enrichedAlpha.marketCap || 0,
              forceRefresh: true,
            }, { timeout: 45000 })
            const freshData = freshExpansion.data || {}
            v0SearchTerms     = expandSearchTerms(freshData.searchTerms || [])
            v0VisualTerms     = freshData.visualTerms    || []
            v0VisualCounters  = freshData.visualCounters || []
            relationshipHints = freshData.relationshipHints || {}
            v0Category        = freshData.categories || []
            console.log(`[Vector0] Re-expansion done → ${v0SearchTerms.length} search terms`)
          } catch (reErr) {
            console.warn('[Vector0] Re-expansion failed (non-fatal):', reErr.message)
          }
        }
      } catch (v0Err) {
        console.warn('[Vector0] Expansion failed (non-fatal — continuing without):', v0Err.message)
      }

      // ── Category-aware search seeding ────────────────────────────
      // GUARDRAILS (tightened):
      //
      // CategorySeeds: only fires when the alpha's own symbol or name
      //   DIRECTLY contains the category trigger — not via decomposition
      //   of sub-words or thematic compatibility inference.
      //   Cap: 3 seeds max when AI unavailable, 6 when AI available.
      //   Emoji sibling search: only fires when alpha symbol contains
      //   an actual emoji character (not inferred from category).
      //
      // MetaSeed: disabled entirely when AI is unavailable.
      //   It injects terms from a different narrative — without AI scoring
      //   the results, those hits have no filter and pollute the list.
      //
      // canRunAI is computed before the search phase — clean gate.

      // Determine AI availability BEFORE seeding so MetaSeed can check it
      const canRunAI = isPro || getFreeAiCount() < 2

      let categorySeeds = []

      // ── EMOJI_CONCEPT_MAP ─────────────────────────────────────────
      // Used ONLY for emoji-ticker alphas (symbol contains actual emoji char).
      // Not used for category inference — anchored to alpha identity only.
      const EMOJI_CONCEPT_MAP = {
        rocket:    { emoji: '🚀', related: ['moon','launch','blast','orbit','nasa','mars','space'], siblingEmojis: ['🌙','🔥','💀','⚡','👽'] },
        skull:     { emoji: '💀', related: ['dead','death','rip','ghost','bones','dark'],           siblingEmojis: ['🔥','💀','⚡','🌙','💩'] },
        frog:      { emoji: '🐸', related: ['pepe','toad','kermit','ribbit'],                       siblingEmojis: ['🐸','🐶','🐱','🐻','🦊'] },
        fire:      { emoji: '🔥', related: ['flame','blaze','burn','hot','inferno'],                siblingEmojis: ['💀','⚡','🚀','🌙','💎'] },
        dog:       { emoji: '🐶', related: ['doge','shiba','puppy','woof','bonk'],                  siblingEmojis: ['🐸','🐱','🐻','🦊','🐺'] },
        cat:       { emoji: '🐱', related: ['meow','neko','kitty','pepe'],                          siblingEmojis: ['🐶','🐸','🐻','🦊','🐺'] },
        diamond:   { emoji: '💎', related: ['gem','jewel','crystal','rare','based'],                siblingEmojis: ['💎','💸','🏆','🔥','⚡'] },
        lightning: { emoji: '⚡', related: ['thunder','bolt','zap','fast','electric'],              siblingEmojis: ['🔥','💀','🚀','⚡','🌙'] },
        moon:      { emoji: '🌙', related: ['luna','lunar','night','dark','space'],                 siblingEmojis: ['🚀','⚡','💀','👽','🌙'] },
        clover:    { emoji: '🍀', related: ['lucky','shamrock','green','irish'],                    siblingEmojis: ['🍀','💎','🏆','🐸','💸'] },
        bear:      { emoji: '🐻', related: ['grizzly','panda','honey','woods'],                     siblingEmojis: ['🐶','🐸','🐱','🦊','🐺'] },
        alien:     { emoji: '👽', related: ['ufo','extraterrestrial','area51','disclosure'],        siblingEmojis: ['👽','🚀','🌙','💀','🧠'] },
        money:     { emoji: '💸', related: ['cash','rich','wealth','dollar','bread'],               siblingEmojis: ['💎','💸','🏆','🔥','🚀'] },
        brain:     { emoji: '🧠', related: ['smart','iq','think','genius','mind'],                  siblingEmojis: ['🧠','👽','💎','⚡','🔥'] },
        poop:      { emoji: '💩', related: ['shit','crap','turd','fart','stink'],                   siblingEmojis: ['💩','💀','🤡','🔥','👽'] },
      }
      const EMOJI_TEXT_MAP = {
        '🚀': ['rocket','launch','blast'], '🌙': ['moon','luna','lunar'],
        '🔥': ['fire','flame','blaze'],    '💀': ['skull','dead','death'],
        '⚡': ['lightning','thunder','bolt'], '👽': ['alien','ufo','extraterrestrial'],
        '🐸': ['frog','pepe','toad'],      '🐶': ['dog','doge','shiba'],
        '🐱': ['cat','kitten','neko'],     '🐻': ['bear','grizzly','panda'],
        '🦊': ['fox','foxy'],              '🐺': ['wolf','wolfpack'],
        '💎': ['diamond','gem','crystal'], '💸': ['money','cash','rich'],
        '🏆': ['trophy','winner','champion'], '🧠': ['brain','smart','genius'],
        '💩': ['poop','shit','crap'],      '🍀': ['clover','lucky','shamrock'],
        '🤡': ['clown','joker','honk'],
      }

      const buildEmojiSeeds = (conceptName) => {
        const match = EMOJI_CONCEPT_MAP[conceptName]
        if (!match) return []
        const { emoji, related, siblingEmojis } = match
        const siblingTextNames = siblingEmojis
          .flatMap(e => EMOJI_TEXT_MAP[e] || [])
          .filter(t => !related.includes(t))
        return [...related, emoji, ...siblingEmojis, ...siblingTextNames]
      }

      // ── CategorySeeds — STRICT identity anchor required ──────────
      // Only fires when alpha symbol or name DIRECTLY contains the
      // category trigger word. No decomposition, no compatibility inference.
      // Cap: 3 seeds when AI unavailable, 6 when AI available.
      //
      // Emoji sibling search: only fires when alpha symbol contains
      // an actual emoji character — not inferred from text category.
      const SEED_CAP = canRunAI ? 6 : 3

      // Rule: V0A category seeds only when the category keyword is
      // literally present in the alpha's symbol or name.
      const symLower  = enrichedAlpha.symbol.toLowerCase()
      const nameLower = (enrichedAlpha.name || '').toLowerCase()
      const alphaIdentity = `${symLower} ${nameLower}`

      if (v0Category.length > 0) {
        console.log(`[CategorySeed] $${enrichedAlpha.symbol} → V0A categories: [${v0Category.join(', ')}]`)
        for (const cat of v0Category) {
          if (NARRATIVE_CATEGORIES[cat]) {
            const catKeywords = NARRATIVE_CATEGORIES[cat].keywords || []
            // STRICT: only add a category keyword if it appears in the alpha's identity
            const anchoredSeeds = catKeywords
              .filter(k =>
                alphaIdentity.includes(k.toLowerCase()) &&
                !v0SearchTerms.includes(k) &&
                !categorySeeds.includes(k) &&
                isValidSearchTerm(k)
              )
              .slice(0, SEED_CAP)
            if (anchoredSeeds.length > 0) {
              categorySeeds = [...categorySeeds, ...anchoredSeeds]
              console.log(`[CategorySeed] $${enrichedAlpha.symbol} → "${cat}" anchored seeds: [${anchoredSeeds.join(', ')}]`)
            } else {
              console.log(`[CategorySeed] $${enrichedAlpha.symbol} → "${cat}" — no seeds pass identity anchor, skipping`)
            }
          }
        }
      }

      // ── Emoji sibling search — emoji tickers only ─────────────────
      // Only fires when the alpha symbol literally contains an emoji char.
      // $🚀 → search emoji siblings. $ROCKET → no emoji seeding (text only).
      const EMOJI_REGEX = /\p{Emoji}/u
      const symbolHasEmoji = EMOJI_REGEX.test(enrichedAlpha.symbol)
      if (symbolHasEmoji) {
        const symLowerEmoji = enrichedAlpha.symbol.toLowerCase()
        const conceptMatch = Object.keys(EMOJI_CONCEPT_MAP).find(concept =>
          symLowerEmoji.includes(concept) ||
          Object.keys(EMOJI_TEXT_MAP).some(e => symLowerEmoji.includes(e) && EMOJI_CONCEPT_MAP[concept]?.emoji === e)
        )
        if (conceptMatch) {
          const emojiSeeds = buildEmojiSeeds(conceptMatch).slice(0, SEED_CAP)
          const newEmojiSeeds = emojiSeeds.filter(k => !categorySeeds.includes(k))
          if (newEmojiSeeds.length > 0) {
            categorySeeds = [...categorySeeds, ...newEmojiSeeds]
            console.log(`[CategorySeed] $${enrichedAlpha.symbol} → emoji ticker "${conceptMatch}" → ${newEmojiSeeds.length} sibling seeds`)
          }
        }
      }

      // Merge category seeds into V0A search terms
      let allV0Terms = [...new Set([...v0SearchTerms, ...categorySeeds])]

      // ── CT suffix variant expansion (subject-scoped) ────────────
      // Anchored to V0A relationshipHints TWIN/UNIVERSE/ECHO subjects only.
      // These come from the alpha's own identity — not category maps.
      const CT_SUFFIXES   = ['wif', 'inu', 'cat', 'pepe', 'sol']
      const CT_PREFIXES   = ['baby', 'evil', 'dark', 'mini']
      const SUBJECT_TYPES = new Set(['TWIN', 'UNIVERSE', 'ECHO'])
      const GENERIC_SKIP  = new Set(['coin','token','sol','the','and','wif','inu','cat','pepe','dog','moon','pump'])

      const subjectTerms = new Set(
        Object.entries(relationshipHints)
          .filter(([, type]) => SUBJECT_TYPES.has(type))
          .map(([term]) => term.toLowerCase().trim())
      )

      const ctVariants = new Set()
      for (const term of subjectTerms) {
        const t = term.toLowerCase().trim()
        if (t.length < 3 || t.length > 9)        continue
        if (t.includes(' ') || t.includes('-'))   continue
        if (GENERIC_SKIP.has(t))                  continue
        for (const suffix of CT_SUFFIXES) {
          if (!t.endsWith(suffix)) ctVariants.add(`${t}${suffix}`)
        }
        for (const prefix of CT_PREFIXES) {
          if (!t.startsWith(prefix)) ctVariants.add(`${prefix}${t}`)
        }
      }

      const ctVariantList = [...ctVariants].slice(0, 12)
      if (ctVariantList.length > 0) {
        allV0Terms = [...new Set([...allV0Terms, ...ctVariantList])]
        console.log(`[CTSuffix] ${ctVariantList.length} subject variants from ${subjectTerms.size} subjects: [${ctVariantList.slice(0,6).join(', ')}]`)
      } else if (subjectTerms.size === 0) {
        console.log('[CTSuffix] No TWIN/UNIVERSE/ECHO terms in hints — skipping suffix expansion')
      }

      // ── MetaSeed — disabled when AI unavailable ───────────────────
      // Injects terms from the active dominant narrative into compatible alphas.
      // Speculative by nature — results have no quality filter without AI scoring.
      // Gate: canRunAI must be true. MetaSeed runs in the term-building phase
      // (before DEX search), so this check correctly prevents unscored hits.
      if (canRunAI && metaSeedEnabled) try {
        let detectedCat = v0Category[0] || null
        if (!detectedCat && v0SearchTerms.length > 0) {
          detectedCat = inferCategoryFromTerms(v0SearchTerms)
          if (detectedCat) console.log(`[MetaSeed] Inferred category "${detectedCat}" from V0 terms`)
        }

        const sznRaw = localStorage.getItem('betaplays_szn_cache_v1')
        if (sznRaw) {
          const sznCache = JSON.parse(sznRaw)
          const categoryCounts = {}
          Object.values(sznCache).forEach(entry => {
            if (entry?.category) categoryCounts[entry.category] = (categoryCounts[entry.category] || 0) + 1
          })
          const dominant = Object.entries(categoryCounts)
            .sort((a, b) => b[1] - a[1])
            .find(([, count]) => count >= 3)

          if (dominant) {
            const [dominantCat, dominantCount] = dominant
            const hasOwnTerms = v0SearchTerms.length > 0 || descKeywords.length > 0 || categorySeeds.length > 0
            if (!hasOwnTerms) {
              console.log(`[MetaSeed] Skipped — no own identity terms`)
            } else if (!detectedCat) {
              console.log(`[MetaSeed] Blocked — token category unknown`)
            } else if (dominantCat === detectedCat) {
              console.log(`[MetaSeed] Skipped — already in dominant category "${dominantCat}"`)
            } else if (areCategoriesCompatible(detectedCat, dominantCat)) {
              const metaSeeds = (NARRATIVE_CATEGORIES[dominantCat]?.keywords || [])
                .filter(k => !allV0Terms.includes(k) && isValidSearchTerm(k))
                .slice(0, 6)
              if (metaSeeds.length > 0) {
                console.log(`[MetaSeed] "${dominantCat}" (${dominantCount} runners) compatible with "${detectedCat}" → [${metaSeeds.join(', ')}]`)
                allV0Terms = [...new Set([...allV0Terms, ...metaSeeds])]
              }
            } else {
              console.log(`[MetaSeed] Blocked — "${detectedCat}" and "${dominantCat}" incompatible`)
            }
          }
        }
      } catch { /* silent — meta seeding is non-fatal */ }

      // ── Approach A: Progressive beta population ──────────────────
      // Signals run in parallel. As each DEX term resolves, hits are pushed
      // to the UI immediately via pushPartial — users see betas appearing
      // one by one rather than all at once after 40–80s of silence.
      //
      // Architecture:
      //   - accumulatorRef: shared dedup map (address → raw result)
      //   - pushPartial: merges new hits, deduplicates, calls setBetas
      //   - fetchDEXSearchBetas gets onHit callback — fires per term
      //   - Other signals (morph, LP, OG, telegram) push on completion
      //   - Vector 8 reorders the final accumulated list at the end
      //
      // Dedup is by baseToken.address — same contract from different pools
      // collapses to one entry with merged signal sources.

      if (!isStale()) setScanPhase('searching')
      const _t2 = Date.now()

      const accumulator = new Map()  // address → { pair, sources }

      const pushPartial = (newHits) => {
        if (isStale()) return
        let changed = false
        for (const { pair, sources } of newHits) {
          const addr = pair.baseToken?.address
          if (!addr) continue
          if (accumulator.has(addr)) {
            // Merge sources for existing entry
            const existing = accumulator.get(addr)
            const merged = [...new Set([...existing.sources, ...sources])]
            if (merged.length !== existing.sources.length) {
              accumulator.set(addr, { pair, sources: merged })
              changed = true
            }
          } else {
            accumulator.set(addr, { pair, sources })
            changed = true
          }
        }
        if (!changed) return

        // Build partial beta list and push to UI
        const partialResults = Array.from(accumulator.values())
        const partialMerged  = mergeAndScore(partialResults, enrichedAlpha.symbol, enrichedAlpha.marketCap)
        if (!isStale()) setBetas(partialMerged)
      }

      // Run all signals in parallel — DEX search fires onHit per term,
      // others push their full result on completion.
      const [dexRes, morphRes, pumpRes, lpRes, ogRes, telegramRes, twitterRes] =
        await Promise.allSettled([
          fetchDEXSearchBetas(
            enrichedAlpha, descKeywords, allV0Terms, v0VisualTerms, v0VisualCounters,
            (hits) => pushPartial(hits)  // onHit: stream each term's results immediately
          ),
          fetchMorphologyBetas(enrichedAlpha.symbol, v0SearchTerms),
          fetchPumpFunBetas(enrichedAlpha.symbol, descKeywords, enrichedAlpha.name, allV0Terms),
          fetchLPPairBetas(enrichedAlpha),
          fetchExactMatchOGs(enrichedAlpha.symbol, enrichedAlpha.address),
          fetchTelegramBetas(enrichedAlpha.symbol),
          fetchTwitterBetas(enrichedAlpha.symbol),
        ])

      // Push non-DEX signals on completion (they return all at once)
      if (morphRes.status    === 'fulfilled' && morphRes.value.length)    pushPartial(morphRes.value)
      if (pumpRes.status     === 'fulfilled' && pumpRes.value.length)     pushPartial(pumpRes.value)
      if (lpRes.status       === 'fulfilled' && lpRes.value.length)       pushPartial(lpRes.value)
      if (ogRes.status       === 'fulfilled' && ogRes.value.length)       pushPartial(ogRes.value)
      if (telegramRes.status === 'fulfilled' && telegramRes.value.length) pushPartial(telegramRes.value)
      if (twitterRes.status  === 'fulfilled' && twitterRes.value.length)  pushPartial(twitterRes.value)

      console.log(`[Perf] $${alpha.symbol} parallel signals (V1+V1b+V2/V3/V4/V5/V6/V10/V11): ${Date.now()-_t2}ms`)

      // Final deduplicated result from accumulator — source of truth for downstream
      const allResults = Array.from(accumulator.values())

      // Merge signals 1-5 into deduplicated list
      const mergedRaw = mergeAndScore(allResults, enrichedAlpha.symbol, enrichedAlpha.marketCap)

      // ── Beta price refresh ──────────────────────────────────────
      // PumpFun betas arrive with bonding-curve mcap (~$36K) and 0% h24.
      // After graduation they disappear from PumpFun feed but live on DEX.
      // Refresh stale prices now so the list shows real post-migration data.
      const merged = await refreshBetaPrices(mergedRaw)

      // Track how many betas this alpha has spawned — feeds Legend algorithm.
      // Written to localStorage as fast session cache AND to Supabase via
      // record-betas (beta_relations rows). useAlphas.js reads the count
      // from Supabase via /api/beta-count so all users see accurate counts.
      if (merged.length > 0) {
        try {
          const spawnCounts = JSON.parse(localStorage.getItem('betaplays_beta_spawn_counts') || '{}')
          const addr = enrichedAlpha.address
          spawnCounts[addr] = Math.max(spawnCounts[addr] || 0, merged.length)
          localStorage.setItem('betaplays_beta_spawn_counts', JSON.stringify(spawnCounts))
        } catch {}
      }

      // ── Sibling scan: find narrative siblings via parent ─────────
      let siblingResults = []
      if (parentAlphaRef.current) {

        // ── Step A: Load KNOWN siblings from localStorage ──────────
        // Three sources of already-confirmed sibling addresses:
        //
        //   1. betaplays_parent_map — every token whose parent was confirmed
        //      by useParentAlpha is written here. Reverse-lookup: find all
        //      tokens whose parent address matches our parent.
        //
        //   2. betaplays_betas_v2 — the parent's own stored beta scan.
        //      The parent's betas ARE the sibling universe — any token in
        //      the parent's beta list is a co-derivative by definition.
        //
        //   3. betaplays_seen_alphas — live feed history. Any runner that
        //      shares the same confirmed parent is a sibling even if it
        //      never appeared in a scan.
        //
        // These are address-based, not search-based, so they surface
        // dormant siblings that have fallen off DEX search rankings.
        const knownSiblingAddresses = new Set()
        try {
          // Source 1: reverse-read the parent map
          // Source 1: Supabase-loaded parent map (pre-fetched at top of fetchBetas)
          Object.entries(cachedParentMap).forEach(([addr, entry]) => {
            if (entry?.address === parentAlphaRef.current.address && addr !== enrichedAlpha.address) {
              knownSiblingAddresses.add(addr)
            }
          })

          // Source 2: parent's own stored beta scan (localStorage session cache)
          const betaStore = JSON.parse(localStorage.getItem(BETA_STORE_KEY) || '{}')
          const parentBetas = betaStore[parentAlphaRef.current.address] || []
          parentBetas.forEach(b => {
            if (b.address && b.address !== enrichedAlpha.address) {
              knownSiblingAddresses.add(b.address)
            }
          })

          // Source 3: seen alphas with same parent
          const seenAlphas = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')
          Object.entries(seenAlphas).forEach(([addr, token]) => {
            const confirmedParent = cachedParentMap[addr]
            if (confirmedParent?.address === parentAlphaRef.current.address && addr !== enrichedAlpha.address) {
              knownSiblingAddresses.add(addr)
            }
          })

          console.log(`[Siblings] Found ${knownSiblingAddresses.size} known sibling addresses from Supabase+localStorage`)
        } catch (storageErr) {
          console.warn('[Siblings] localStorage read failed (non-fatal):', storageErr.message)
        }

        // Fetch live prices for all known siblings in one DEX batch call.
        // This surfaces dormant siblings regardless of search ranking.
        let storedSiblingResults = []
        if (knownSiblingAddresses.size > 0) {
          try {
            const addrBatches = []
            const addrArr = [...knownSiblingAddresses]
            for (let i = 0; i < addrArr.length; i += 30) addrBatches.push(addrArr.slice(i, i + 30))

            for (const batch of addrBatches) {
              const res = await DEX_QUEUE.get(
                `${DEXSCREENER_BASE}/latest/dex/tokens/${batch.join(',')}`
              )
              ;(res.data?.pairs || [])
                .filter(p =>
                  p.chainId === 'solana' &&
                  (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
                  isHealthyBetaLiquidity(p)
                )
                .forEach(p => {
                  storedSiblingResults.push({ pair: p, sources: ['sibling_stored'] })
                })
            }
            console.log(`[Siblings] Fetched live prices for ${storedSiblingResults.length} stored siblings`)
          } catch (fetchErr) {
            console.warn('[Siblings] Stored sibling price fetch failed (non-fatal):', fetchErr.message)
          }
        }

        // ── Step B: DEX search vectors against parent ─────────────
        // Runs in parallel with Step A. Finds siblings that aren't
        // in localStorage yet (new tokens just launched).
        try {
          // Run all vectors against the parent, PLUS LP pair scraping and OG scan
          // against the parent address. These are address-based so they find dormant
          // siblings that fell off search results — not just trending tokens.
          // Also fetch Telegram/Twitter betas for the parent — if $CLAW has Telegram
          // signal, those betas are also valid plays when $CLAWCARD is selected.
          const [sibKeyword, sibLore, sibMorph, sibPump, sibLP, sibOG, sibTelegram, sibTwitter] = await Promise.allSettled([
            fetchDEXSearchBetas({ symbol: parentAlphaRef.current.symbol, name: parentAlphaRef.current.name, address: '' }, [], [], [], []),
            fetchMorphologyBetas(parentAlphaRef.current.symbol, []),
            fetchPumpFunBetas(parentAlphaRef.current.symbol, [], parentAlphaRef.current.name),
            fetchLPPairBetas(parentAlphaRef.current),
            fetchExactMatchOGs(parentAlphaRef.current.symbol, parentAlphaRef.current.address),
            fetchTelegramBetas(parentAlphaRef.current.symbol),
            fetchTwitterBetas(parentAlphaRef.current.symbol),
          ])
          const sibRaw = [
            // Step A: known siblings from localStorage (address-based, not search-rank dependent)
            ...storedSiblingResults,
            // Step B: DEX search results (finds newly launched siblings)
            ...(sibKeyword.status   === 'fulfilled' ? sibKeyword.value   : []),
            ...(sibLore.status      === 'fulfilled' ? sibLore.value      : []),
            ...(sibMorph.status     === 'fulfilled' ? sibMorph.value     : []),
            ...(sibPump.status      === 'fulfilled' ? sibPump.value      : []),
            ...(sibLP.status        === 'fulfilled' ? sibLP.value        : []),
            ...(sibOG.status        === 'fulfilled' ? sibOG.value        : []),
            ...(sibTelegram.status  === 'fulfilled' ? sibTelegram.value  : []),
            ...(sibTwitter.status   === 'fulfilled' ? sibTwitter.value   : []),
          ]
          const sibMerged    = mergeAndScore(sibRaw, parentAlphaRef.current.symbol, parentAlphaRef.current.marketCap)
          const mergedAddrs  = new Set(merged.map(b => b.address))
          const alphaAddress = enrichedAlpha.address

          // Filter: exclude the current alpha itself, exclude already-found betas,
          // exclude tokens that are themselves live alphas (independent runners
          // should never appear as siblings — $mogging/$joy/$distorted case),
          // and exclude tokens with NO corroborating signal beyond 'sibling'.
          const SIBLING_CORROBORATION = new Set(['keyword','morphology','og_match','lore','description','desc_match','pumpfun','lp_pair','sibling_stored'])

          // Read known alpha addresses from localStorage — alphas are independent
          // runners and must never be classified as siblings of each other.
          let knownAlphaAddresses = new Set()
          try {
            const seenAlphas = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')
            knownAlphaAddresses = new Set(Object.keys(seenAlphas))
          } catch {}

          // Read parent map to do two-way confirmation:
          // A true sibling must share the SAME confirmed parent as the current alpha.
          // "Found near the parent's namespace" is not enough — that's just proximity.
          // $mogging (no parent) and $joy (parent: $AI Joy) are NOT siblings even if
          // the keyword scan finds them together.
          // Use pre-loaded Supabase parent map — already fetched at top of fetchBetas
          const parentMap = cachedParentMap
          const currentParentAddress = parentAlphaRef.current.address

          siblingResults = sibMerged
            .filter(b => {
              if (b.address === alphaAddress) return false
              if (mergedAddrs.has(b.address)) return false
              // Live alphas are excluded as siblings UNLESS they share the
              // same confirmed parent as the current alpha — in that case they
              // are genuine co-derivatives and degens need to see the relationship.
              // e.g. $PIPPIKO and $MEANPIPPIN both running, both children of $PIPPIN
              // → true siblings. $mogging and $joy both running, different parents
              // → not siblings, exclude.
              if (knownAlphaAddresses.has(b.address)) {
                const candidateParent = parentMap[b.address]
                const isConfirmedCoDerivative = candidateParent?.address === currentParentAddress
                if (!isConfirmedCoDerivative) {
                  console.log(`[Siblings] Filtered $${b.symbol} — live alpha, unconfirmed co-derivative`)
                  return false
                }
                console.log(`[Siblings] Kept $${b.symbol} — live alpha but confirmed co-derivative of $${parentAlphaRef.current.symbol}`)
              }
              // Two-way parent confirmation — candidate must share the same
              // confirmed parent address as the current alpha.
              // If we have no parent map entry for this candidate, we cannot
              // confirm siblinghood — exclude it to avoid false positives.
              const candidateParent = parentMap[b.address]
              if (candidateParent && candidateParent.address !== currentParentAddress) {
                console.log(`[Siblings] Filtered $${b.symbol} — different parent ($${candidateParent.symbol} vs $${parentAlphaRef.current.symbol})`)
                return false
              }
              // sibling_stored = came from localStorage (parent's betas / parent_map confirmed).
              // These are pre-validated — no additional corroboration needed.
              const sources = b.signalSources || []
              if (sources.includes('sibling_stored')) return true

              // Morphology hit on parent symbol = strong sibling signal even without
              // prior parent confirmation. If $GROKETTE is found by searching GROK
              // variants, it's almost certainly a sibling of $GROKHOUSE under $GROK.
              // No parent map entry needed — morphology is structural, not text-based.
              if (sources.includes('morphology')) {
                console.log(`[Siblings] Accepted $${b.symbol} — morphology of parent $${parentAlphaRef.current.symbol} (probable sibling)`)
                return true
              }

              // For search-discovered siblings with no parent_map entry,
              // require at least one corroborating signal to avoid noise.
              const hasCorroboration = sources.some(s => SIBLING_CORROBORATION.has(s))
              if (!hasCorroboration) {
                console.log(`[Siblings] Filtered noise $${b.symbol} — sibling-only, no corroborating signal`)
              }
              return hasCorroboration
            })
            .map(b => ({
              ...b,
              signalSources: [...new Set([...(b.signalSources || []), 'sibling'])],
              isSibling:     true,
              siblingOf:     parentAlphaRef.current.symbol,
            }))
            .map(b => ({
              ...b,
              signalSources: [...new Set([...(b.signalSources || []), 'sibling'])],
              isSibling:     true,
              siblingOf:     parentAlphaRef.current.symbol,
            }))

          console.log(`[Siblings] Found ${siblingResults.length} siblings of $${enrichedAlpha.symbol} via parent $${parentAlphaRef.current.symbol}`)
        } catch (sibErr) {
          console.warn('[Siblings] Sibling scan failed (non-fatal):', sibErr.message)
        }
      }

      // Merge siblings into the list — they'll be sorted by change% like everything else
      // ── Direct Derivatives: reverse parent map lookup ─────────────
      // When scanning alpha X, find all tokens whose confirmed parent IS X.
      // These are guaranteed betas — the parent relationship was already
      // validated when the child was scanned previously.
      const mergedAddrsForDerivs = new Set(merged.map(b => b.address))
      const derivChildAddrs = Object.entries(cachedParentMap)
        .filter(([childAddr, parent]) =>
          parent.address === enrichedAlpha.address &&
          childAddr !== enrichedAlpha.address &&
          !mergedAddrsForDerivs.has(childAddr)
        )
        .map(([childAddr]) => childAddr)

      let directDerivResults = []
      if (derivChildAddrs.length > 0) {
        console.log(`[DirectDeriv] Found ${derivChildAddrs.length} child(ren) of $${enrichedAlpha.symbol} in parent map`)
        try {
          const res   = await DEX_QUEUE.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${derivChildAddrs.join(',')}`)
          const pairs = res.data?.pairs || []
          const bestPair = {}
          pairs
            .filter(p => p.chainId === 'solana')
            .forEach(p => {
              const addr = p.baseToken?.address
              if (!addr) return
              const prev = bestPair[addr]
              if (!prev || (p.volume?.h24 || 0) > (prev.volume?.h24 || 0)) bestPair[addr] = p
            })
          directDerivResults = derivChildAddrs
            .map(addr => {
              const pair = bestPair[addr]
              if (!pair) return null

              // Guardrail: desc-sourced entries pass unconditionally.
              // root-sourced (or legacy/no sourceType) must have a naming anchor.
              const entry = cachedParentMap[addr]
              const srcType = entry?.sourceType || 'root'
              if (srcType !== 'desc') {
                const childSym = pair.baseToken?.symbol || ''
                if (!hasNamingAnchor(childSym, enrichedAlpha.symbol, enrichedAlpha.name)) {
                  console.log(`[DirectDeriv] ⛔ $${childSym} rejected — root-sourced, no naming anchor to $${enrichedAlpha.symbol}`)
                  return null
                }
              }

              return {
                address:        addr,
                symbol:         pair.baseToken?.symbol || addr.slice(0, 8),
                name:           pair.baseToken?.name   || '',
                priceUsd:       pair.priceUsd,
                priceChange24h: pair.priceChange?.h24 ?? 0,
                volume24h:      pair.volume?.h24       || 0,
                marketCap:      pair.marketCap || pair.fdv || 0,
                liquidity:      pair.liquidity?.usd    || 0,
                logoUrl:        pair.info?.imageUrl    || null,
                dexUrl:         `https://dexscreener.com/solana/${addr}`,
                signalSources:  ['direct_derivative'],
                priceRefreshedAt: Date.now(),
              }
            })
            .filter(Boolean)
          directDerivResults.forEach(b =>
            console.log(`[DirectDeriv] ✅ $${b.symbol} confirmed child of $${enrichedAlpha.symbol}`)
          )
        } catch (err) {
          console.warn(`[DirectDeriv] DEX fetch failed (non-fatal):`, err.message)
        }
      }

      const mergedWithSiblings = [...merged, ...siblingResults, ...directDerivResults]
        .sort((a, b) => {
          const aIsLP  = a.signalSources?.includes('lp_pair') ? 1 : 0
          const bIsLP  = b.signalSources?.includes('lp_pair') ? 1 : 0
          if (bIsLP !== aIsLP) return bIsLP - aIsLP
          return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
        })
        .slice(0, 40)

      // ── Signal 9: Vector 9 — Bidirectional Description Match ─────
      // Scan each candidate's OWN description for alpha references and
      // keyword overlap. Zero API calls — pure text match on data we
      // already have. Runs before Vector 8 so AI gets pre-enriched signals.
      const descMatches = scoreDescriptionMatch(
        mergedWithSiblings,
        enrichedAlpha.symbol,
        enrichedAlpha.name || '',
        descKeywords
      )
      const descMatchMap = new Map(descMatches.map(m => [m.address, m]))

      const mergedWithDesc = descMatches.length > 0
        ? mergedWithSiblings.map(b => {
            const match = descMatchMap.get(b.address)
            if (!match) return b
            console.log(
              `[Vector9] $${b.symbol} desc_match (${match.matchType}): ` +
              `"${match.matchedTerms.join(', ')}"`
            )
            return {
              ...b,
              signalSources: [...new Set([...(b.signalSources || []), 'desc_match'])],
              descMatchType:  match.matchType,
              descMatchTerms: match.matchedTerms,
            }
          })
        : mergedWithSiblings

      if (descMatches.length > 0) {
        console.log(`[Vector9] ${descMatches.length} desc_match hits for $${enrichedAlpha.symbol}`)
      }

      // ── Signal 7: Vision — logo comparison (runs BEFORE Vector 8) ──────
      // Runs on all candidates that have a logoUrl — not just weak-signal ones.
      // By running before Vector 8, visual_match becomes a signal that AI
      // can use as corroboration. Previously it ran after AI, so it could
      // only enrich tokens that already survived — missing the point entirely.
      //
      // Trigger: alpha has a logo AND at least one candidate has a logo.
      // Skip: lp_pair and og_match candidates — already structurally confirmed.
      // Cap: top 20 by logo availability to manage Gemini quota.
      let mergedWithVision = mergedWithDesc
      if (enrichedAlpha.logoUrl && isPro) {
        try {
          const visionCandidates = mergedWithDesc
            .filter(b =>
              b.logoUrl &&
              !b.signalSources?.includes('lp_pair') &&
              !b.signalSources?.includes('og_match')
            )
            .slice(0, 20)

          if (visionCandidates.length > 0) {
            console.log(`[Vision] Comparing ${visionCandidates.length} logos against $${enrichedAlpha.symbol}...`)
            // Enrich alpha with visual context so backend prompt knows what to look for
            const alphaWithVisualContext = {
              ...enrichedAlpha,
              visualTerms:    v0VisualTerms,    // what the logo depicts ("panda", "trump")
              visualCounters: v0VisualCounters, // visual antonyms ("wolf", "predator")
            }
            const visualMatches = await compareLogos(alphaWithVisualContext, visionCandidates)

            if (visualMatches.length > 0) {
              const visualMap = new Map(visualMatches.map(b => [b.address, b]))
              mergedWithVision = mergedWithDesc.map(b =>
                visualMap.has(b.address)
                  ? {
                      ...b,
                      ...visualMap.get(b.address),
                      signalSources: [...new Set([...(b.signalSources || []), 'visual_match'])],
                    }
                  : b
              )
              console.log(`[Vision] ${visualMatches.length} visual matches found — passing to Vector 8`)
            } else {
              console.log(`[Vision] No visual matches above threshold`)
            }
          }
        } catch (visionErr) {
          console.warn('[Vision] Logo comparison failed (non-fatal):', visionErr.message)
        }
      }

      // Approach A refresh: list already has partial betas from pushPartial.
      // This upgrades the visible list with desc_match + vision enrichment
      // before Vector 8 reorders. Users see quality improve in real time.
      if (!isStale()) {
        setBetas(mergedWithVision)
        setScanPhase('scoring')
      }

      // ── Signal 6: Vector 8 AI scoring ───────────────────────────
      // Runs after Vision — candidates carry visual_match signal so AI
      // can use it as corroboration when classifying ambiguous tokens.
      //
      // finalList is declared HERE (outer scope) so the persistence block
      // below can always reference it, even if Vector 8 throws or is skipped.
      // Falls back to mergedWithVision (pre-AI candidates) if AI fails entirely.
      let finalList = mergedWithVision  // fallback: use pre-AI list if V8 fails

      // ── Freemium gate: V8 AI scoring ─────────────────────────────
      // Pro users: always run V8.
      // Free users: run V8 for first 2 alphas this session (taste),
      //             then inject locked placeholders so they see what they're missing.
      // canRunAI declared earlier (before seeding phase) — reused here.
      if (!isPro && canRunAI) bumpFreeAiCount()

      if (!canRunAI) {
        // ── Pre-AI quality gate — Weighted Convergence ────────────
        // Replaces binary 2-signal count with weighted scoring.
        // keyword+lore (2+1=3) no longer passes the same as keyword+telegram (2+6=8).
        //
        // desc_match splits by matchType:
        //   explicit (dev named the alpha in their own description) → 7
        //   keyword_overlap (2+ shared narrative keywords)          → 3
        //
        // Threshold: 6. Auto-pass: lp_pair or og_match (weight ≥ 10).
        const SIGNAL_WEIGHTS = {
          lp_pair:          10,
          og_match:         10,
          direct_derivative: 10,
          sibling_stored:    8,
          telegram_signal:   6,
          twitter_signal:    6,
          // desc_match split by matchType — see below
          visual_match:      4,
          morphology:        4,
          pumpfun:           2,
          keyword:           2,
          lore:              1,
          description:       1,
        }
        // Free users: threshold 4 (morphology or double-keyword passes; single weak signal blocked)
        // Pro users never hit this gate — they go through AI scoring instead.
        const PREAI_THRESHOLD = 4

        const getDescMatchWeight = (b) => {
          if (!(b.signalSources || []).includes('desc_match')) return 0
          return b.descMatchType === 'explicit' ? 7 : 3
        }

        const gated = mergedWithVision.filter(b => {
          const srcs = new Set(b.signalSources || [])

          // Auto-pass: on-chain structural proof
          if (srcs.has('lp_pair') || srcs.has('og_match')) return true

          // Sum weights across all signals present
          let score = 0
          for (const sig of srcs) {
            if (sig === 'desc_match') {
              score += getDescMatchWeight(b)
            } else {
              score += SIGNAL_WEIGHTS[sig] || 0
            }
          }

          if (score >= PREAI_THRESHOLD) return true

          console.log(`[PreAIGate] ⛔ Held $${b.symbol} — score ${score}/${PREAI_THRESHOLD} [${[...srcs].join(',')}]`)
          return false
        })

        console.log(`[PreAIGate] ${mergedWithVision.length} candidates → ${gated.length} passed (weighted convergence, threshold ${PREAI_THRESHOLD})`)
        finalList = gated
        if (!isStale()) setScanPhase('complete')
      } else try {
        const { results: aiScored, rejectedAddresses } =
          await classifyRelationships(enrichedAlpha, mergedWithVision, relationshipHints)

        // ── Merge AI classifications into list ─────────────────────
        const aiAddresses = new Map(aiScored.map(b => [b.address, b]))

        const withAI = mergedWithVision.map(b => {
          if (!aiAddresses.has(b.address)) return b
          const aiData = aiAddresses.get(b.address)
          return {
            ...b,
            ...aiData,
            relationshipType: aiData.relationshipType || b.relationshipType || null,
          }
        })

        // Add any new betas found only by AI (rare but possible)
        const existingAddresses = new Set(mergedWithVision.map(b => b.address))
        const aiOnly = aiScored.filter(b => !existingAddresses.has(b.address))
        const withAIAndNew = [...withAI, ...aiOnly]

        // ── Remove confirmed noise ─────────────────────────────────
        // STRONG on-chain facts override everything:
        //   lp_pair  — direct liquidity pool with alpha (undeniable)
        //   og_match — exact same ticker found by address
        //
        // V8 rejection logic:
        //   1. On-chain signals always win
        //   2. V8 explicit rejects always honoured
        //   3. Description-only single signals: keep the gate tight
        //      Description keywords can still leak noise despite V1b filter
        //      (safety net, scoring edge cases). Keep V8 cautious here.
        //   4. All other single signals: V8 free reign — trust its scoring
        const UNCHALLENGEABLE = new Set(['lp_pair','og_match'])

        const filtered = withAIAndNew.filter(b => {
          const srcs = b.signalSources || []

          // On-chain signals can't be argued with
          if (srcs.some(s => UNCHALLENGEABLE.has(s))) return true

          // V8 explicitly rejected — always honour
          if (rejectedAddresses.has(b.address)) {
            console.log(`[Vector8] 🗑️  Removed $${b.symbol} — AI rejected | signals:[${srcs.join(',')}]`)
            return false
          }

          const hasNoRelationship = !b.relationshipType || b.relationshipType === 'SPIN'
          const veryLowScore      = (b.aiScore || 0) < 0.45
          const singleSignal      = srcs.length === 1

          // Description-only: tighter gate — noise still leaks occasionally
          // Keep this until V1b filter is battle-tested across many tokens
          if (singleSignal && srcs[0] === 'description') {
            const isLowConfidence = hasNoRelationship && veryLowScore
            if (isLowConfidence) {
              console.log(`[Vector8] 🗑️  Removed $${b.symbol} — description-only, no relationship, score ${b.aiScore || 'unscored'} | signals:[${srcs.join(',')}]`)
              return false
            }
          }

          // All other single-signal tokens: only drop if truly unrelated
          // (no relationship assigned AND score extremely low)
          if (singleSignal && hasNoRelationship && veryLowScore) {
            console.log(`[Vector8] 🗑️  Removed $${b.symbol} — single signal, no relationship, score ${b.aiScore || 'unscored'} | signals:[${srcs.join(',')}]`)
            return false
          }

          return true
        })

        // ── Dead token filter ──────────────────────────────────────
        // Runs after V8 — removes tokens that passed entry filters but
        // have since decayed. Requires 3+ dead signals to avoid false positives.
        // LP_PAIR and og_match tokens are immune — on-chain facts override decay signals.
        const alive = filtered.reduce((acc, b) => {
          const isProtected = b.signalSources?.includes('lp_pair') ||
                              b.signalSources?.includes('og_match')
          if (isProtected) {
            acc.push(b)
            return acc
          }
          const { isDead, signals, signalCount } = isDeadBeta(b)
          if (!isDead) {
            // Attach decay signals even on live tokens — useful for UI warnings
            // e.g. a token with 2/5 signals could show a ⚠️ COOLING badge
            acc.push({ ...b, decaySignals: signals, decayCount: signalCount })
          }
          return acc
        }, [])

        // ── Recompute ranks now that relationshipType is set ───────
        const reranked = alive.map(b => ({ ...b, betaRank: computeBetaRank(b) }))

        // ── Final sort: LP_PAIR → rank → recency ──────────────────
        finalList = reranked
          .sort((a, b) => {
            const aIsLP = a.signalSources?.includes('lp_pair') ? 1 : 0
            const bIsLP = b.signalSources?.includes('lp_pair') ? 1 : 0
            if (bIsLP !== aIsLP) return bIsLP - aIsLP

            return b.betaRank - a.betaRank
          })
          .slice(0, 40)

        console.log(`[Ranking] $${enrichedAlpha.symbol} final list: ${finalList.length} betas`)
        finalList.forEach(b => {
          console.log(`  rank:${b.betaRank} | $${b.symbol} | ${b.relationshipType || 'unclassified'} | signals:[${(b.signalSources||[]).join(',')}]`)
        })

        if (!isStale()) setBetas(finalList)
      } catch (aiErr) {
        console.warn('[Vector8] AI scoring failed:', aiErr.message)
      }

      // ── Persist betas to localStorage ───────────────────────────
      // IMPORTANT: use finalList (the just-computed result), NOT the `betas`
      // state variable. `betas` is a stale closure — it holds the value from
      // when fetchBetas was created, not after setBetas(finalList) was called.
      // Using `betas` here would save the old/empty state and then merge the
      // contaminated old stored data back in — the root cause of beta bleeding.
      //
      // We also do NOT re-merge stored betas into the UI here. The fresh scan
      // IS the truth. Historical betas that are genuinely still relevant will
      // be re-discovered on the next scan and re-saved. Forcing old stored data
      // back onto the screen after a clean scan defeats the entire filter pipeline.
      const stored = loadStoredBetas(myAddress)
      // Merge fresh results with stored so historical betas aren't lost entirely,
      // but the merge only keeps stored tokens that have a signal source strong
      // enough to survive the current filter rules (ai_match or structural signals).
      // Weak stored tokens (lore-only, keyword-only, no AI score) are dropped.
      const freshAddresses = new Set((finalList || []).map(b => b.address))
      const validStored = stored.filter(b => {
        if (freshAddresses.has(b.address)) return false  // already in fresh list
        const srcs = b.signalSources || []
        // Only keep stored betas that were AI-confirmed or structurally strong
        const isConfirmed = srcs.includes('ai_match') || srcs.includes('lp_pair') || srcs.includes('og_match') || srcs.includes('direct_derivative')
        if (!isConfirmed) {
          console.log(`[BetaStore] Dropping unconfirmed stored $${b.symbol} — signals:[${srcs.join(',')}]`)
          return false
        }
        return true
      })
      const mergedForStorage = [...(finalList || []), ...validStored].slice(0, 50)
      saveStoredBetas(myAddress, mergedForStorage)

      // ── Record beta relationships to Neon DB (fire-and-forget) ───
      // Non-blocking — swallowed silently. Failure = that scan not recorded.
      // confirmed_count increments on the server every time a pair is seen again.
      if (mergedForStorage.length > 0) {
        fetch(`${BACKEND_URL}/api/record-betas`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            alphaAddress: myAddress,
            betas: mergedForStorage.map(b => ({
              address:               b.address,
              symbol:                b.symbol,
              name:                  b.name,
              logoUrl:               b.logoUrl || b.icon,
              signals:               b.signalSources || [],
              score:                 b.betaRank,
              relationshipType:      b.relationshipType      || null,
              betaPriceAtDetection:  b.priceUsd              || null,
              betaMcapAtDetection:   b.marketCap             || null,
              alphaPriceAtDetection: alpha?.priceUsd         || null,
            })),
          }),
        }).catch(() => {})
      }
      if (!isStale()) {
        const LOCKED_PLACEHOLDERS = !canRunAI ? Array.from({ length: 3 }, (_, i) => ({
          address: `locked_${i}`, symbol: '???', name: 'Unlock with Pro',
          locked: true, lockedReason: 'ai', signalSources: ['ai_match'],
          relationshipType: 'TWIN', aiScore: null,
        })) : []
        if (mergedForStorage.length === 0 && LOCKED_PLACEHOLDERS.length === 0)
          setError('No beta plays detected yet. Trenches might be cooked.')
        else setBetas([...mergedForStorage, ...LOCKED_PLACEHOLDERS])
      }
    } catch (err) {
      console.error('Beta detection failed:', err)
      if (!isStale()) setError('Detection engine error. Try refreshing.')
    } finally {
      if (!isStale()) {
        setLoading(false)
        setScanPhase('complete')
      }
    }
  // parentAlpha intentionally NOT in deps — it resolves async and would
  // trigger a second full scan. Read via parentAlphaRef.current instead.
  }, [alpha?.address])

  useEffect(() => { fetchBetas() }, [fetchBetas])

  // ── Sibling enrichment — fires when parentAlpha resolves ─────────
  // The main scan runs immediately on alpha selection (parentAlpha = null at that point).
  // When useParentAlpha resolves, this effect runs a TARGETED sibling-only pass
  // and merges siblings into the existing beta list — no full rescan.
  // Guard: only runs if scan is complete (not loading) and parent is real.
  const prevParentRef = useRef(null)
  useEffect(() => {
    const parentAddr = parentAlphaRef.current?.address
    if (!parentAddr) return
    if (prevParentRef.current === parentAddr) return  // already ran for this parent
    if (loading) return  // main scan still running — sibling block inside will handle it
    if (!alpha?.address) return

    prevParentRef.current = parentAddr

    // Run lightweight sibling-only scan and merge into existing list
    const runSiblingEnrichment = async () => {
      try {
        const parent = parentAlphaRef.current
        if (!parent) return

        console.log(`[Siblings] Post-scan enrichment — parent $${parent.symbol} resolved`)

        // Reuse stored sibling addresses from localStorage (fast, no API calls)
        const knownSiblingAddresses = new Set()
        try {
          // Use pre-loaded Supabase parent map — already fetched at top of fetchBetas
          const betaStore  = JSON.parse(localStorage.getItem(BETA_STORE_KEY) || '{}')
          const seenAlphas = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')

          Object.entries(cachedParentMap).forEach(([addr, entry]) => {
            if (entry?.address === parent.address && addr !== alpha.address) knownSiblingAddresses.add(addr)
          })
          ;(betaStore[parent.address] || []).forEach(b => {
            if (b.address && b.address !== alpha.address) knownSiblingAddresses.add(b.address)
          })
          Object.entries(seenAlphas).forEach(([addr, token]) => {
            const tokenParent = cachedParentMap[addr]
            if (tokenParent?.address === parent.address && addr !== alpha.address) knownSiblingAddresses.add(addr)
          })
        } catch { /* silent */ }

        if (knownSiblingAddresses.size === 0) {
          console.log(`[Siblings] No stored siblings found for parent $${parent.symbol}`)
          return
        }

        console.log(`[Siblings] Post-scan: ${knownSiblingAddresses.size} stored sibling addresses`)

        // Fetch live prices for known siblings
        const addrs = Array.from(knownSiblingAddresses).slice(0, 20)
        const res   = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${addrs.join(',')}`)
        if (!res.ok) return
        const data  = await res.json()
        const pairs = data?.pairs || []

        const newSiblings = pairs
          .filter(p =>
            p.chainId === 'solana' &&
            p.baseToken?.address !== alpha.address &&
            (p.liquidity?.usd || 0) >= 500 &&
            isHealthyBetaLiquidity(p) &&
            isActiveBeta(p)
          )
          .map(p => ({
            ...formatBeta(p, ['keyword', 'lore', 'sibling']),
            siblingOf:     parent.symbol,
            relationshipType: 'UNIVERSE',
          }))

        if (newSiblings.length === 0) return

        console.log(`[Siblings] Post-scan: merging ${newSiblings.length} siblings into beta list`)

        setBetas(prev => {
          if (!prev?.length) return prev
          const existingAddrs = new Set(prev.map(b => b.address))
          const fresh = newSiblings.filter(s => !existingAddrs.has(s.address))
          if (fresh.length === 0) return prev
          return [...prev, ...fresh].sort((a, b) => (b.betaRank || 0) - (a.betaRank || 0))
        })
      } catch (err) {
        console.warn('[Siblings] Post-scan enrichment failed (non-fatal):', err.message)
      }
    }

    runSiblingEnrichment()
  }, [parentAlpha?.address, loading, alpha?.address])

  // ── Interval-based beta price refresh ────────────────────────
  // Keeps beta prices live without triggering a full rescan.
  // Runs every 90 seconds — aggressive enough to catch rapid moves
  // while avoiding hammering DEX (30 addresses per call max).
  //
  // Guards:
  //   - Only runs when an alpha is selected (betas exist)
  //   - Skips if a full scan is in progress (loading)
  //   - Skips if betas list is empty
  //   - Uses the same refreshBetaPrices fn the scan uses
  useEffect(() => {
    if (!alpha?.address) return

    const interval = setInterval(async () => {
      setBetas(prev => {
        if (!prev?.length || loading) return prev
        // Fire refresh in background — update state when done
        refreshBetaPrices(prev).then(refreshed => {
          if (refreshed && refreshed.length > 0) {
            setBetas(refreshed)
          }
        }).catch(() => {})  // Silent — stale prices better than crash
        return prev  // Return prev immediately — refreshed arrives async
      })
    }, 90_000)

    return () => clearInterval(interval)
  }, [alpha?.address, loading])

  return { betas, loading, error, scanPhase, refresh: fetchBetas, resolvedDescription }
}

export default useBetas