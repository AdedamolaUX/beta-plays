import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { getSearchTerms, getConcepts, generateTickerVariants } from '../data/lore_map'
import scoreWithAI from './useAIBetaScoring'
import { compareLogos, shouldRunVision } from './useImageAnalysis'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const BACKEND_URL      = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
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
    // Filter out expired betas
    return bucket.filter(b => (now - (b.storedAt || 0)) < BETA_TTL_MS)
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
  if (s.includes('pumpfun')    && s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('morphology') && s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('description')&& s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('pumpfun'))                                     return { label: 'TRENDING', tier: 3 }
  if (s.includes('ai_match'))                                    return { label: 'AI',       tier: 3 }
  if (s.includes('description'))                                 return { label: 'STRONG',   tier: 2 }
  if (s.includes('morphology'))                                  return { label: 'STRONG',   tier: 2 }
  if (s.includes('keyword'))                                     return { label: 'STRONG',   tier: 2 }
  if (s.includes('lore'))                                        return { label: 'LORE',     tier: 1 }
  return                                                                { label: 'WEAK',     tier: 0 }
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
    dexUrl:         pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
  }
}

// ─── Signal 1: Keyword + compound decomposition ──────────────────
const fetchKeywordBetas = async (alphaSymbol, alphaName = '') => {
  const nameTerms  = getNameTerms(alphaSymbol, alphaName)
  const terms      = getSearchTerms(alphaSymbol)
  const decomposed = decomposeSymbol(alphaSymbol)
  // Name terms go first — highest priority, most likely to find culturally relevant betas
  // No cap — every meaningful term fires. DEXScreener has no strict rate limit.
  const allTerms   = [...new Set([...nameTerms, ...terms, ...decomposed])]
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
const fetchDescriptionBetas = async (alpha, descKeywords) => {
  if (!descKeywords || descKeywords.length === 0) return []
  const results = []
  for (const keyword of descKeywords.slice(0, 4)) {
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
const fetchLoreBetas = async (alphaSymbol, alphaName = '') => {
  // Get concepts from both symbol AND name — critical for tokens where the
  // cultural reference lives in the name (e.g. symbol=MOYU, name=摸鱼)
  const symbolConcepts = getConcepts(alphaSymbol)
  const nameConcepts   = alphaName && alphaName.toLowerCase() !== alphaSymbol.toLowerCase()
    ? getConcepts(alphaName)
    : []
  // Also treat the raw name itself as a search term if it has a lore entry
  const nameTerms = getNameTerms(alphaSymbol, alphaName)
  const concepts  = [...new Set([...symbolConcepts, ...nameConcepts, ...nameTerms])]
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

// ─── Signal 4: PumpFun trending ──────────────────────────────────
const fetchPumpFunBetas = async (alphaSymbol, descKeywords = [], alphaName = '') => {
  const nameTerms  = getNameTerms(alphaSymbol, alphaName).map(t => t.toLowerCase())
  const concepts   = getConcepts(alphaSymbol)
  const decomposed = decomposeSymbol(alphaSymbol).map(d => d.toLowerCase())
  // Name terms included — critical for CJK tokens like MOYU/摸鱼
  const allTerms   = [...new Set([...nameTerms, ...concepts, ...decomposed, ...descKeywords])]
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
    .map(b => ({ ...b, mcapRatio: getMcapRatio(alphaMcap, b.marketCap) }))
    .sort((a, b) => {
      // LP pair betas always float to top regardless of % change
      const aIsLP = a.signalSources?.includes('lp_pair') ? 1 : 0
      const bIsLP = b.signalSources?.includes('lp_pair') ? 1 : 0
      if (bIsLP !== aIsLP) return bIsLP - aIsLP
      return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
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

  // Load stored betas immediately on alpha change so panel is never empty
  useEffect(() => {
    if (!alpha?.address) { setBetas([]); return }
    const stored = loadStoredBetas(alpha.address)
    if (stored.length > 0) {
      setBetas(stored)
      console.log()
    }
  }, [alpha?.address])

  const fetchBetas = useCallback(async () => {
    if (!alpha) { setBetas([]); return }
    setLoading(true)
    setError(null)
    // Note: don't clear betas here — keep stored visible while fetching

    try {
      // Fetch description keywords first — feeds into multiple signals
      // Also returns raw description for Vector 8 AI scoring
      const { keywords: descKeywords, description: alphaDescription } =
        await fetchDescriptionKeywords(alpha)

      // Enrich alpha with description if we got a fresh one
      const enrichedAlpha = alphaDescription
        ? { ...alpha, description: alphaDescription }
        : alpha

      // Run all signals in parallel
      const [keywordRes, descRes, loreRes, morphRes, pumpRes, lpRes] =
        await Promise.allSettled([
          fetchKeywordBetas(enrichedAlpha.symbol, enrichedAlpha.name),
          fetchDescriptionBetas(enrichedAlpha, descKeywords),
          fetchLoreBetas(enrichedAlpha.symbol, enrichedAlpha.name),
          fetchMorphologyBetas(enrichedAlpha.symbol),
          fetchPumpFunBetas(enrichedAlpha.symbol, descKeywords, enrichedAlpha.name),
          fetchLPPairBetas(enrichedAlpha),
        ])

      const allResults = [
        ...(keywordRes.status === 'fulfilled' ? keywordRes.value : []),
        ...(descRes.status    === 'fulfilled' ? descRes.value    : []),
        ...(loreRes.status    === 'fulfilled' ? loreRes.value    : []),
        ...(morphRes.status   === 'fulfilled' ? morphRes.value   : []),
        ...(pumpRes.status    === 'fulfilled' ? pumpRes.value    : []),
        ...(lpRes.status      === 'fulfilled' ? lpRes.value      : []),
      ]

      // Merge signals 1-5 into deduplicated list
      const merged = mergeAndScore(allResults, enrichedAlpha.symbol, enrichedAlpha.marketCap)

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

          // Filter: exclude the current alpha itself, exclude already-found betas
          siblingResults = sibMerged
            .filter(b => b.address !== alphaAddress && !mergedAddrs.has(b.address))
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
        const aiScored = await scoreWithAI(enrichedAlpha, mergedWithSiblings)
        if (aiScored.length > 0) {
          // Merge AI scores into mergedWithSiblings — NOT merged —
          // so siblings are preserved after AI scoring runs
          const aiAddresses = new Map(aiScored.map(b => [b.address, b]))
          const withAI = mergedWithSiblings.map(b =>
            aiAddresses.has(b.address)
              ? { ...b, ...aiAddresses.get(b.address) }
              : b
          )
          // Add any new betas found only by AI
          const existingAddresses = new Set(mergedWithSiblings.map(b => b.address))
          const aiOnly = aiScored.filter(b => !existingAddresses.has(b.address))

          const finalList = [...withAI, ...aiOnly]
            .sort((a, b) => {
              const aIsLP = a.signalSources?.includes('lp_pair') ? 1 : 0
              const bIsLP = b.signalSources?.includes('lp_pair') ? 1 : 0
              if (bIsLP !== aIsLP) return bIsLP - aIsLP
              return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
            })
            .slice(0, 40)

          setBetas(finalList)
        }
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