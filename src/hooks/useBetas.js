import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { getSearchTerms, getConcepts, generateTickerVariants } from '../data/lore_map'
import classifyRelationships from './useAIBetaScoring'
import { compareLogos, shouldRunVision } from './useImageAnalysis'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const BACKEND_URL      = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// ─── Vector 0: Fetch AI concept expansion from server ────────────
// Server caches per alpha address — shared across all users.
// Client detects re-entry via mcap growth and sends forceRefresh.
const fetchAlphaExpansion = async (alpha) => {
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
  }, { timeout: 45000 })  // 45s — handles Render cold start (free tier spins down)

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

const loadStoredBetas = (alphaAddress) => {
  try {
    const store = JSON.parse(localStorage.getItem(BETA_STORE_KEY) || '{}')
    const bucket = store[alphaAddress] || []
    const now = Date.now()
    // Filter expired + recompute dexUrl from token address every load
    // Pair addresses go stale when pools migrate (PumpFun → PumpSwap).
    // Token address is permanent — DEXScreener routes to the active pool.
    return bucket
      .filter(b => (now - (b.storedAt || 0)) < BETA_TTL_MS)
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

const isStalePrice = (b) => {
  const sources = b.signalSources || []
  const onlyPumpFun = sources.every(s => s === 'pumpfun')
  const zeroPriceChange = parseFloat(b.priceChange24h) === 0
  const bondingMcap = (b.marketCap || 0) <= 80_000
  // Stale if: only came from pumpfun AND (no h24 change data OR stuck near bonding)
  return onlyPumpFun || (zeroPriceChange && bondingMcap)
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
      const res   = await axios.get(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${addrs}`,
        { timeout: 8000 }
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
        console.log(`[BetaRefresh] ✅ $${b.symbol}: mcap $${b.marketCap?.toLocaleString()} → $${(pair.marketCap || pair.fdv || 0).toLocaleString()} | 24h: ${pair.priceChange?.h24}%`)
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

const extractDescriptionKeywords = (description) => {
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

  // Latin path — unchanged
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w =>
      w.length >= 3 &&
      w.length <= 20 &&
      !STOP_WORDS.has(w) &&
      !/^\d+$/.test(w)
    )
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 8)
}

const fetchDescriptionKeywords = async (alpha) => {
  try {
    // If description was already saved at fetch time (PumpFun or profile), use it
    if (alpha.description && alpha.description.length > 10) {
      const keywords = extractDescriptionKeywords(alpha.description)
      console.log(`[Vector1] ${alpha.symbol} cached description → ${keywords.length} keywords`)
      return { keywords, description: alpha.description }
    }

    // Otherwise fetch from DEXScreener
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${alpha.address}`,
      { timeout: 6000 }
    )
    const pairs = res.data?.pairs || []
    if (pairs.length === 0) return { keywords: [], description: '' }

    const pair = pairs[0]
    const description =
      pair.info?.description ||
      pair.baseToken?.description ||
      ''

    const keywords = extractDescriptionKeywords(description)
    console.log(`[Vector1] ${alpha.symbol} description keywords:`, keywords)
    return { keywords, description }
  } catch (err) {
    console.warn('Description fetch failed:', err.message)
    return { keywords: [], description: '' }
  }
}

// ─── Vector 6: LP Pair Scraping ──────────────────────────────────
// The most explicit beta signal: a token paired directly against
// the alpha token (not SOL/USDC). If $HARVEY/$SHIRLEY pool exists,
// that's an undeniable relationship. No ambiguity, no scoring.

const fetchLPPairBetas = async (alpha) => {
  if (!alpha.address) return []

  try {
    // Search for tokens that have a pair with the alpha's address
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/search?q=${alpha.address}`,
      { timeout: 8000 }
    )

    const pairs = res.data?.pairs || []

    return pairs
      .filter(p => {
        if (p.chainId !== 'solana') return false
        if ((p.liquidity?.usd || 0) < MIN_LIQUIDITY) return false

        // The key check: is the alpha token one of the pair tokens?
        const quoteAddr  = p.quoteToken?.address || ''
        const baseAddr   = p.baseToken?.address  || ''
        const alphaAddr  = alpha.address

        const isDirectPair =
          quoteAddr === alphaAddr ||
          baseAddr  === alphaAddr

        // Exclude the alpha itself
        const isNotAlpha  = baseAddr !== alphaAddr

        return isDirectPair && isNotAlpha
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
const classifyTokens = (betas) => {
  const groups = {}
  betas.forEach((b) => {
    const sym = b.symbol.toUpperCase()
    if (!groups[sym]) groups[sym] = []
    groups[sym].push(b)
  })
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
  return classified
}

// ─── Signal scoring ──────────────────────────────────────────────
export const getSignal = (beta) => {
  const s = beta.signalSources || []
  // LP pair is the strongest possible signal — direct pairing
  if (s.includes('lp_pair'))                                     return { label: 'CABAL',    tier: 6 }
  // AI + any other signal = CABAL tier
  if (s.includes('ai_match')   && s.includes('keyword'))         return { label: 'CABAL',    tier: 5 }
  if (s.includes('ai_match')   && s.includes('morphology'))      return { label: 'CABAL',    tier: 5 }
  if (s.includes('ai_match')   && s.includes('og_match'))        return { label: 'CABAL',    tier: 5 }
  if (s.includes('pumpfun')    && s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('morphology') && s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('description')&& s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('og_match'))                                    return { label: 'OG',       tier: 4 }
  if (s.includes('pumpfun'))                                     return { label: 'TRENDING', tier: 3 }
  if (s.includes('ai_match'))                                    return { label: 'AI',       tier: 3 }
  if (s.includes('description'))                                 return { label: 'STRONG',   tier: 2 }
  if (s.includes('morphology'))                                  return { label: 'STRONG',   tier: 2 }
  if (s.includes('keyword'))                                     return { label: 'STRONG',   tier: 2 }
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
  lp_pair:     5,
  og_match:    4,  // exact same ticker — highest non-structural signal
  morphology:  4,
  keyword:     4,
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
    signalSources:  sources,
    tokenClass:     null,
    // Use TOKEN address not pair address — pairs change when pools migrate (PumpFun → PumpSwap etc)
    // Token address is permanent; DEXScreener always routes to the active pool
    dexUrl:         `https://dexscreener.com/solana/${pair.baseToken?.address || pair.pairAddress}`,
  }
}

// ─── Signal 1: Keyword + compound decomposition ──────────────────
const fetchKeywordBetas = async (alphaSymbol, alphaName = '', extraTerms = []) => {
  const nameTerms  = getNameTerms(alphaSymbol, alphaName)
  const terms      = getSearchTerms(alphaSymbol)
  const decomposed = decomposeSymbol(alphaSymbol)
  // Name terms first, then Vector 0 AI terms, then morphology
  const allTerms   = [...new Set([...nameTerms, ...extraTerms, ...terms, ...decomposed])]
  const results    = []
  for (const term of allTerms) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(term)}`)
      ;(res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
        )
        .forEach(p => results.push({ pair: p, sources: ['keyword'] }))
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 1b: Description-driven search (Vector 1 complete) ────
const fetchDescriptionBetas = async (alpha, descKeywords, extraTerms = []) => {
  const allKeywords = [...new Set([...(descKeywords || []), ...extraTerms])]
  if (!allKeywords.length) return []
  const results = []
  for (const keyword of allKeywords.slice(0, 6)) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${keyword}`)
      ;(res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          p.baseToken?.address !== alpha.address &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
        )
        .forEach(p => results.push({ pair: p, sources: ['description'] }))
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 2: Lore matching ─────────────────────────────────────
const fetchLoreBetas = async (alphaSymbol, alphaName = '', extraTerms = []) => {
  // Get concepts from both symbol AND name — critical for tokens where the
  // cultural reference lives in the name (e.g. symbol=MOYU, name=摸鱼)
  const symbolConcepts = getConcepts(alphaSymbol)
  const nameConcepts   = alphaName && alphaName.toLowerCase() !== alphaSymbol.toLowerCase()
    ? getConcepts(alphaName)
    : []
  // Also treat the raw name itself as a search term if it has a lore entry
  const nameTerms = getNameTerms(alphaSymbol, alphaName)
  // Vector 0 AI terms — these are the conceptual expansions (shelter for house, etc.)
  const concepts  = [...new Set([...symbolConcepts, ...nameConcepts, ...nameTerms, ...extraTerms])]
  const results   = []
  for (const concept of concepts) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(concept)}`)
      ;(res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
        )
        .forEach(p => results.push({ pair: p, sources: ['lore'] }))
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 3: Morphology engine ────────────────────────────────
const fetchMorphologyBetas = async (alphaSymbol) => {
  const variants = generateTickerVariants(alphaSymbol)
  const results  = []
  const batches  = []
  for (let i = 0; i < Math.min(variants.length, 25); i += 5) batches.push(variants.slice(i, i + 5))
  for (const batch of batches) {
    await Promise.allSettled(batch.map(async (variant) => {
      try {
        const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${variant}`)
        ;(res.data?.pairs || [])
          .filter(p =>
            p.chainId === 'solana' &&
            (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
            p.baseToken?.symbol?.toUpperCase() === variant.toUpperCase() &&
            !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
          )
          .forEach(p => results.push({ pair: p, sources: ['morphology'] }))
      } catch { /* silent */ }
    }))
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
  // Returns ~30 results ranked by recent activity. When a narrative
  // goes viral, new tokens flood these slots and push OGs off the list.
  try {
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(alphaSymbol)}`,
      { timeout: 8000 }
    )
    ;(res.data?.pairs || [])
      .filter(p => p.chainId === 'solana')
      .forEach(p => addResult(p))
  } catch (err) {
    console.warn('[OGScan] Pass 1 failed:', err.message)
  }

  // ── Pass 2: name-based search ────────────────────────────────
  // DEXScreener indexes token name separately from symbol. Searching
  // by name often returns a different result set — catches OGs whose
  // name matches even when symbol search is overwhelmed by new tokens.
  // Only run if pass 1 didn't already saturate with OG candidates.
  try {
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(alphaSymbol.toLowerCase())}`,
      { timeout: 8000 }
    )
    ;(res.data?.pairs || [])
      .filter(p => p.chainId === 'solana')
      .forEach(p => addResult(p))
  } catch { /* silent */ }

  // ── Pass 3: recover known OG addresses from localStorage ─────
  // If this alpha's betas were previously scanned and stored, check
  // those stored betas for og_match tokens — their addresses persist
  // even if they've since fallen off search results entirely.
  // This is the definitive fix for "OG pushed off 30-result window":
  // once found, the OG address is preserved in localStorage forever.
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
      const res = await axios.get(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${addrs}`,
        { timeout: 8000 }
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

  return classifyTokens(deduped)
    .map(b => ({ ...b, mcapRatio: getMcapRatio(alphaMcap, b.marketCap), betaRank: computeBetaRank(b) }))
    .sort((a, b) => {
      // LP pair always floats to top — structural ground truth
      const aIsLP = a.signalSources?.includes('lp_pair') ? 1 : 0
      const bIsLP = b.signalSources?.includes('lp_pair') ? 1 : 0
      if (bIsLP !== aIsLP) return bIsLP - aIsLP
      // Otherwise sort by rank — signal confidence × relationship strength
      return b.betaRank - a.betaRank
    })
    .slice(0, 30)
}

// ─── Main hook ───────────────────────────────────────────────────
// parentAlpha: if provided, also scans parent's namespace to find siblings
// Siblings are tagged as RIVAL so they appear in the beta list with correct signal
const useBetas = (alpha, parentAlpha = null) => {
  const [betas,   setBetas]   = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  // Load stored betas immediately on alpha change so panel is never empty,
  // then silently refresh their prices in the background
  useEffect(() => {
    if (!alpha?.address) { setBetas([]); return }
    const stored = loadStoredBetas(alpha.address)
    if (stored.length > 0) {
      setBetas(stored)
      // Silently refresh stale prices in background — don't block the UI
      refreshBetaPrices(stored).then(refreshed => {
        setBetas(refreshed)
        saveStoredBetas(alpha.address, refreshed)
      }).catch(() => {})
      console.log(`[BetaStore] Loaded ${stored.length} stored betas for $${alpha.symbol}`)
    }
  }, [alpha?.address])

  const fetchBetas = useCallback(async () => {
    if (!alpha) { setBetas([]); return }
    setLoading(true)
    setError(null)
    // Note: don't clear betas here — keep stored visible while fetching

    try {
      // Fetch description keywords first — feeds into multiple signals
      const { keywords: descKeywords, description: alphaDescription } =
        await fetchDescriptionKeywords(alpha)

      // Enrich alpha with description if we got a fresh one
      const enrichedAlpha = alphaDescription
        ? { ...alpha, description: alphaDescription }
        : alpha

      // ── Vector 0: AI concept expansion ───────────────────────────
      // Runs first — generates semantically targeted search terms.
      // Server caches per alpha, shared across all users.
      let v0Terms          = []
      let relationshipHints = {}
      try {
        const expansion = await fetchAlphaExpansion(enrichedAlpha)
        v0Terms           = [...(expansion.searchTerms || []), ...(expansion.visualTerms || [])]
        relationshipHints = expansion.relationshipHints || {}
        console.log(`[Vector0] $${enrichedAlpha.symbol} → ${v0Terms.length} expansion terms${expansion.fromCache ? ' (cached)' : ''}`)
      } catch (v0Err) {
        console.warn('[Vector0] Expansion failed (non-fatal — continuing without):', v0Err.message)
      }

      // Run all signals in parallel, seeded with Vector 0 terms
      const [keywordRes, descRes, loreRes, morphRes, pumpRes, lpRes, ogRes] =
        await Promise.allSettled([
          fetchKeywordBetas(enrichedAlpha.symbol, enrichedAlpha.name, v0Terms),
          fetchDescriptionBetas(enrichedAlpha, descKeywords, v0Terms),
          fetchLoreBetas(enrichedAlpha.symbol, enrichedAlpha.name, v0Terms),
          fetchMorphologyBetas(enrichedAlpha.symbol),
          fetchPumpFunBetas(enrichedAlpha.symbol, descKeywords, enrichedAlpha.name, v0Terms),
          fetchLPPairBetas(enrichedAlpha),
          fetchExactMatchOGs(enrichedAlpha.symbol, enrichedAlpha.address),
        ])

      const allResults = [
        ...(keywordRes.status === 'fulfilled' ? keywordRes.value : []),
        ...(descRes.status    === 'fulfilled' ? descRes.value    : []),
        ...(loreRes.status    === 'fulfilled' ? loreRes.value    : []),
        ...(morphRes.status   === 'fulfilled' ? morphRes.value   : []),
        ...(pumpRes.status    === 'fulfilled' ? pumpRes.value    : []),
        ...(lpRes.status      === 'fulfilled' ? lpRes.value      : []),
        ...(ogRes.status      === 'fulfilled' ? ogRes.value      : []),
      ]

      // Merge signals 1-5 into deduplicated list
      const mergedRaw = mergeAndScore(allResults, enrichedAlpha.symbol, enrichedAlpha.marketCap)

      // ── Beta price refresh ──────────────────────────────────────
      // PumpFun betas arrive with bonding-curve mcap (~$36K) and 0% h24.
      // After graduation they disappear from PumpFun feed but live on DEX.
      // Refresh stale prices now so the list shows real post-migration data.
      const merged = await refreshBetaPrices(mergedRaw)

      // Track how many betas this alpha has spawned — feeds Legend algorithm
      if (merged.length > 0) {
        try {
          const spawnCounts = JSON.parse(localStorage.getItem('betaplays_beta_spawn_counts') || '{}')
          const addr = enrichedAlpha.address
          // Keep the highest count seen — scans vary, don't regress
          spawnCounts[addr] = Math.max(spawnCounts[addr] || 0, merged.length)
          localStorage.setItem('betaplays_beta_spawn_counts', JSON.stringify(spawnCounts))
        } catch {}
      }

      // ── Sibling scan: find narrative siblings via parent ─────────
      // If this token has a known parent alpha ($PIPPIKO → parent: $PIPPIN),
      // run keyword + lore signals against the PARENT's symbol too.
      // Results that aren't already in merged = siblings → tagged RIVAL.
      // This means $PIPPIKO's beta list will surface $MEANPIPPIN as a RIVAL
      // and vice versa — giving traders the full family picture.
      let siblingResults = []
      if (parentAlpha) {
        try {
          const [sibKeyword, sibLore, sibMorph, sibPump] = await Promise.allSettled([
            fetchKeywordBetas(parentAlpha.symbol, parentAlpha.name),
            fetchLoreBetas(parentAlpha.symbol, parentAlpha.name),
            fetchMorphologyBetas(parentAlpha.symbol),
            fetchPumpFunBetas(parentAlpha.symbol, [], parentAlpha.name),
          ])
          const sibRaw = [
            ...(sibKeyword.status === 'fulfilled' ? sibKeyword.value : []),
            ...(sibLore.status    === 'fulfilled' ? sibLore.value    : []),
            ...(sibMorph.status   === 'fulfilled' ? sibMorph.value   : []),
            ...(sibPump.status    === 'fulfilled' ? sibPump.value    : []),
          ]
          const sibMerged    = mergeAndScore(sibRaw, parentAlpha.symbol, parentAlpha.marketCap)
          const mergedAddrs  = new Set(merged.map(b => b.address))
          const alphaAddress = enrichedAlpha.address

          // Filter: exclude the current alpha itself, exclude already-found betas,
          // and exclude tokens with NO corroborating signal beyond 'sibling'.
          // Pure sibling-only = found by scanning parent's namespace with no
          // direct link to the alpha — too weak to show, causes noise like $Ajinomoto.
          // A sibling must have at least one of: keyword, morphology, lore, description,
          // pumpfun, lp_pair as an additional signal to be included.
          const SIBLING_CORROBORATION = new Set(['keyword','morphology','og_match','lore','description','pumpfun','lp_pair'])
          siblingResults = sibMerged
            .filter(b => {
              if (b.address === alphaAddress) return false
              if (mergedAddrs.has(b.address)) return false
              const sources = b.signalSources || []
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
              siblingOf:     parentAlpha.symbol,
            }))
            .map(b => ({
              ...b,
              signalSources: [...new Set([...(b.signalSources || []), 'sibling'])],
              isSibling:     true,
              siblingOf:     parentAlpha.symbol,
            }))

          console.log(`[Siblings] Found ${siblingResults.length} siblings of $${enrichedAlpha.symbol} via parent $${parentAlpha.symbol}`)
        } catch (sibErr) {
          console.warn('[Siblings] Sibling scan failed (non-fatal):', sibErr.message)
        }
      }

      // Merge siblings into the list — they'll be sorted by change% like everything else
      const mergedWithSiblings = [...merged, ...siblingResults]
        .sort((a, b) => {
          const aIsLP  = a.signalSources?.includes('lp_pair') ? 1 : 0
          const bIsLP  = b.signalSources?.includes('lp_pair') ? 1 : 0
          if (bIsLP !== aIsLP) return bIsLP - aIsLP
          return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
        })
        .slice(0, 40)

      // ── Signal 6: Vector 8 AI scoring ───────────────────────────
      // enrichedAlpha.description is now populated — Claude gets full
      // narrative context, not just symbol + name. Candidates also carry
      // .description where available (PumpFun devs often name their alpha
      // directly in the description, e.g. "the dog version of $PIPPIN").
      setBetas(mergedWithSiblings)

      try {
        const { results: aiScored, rejectedAddresses } =
          await classifyRelationships(enrichedAlpha, mergedWithSiblings, relationshipHints)

        // ── Merge AI classifications into list ─────────────────────
        const aiAddresses = new Map(aiScored.map(b => [b.address, b]))

        const withAI = mergedWithSiblings.map(b => {
          if (!aiAddresses.has(b.address)) return b
          const aiData = aiAddresses.get(b.address)
          return {
            ...b,
            ...aiData,
            relationshipType: aiData.relationshipType || b.relationshipType || null,
          }
        })

        // Add any new betas found only by AI (rare but possible)
        const existingAddresses = new Set(mergedWithSiblings.map(b => b.address))
        const aiOnly = aiScored.filter(b => !existingAddresses.has(b.address))
        const withAIAndNew = [...withAI, ...aiOnly]

        // ── Remove confirmed noise ─────────────────────────────────
        // Only remove tokens that Vector 8 explicitly evaluated AND rejected.
        // LP_PAIR tokens are exempt — structural signal trumps AI opinion.
        // Tokens from failed batches are NOT in rejectedAddresses, so they stay.
        const filtered = withAIAndNew.filter(b => {
          if (b.signalSources?.includes('lp_pair')) return true  // never remove LP pairs
          if (rejectedAddresses.has(b.address)) {
            console.log(`[Vector8] 🗑️  Removed $${b.symbol} — scored below threshold`)
            return false
          }
          return true
        })

        // ── Recompute ranks now that relationshipType is set ───────
        const reranked = filtered.map(b => ({ ...b, betaRank: computeBetaRank(b) }))

        // ── Final sort: LP_PAIR → rank → recency ──────────────────
        const finalList = reranked
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

        setBetas(finalList)
      } catch (aiErr) {
        console.warn('[Vector8] AI scoring failed:', aiErr.message)
      }

      // ── Signal 7: Vision — visual logo comparison ────────────────
      // Only runs if alpha has a logo AND text/AI signals were weak.
      // Compares alpha logo against candidate logos via Claude Vision.
      // Catches visual derivatives text analysis is blind to:
      //   - Same character recolored
      //   - Alpha mascot wearing something new
      //   - Direct logo copy with minor edits
      try {
        // Get the latest betas state to check text confidence
        const currentBetas = await new Promise(resolve => {
          setBetas(prev => { resolve(prev); return prev })
        })
        const weakTextCandidates = currentBetas.filter(b =>
          shouldRunVision(b, (b.signalSources?.length || 0) * 0.25)
        )

        if (enrichedAlpha.logoUrl && weakTextCandidates.length > 0) {
          console.log(`[Vision] Comparing ${weakTextCandidates.length} candidate logos for $${enrichedAlpha.symbol}`)
          const visualMatches = await compareLogos(enrichedAlpha, weakTextCandidates)

          if (visualMatches.length > 0) {
            const visualAddresses = new Map(visualMatches.map(b => [b.address, b]))
            setBetas(prev => {
              const enriched = prev.map(b =>
                visualAddresses.has(b.address)
                  ? { ...b, ...visualAddresses.get(b.address) }
                  : b
              )
              // Any visual-only matches not already in list
              const existingAddresses = new Set(prev.map(b => b.address))
              const visualOnly = visualMatches.filter(b => !existingAddresses.has(b.address))
              return [...enriched, ...visualOnly]
                .sort((a, b) => {
                  const aLP = a.signalSources?.includes('lp_pair') ? 1 : 0
                  const bLP = b.signalSources?.includes('lp_pair') ? 1 : 0
                  if (bLP !== aLP) return bLP - aLP
                  return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
                })
                .slice(0, 35)
            })
            console.log(`[Vision] Added ${visualMatches.length} visual matches for $${enrichedAlpha.symbol}`)
          }
        }
      } catch (visionErr) {
        console.warn('[Vision] Logo comparison failed (non-fatal):', visionErr.message)
      }

      // ── Persist betas to localStorage ───────────────────────────
      // Read CURRENT betas state (post-AI, post-vision) via functional
      // update — this preserves AI scoring and visual matches.
      // Merge with any stored historical betas and save back.
      if (alpha?.address) {
        setBetas(prev => {
          const stored   = loadStoredBetas(alpha.address)
          const fullList = mergeBetas(prev, stored)
          saveStoredBetas(alpha.address, fullList)
          if (fullList.length === 0) setError('No beta plays detected yet. Trenches might be cooked.')
          return fullList.length > 0 ? fullList : prev  // never blank if prev had results
        })
      } else {
        if (merged.length === 0) setError('No beta plays detected yet. Trenches might be cooked.')
      }
    } catch (err) {
      console.error('Beta detection failed:', err)
      setError('Detection engine error. Try refreshing.')
    } finally {
      setLoading(false)
    }
  }, [alpha?.id, parentAlpha?.id])

  useEffect(() => { fetchBetas() }, [fetchBetas])

  return { betas, loading, error, refresh: fetchBetas }
}

export default useBetas