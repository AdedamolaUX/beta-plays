import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { getSearchTerms, getConcepts, generateTickerVariants } from '../data/lore_map'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const PUMPFUN_BASE     = 'https://frontend-api.pump.fun'
const MIN_LIQUIDITY    = 5000

// ─── Compound ticker decomposition ──────────────────────────────
// ALIENSCOPE → ['ALIEN', 'SCOPE']
// WIFHAT     → ['WIF', 'HAT']
// TRUMPCAT   → ['TRUMP', 'CAT']
// Dramatically improves beta detection for composite named tokens

const DECOMP_SUFFIXES = [
  'SCOPE', 'COIN', 'TOKEN', 'SWAP', 'PLAY', 'GAME', 'WORLD',
  'LAND', 'ZONE', 'CAT', 'DOG', 'HAT', 'WIF', 'INU', 'DAO',
  'MOON', 'PUMP', 'STAR', 'KING', 'LORD', 'APE', 'BOY', 'MAN',
]
const DECOMP_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
  'REAL', 'TURBO', 'CHAD', 'FAT', 'TINY', 'DARK', 'ULTRA',
]

const decomposeSymbol = (symbol) => {
  const s = symbol.toUpperCase()
  const parts = new Set()

  // Suffix stripping: ALIENSCOPE → ALIEN (root) + SCOPE (suffix)
  DECOMP_SUFFIXES.forEach((suffix) => {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      const root = s.slice(0, s.length - suffix.length)
      if (root.length >= 3) {
        parts.add(root)
        parts.add(suffix)
      }
    }
  })

  // Prefix stripping: BABYPEPE → PEPE
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
    .trim()
    .split(/\s+/)
    .filter(p => p.length >= 3)
  camelParts.forEach(p => parts.add(p.toUpperCase()))

  // Remove the original symbol itself — we already search that via keyword
  parts.delete(s)

  return Array.from(parts)
}

// ─── Wave Phase Detection (Vector 3) ────────────────────────────
export const getWavePhase = (alpha, beta) => {
  const betaAge = beta?.pairCreatedAt
    ? Date.now() - beta.pairCreatedAt
    : null

  if (!betaAge) return { label: 'UNKNOWN', color: 'var(--text-muted)', tier: 0 }

  const betaHours = betaAge / 3600000

  if (betaHours < 6)   return { label: '🌊 WAVE',    color: 'var(--neon-green)',     tier: 3, hours: betaHours }
  if (betaHours < 24)  return { label: '📈 2ND LEG', color: 'var(--amber)',          tier: 2, hours: betaHours }
  if (betaHours < 168) return { label: '🕐 LATE',    color: 'var(--text-secondary)', tier: 1, hours: betaHours }
  return                      { label: '🧊 COLD',    color: 'var(--text-muted)',     tier: 0, hours: betaHours }
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
    if (group.length === 1) {
      classified.push({ ...group[0], tokenClass: null })
      return
    }
    const sorted = [...group].sort((a, b) => (a.pairCreatedAt || Infinity) - (b.pairCreatedAt || Infinity))
    const og = sorted[0]
    sorted.forEach((token, index) => {
      if (index === 0) { classified.push({ ...token, tokenClass: 'OG' }); return }
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
  const sources = beta.signalSources || []
  if (sources.includes('pumpfun')   && sources.includes('keyword'))   return { label: 'CABAL',    tier: 4 }
  if (sources.includes('morphology')&& sources.includes('keyword'))   return { label: 'CABAL',    tier: 4 }
  if (sources.includes('pumpfun'))                                     return { label: 'TRENDING', tier: 3 }
  if (sources.includes('morphology'))                                  return { label: 'STRONG',   tier: 2 }
  if (sources.includes('keyword'))                                     return { label: 'STRONG',   tier: 2 }
  if (sources.includes('lore'))                                        return { label: 'LORE',     tier: 1 }
  return                                                                      { label: 'WEAK',     tier: 0 }
}

// ─── Format pair → beta ──────────────────────────────────────────
const formatBeta = (pair, sources = []) => {
  const ageMs    = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null
  const ageDays  = ageMs ? Math.floor(ageMs / 86400000) : null
  const ageHours = ageMs ? Math.floor((ageMs % 86400000) / 3600000) : null
  let ageLabel = '—'
  if (ageDays !== null) {
    if (ageDays > 0)       ageLabel = `${ageDays}d`
    else if (ageHours > 0) ageLabel = `${ageHours}h`
    else                   ageLabel = '<1h'
  }

  return {
    id:            pair.pairAddress || pair.baseToken?.address,
    symbol:        pair.baseToken?.symbol || '???',
    name:          pair.baseToken?.name   || 'Unknown',
    address:       pair.baseToken?.address || '',
    pairAddress:   pair.pairAddress || '',
    priceUsd:      pair.priceUsd || '0',
    priceChange24h: pair.priceChange?.h24 || 0,
    volume24h:     pair.volume?.h24    || 0,
    marketCap:     pair.marketCap || pair.fdv || 0,
    liquidity:     pair.liquidity?.usd || 0,
    logoUrl:       pair.info?.imageUrl || null,
    pairCreatedAt: pair.pairCreatedAt  || null,
    ageLabel,
    ageMs,
    signalSources: sources,
    tokenClass:    null,
    dexUrl:        pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
  }
}

// ─── Signal 1: Keyword + compound decomposition search ───────────
const fetchKeywordBetas = async (alphaSymbol) => {
  const terms = getSearchTerms(alphaSymbol)

  // Add compound decomposition terms
  // ALIENSCOPE → also search ALIEN, SCOPE
  const decomposed = decomposeSymbol(alphaSymbol)

  const allTerms = [...new Set([...terms, ...decomposed])].slice(0, 8)
  const results  = []

  for (const term of allTerms) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${term}`)
      const pairs = res.data?.pairs || []
      pairs
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          p.baseToken?.symbol !== 'SOL' &&
          p.baseToken?.symbol !== 'USDC'
        )
        .forEach(p => results.push({ pair: p, sources: ['keyword'] }))
    } catch (err) {
      console.warn(`Keyword search failed for "${term}":`, err.message)
    }
  }
  return results
}

// ─── Signal 2: Lore/concept matching ────────────────────────────
const fetchLoreBetas = async (alphaSymbol) => {
  const concepts = getConcepts(alphaSymbol)
  const results  = []
  for (const concept of concepts.slice(0, 3)) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${concept}`)
      const pairs = res.data?.pairs || []
      pairs
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          p.baseToken?.symbol !== 'SOL' &&
          p.baseToken?.symbol !== 'USDC'
        )
        .forEach(p => results.push({ pair: p, sources: ['lore'] }))
    } catch (err) {
      console.warn(`Lore search failed for "${concept}":`, err.message)
    }
  }
  return results
}

// ─── Signal 3: Ticker morphology engine ─────────────────────────
const fetchMorphologyBetas = async (alphaSymbol) => {
  const variants = generateTickerVariants(alphaSymbol)
  const results  = []
  const batches  = []
  for (let i = 0; i < Math.min(variants.length, 25); i += 5) {
    batches.push(variants.slice(i, i + 5))
  }
  for (const batch of batches) {
    await Promise.allSettled(
      batch.map(async (variant) => {
        try {
          const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${variant}`)
          const pairs = res.data?.pairs || []
          pairs
            .filter(p =>
              p.chainId === 'solana' &&
              (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
              p.baseToken?.symbol?.toUpperCase() === variant.toUpperCase() &&
              p.baseToken?.symbol !== 'SOL' &&
              p.baseToken?.symbol !== 'USDC'
            )
            .forEach(p => results.push({ pair: p, sources: ['morphology'] }))
        } catch (err) { /* silent */ }
      })
    )
  }
  return results
}

// ─── Signal 4: PumpFun trending ──────────────────────────────────
const fetchPumpFunBetas = async (alphaSymbol) => {
  // Use both lore concepts AND decomposed subwords for matching
  const concepts  = getConcepts(alphaSymbol)
  const decomposed = decomposeSymbol(alphaSymbol).map(d => d.toLowerCase())
  const allTerms  = [...new Set([...concepts, ...decomposed])]

  const results = []
  try {
    const res = await axios.get(
      `${PUMPFUN_BASE}/coins?sort=last_trade_timestamp&order=DESC&limit=50&includeNsfw=false`,
      { timeout: 8000 }
    )
    const coins = res.data || []
    coins
      .filter((coin) => {
        const nameL = (coin.name        || '').toLowerCase()
        const symL  = (coin.symbol      || '').toLowerCase()
        const descL = (coin.description || '').toLowerCase()
        return allTerms.some(t => nameL.includes(t) || symL.includes(t) || descL.includes(t))
      })
      .slice(0, 10)
      .forEach((coin) => {
        results.push({
          pair: {
            pairAddress:  coin.mint,
            baseToken:    { symbol: coin.symbol, name: coin.name, address: coin.mint },
            priceUsd:     coin.usd_market_cap
              ? String(coin.usd_market_cap / (coin.total_supply || 1e9))
              : '0',
            priceChange: { h24: 0 },
            volume:      { h24: coin.volume || 0 },
            marketCap:   coin.usd_market_cap || 0,
            liquidity:   { usd: coin.virtual_sol_reserves ? coin.virtual_sol_reserves * 150 : 0 },
            info:        { imageUrl: coin.image_uri || null },
            url:         `https://pump.fun/${coin.mint}`,
            pairCreatedAt: coin.created_timestamp,
          },
          sources: ['pumpfun'],
        })
      })
  } catch (err) {
    console.warn('PumpFun fetch failed:', err.message)
  }
  return results
}

// ─── Merge, dedupe, classify, score ─────────────────────────────
const mergeAndScore = (rawResults, alphaSymbol, alphaMcap) => {
  const seen = new Map()

  rawResults.forEach(({ pair, sources }) => {
    const key = pair.baseToken?.address || pair.pairAddress
    const sym = (pair.baseToken?.symbol || '').toUpperCase()
    if (!key) return
    if (sym === alphaSymbol.toUpperCase()) return

    if (seen.has(key)) {
      const existing = seen.get(key)
      existing.signalSources = [...new Set([...existing.signalSources, ...sources])]
    } else {
      seen.set(key, formatBeta(pair, sources))
    }
  })

  const deduped = Array.from(seen.values()).filter(
    b => !['SOL', 'USDC', 'USDT'].includes(b.symbol)
  )

  const classified = classifyTokens(deduped)

  return classified
    .map(b => ({ ...b, mcapRatio: getMcapRatio(alphaMcap, b.marketCap) }))
    .sort((a, b) => (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0))
    .slice(0, 30)
}

// ─── Main hook ───────────────────────────────────────────────────
const useBetas = (alpha) => {
  const [betas,   setBetas]   = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const fetchBetas = useCallback(async () => {
    if (!alpha) { setBetas([]); return }
    setLoading(true)
    setError(null)
    setBetas([])

    try {
      const [keywordResults, loreResults, morphResults, pumpResults] =
        await Promise.allSettled([
          fetchKeywordBetas(alpha.symbol),
          fetchLoreBetas(alpha.symbol),
          fetchMorphologyBetas(alpha.symbol),
          fetchPumpFunBetas(alpha.symbol),
        ])

      const allResults = [
        ...(keywordResults.status === 'fulfilled' ? keywordResults.value : []),
        ...(loreResults.status   === 'fulfilled' ? loreResults.value   : []),
        ...(morphResults.status  === 'fulfilled' ? morphResults.value  : []),
        ...(pumpResults.status   === 'fulfilled' ? pumpResults.value   : []),
      ]

      const merged = mergeAndScore(allResults, alpha.symbol, alpha.marketCap)
      setBetas(merged)
      if (merged.length === 0) setError('No beta plays detected yet. Trenches might be cooked.')
    } catch (err) {
      console.error('Beta detection failed:', err)
      setError('Detection engine error. Try refreshing.')
    } finally {
      setLoading(false)
    }
  }, [alpha?.id])

  useEffect(() => { fetchBetas() }, [fetchBetas])

  return { betas, loading, error, refresh: fetchBetas }
}

export default useBetas