import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { getSearchTerms, getConcepts } from '../data/lore_map'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const PUMPFUN_BASE = 'https://frontend-api.pump.fun'

// Minimum liquidity to show a beta ($5k — low bar intentional, degens like smalls)
const MIN_LIQUIDITY = 5000

// ─── Signal scoring ──────────────────────────────────────────────
// Returns { label, tier } where tier drives sort priority
const getSignal = (beta) => {
  if (beta.signalSources?.includes('pumpfun') && beta.signalSources?.includes('keyword')) {
    return { label: 'CABAL', tier: 4 }
  }
  if (beta.signalSources?.includes('pumpfun')) {
    return { label: 'TRENDING', tier: 3 }
  }
  if (beta.signalSources?.includes('keyword')) {
    return { label: 'STRONG', tier: 2 }
  }
  if (beta.signalSources?.includes('lore')) {
    return { label: 'LORE', tier: 1 }
  }
  return { label: 'WEAK', tier: 0 }
}

// ─── Format a DEXScreener pair into our beta shape ───────────────
const formatBeta = (pair, sources = []) => {
  const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null
  const ageDays = ageMs ? Math.floor(ageMs / 86400000) : null
  const ageHours = ageMs ? Math.floor((ageMs % 86400000) / 3600000) : null

  let ageLabel = '—'
  if (ageDays !== null) {
    if (ageDays > 0) ageLabel = `${ageDays}d`
    else if (ageHours !== null) ageLabel = `${ageHours}h`
    else ageLabel = '<1h'
  }

  return {
    id: pair.pairAddress || pair.baseToken?.address,
    symbol: pair.baseToken?.symbol || '???',
    name: pair.baseToken?.name || 'Unknown',
    address: pair.baseToken?.address || '',
    pairAddress: pair.pairAddress || '',
    priceUsd: pair.priceUsd || '0',
    priceChange24h: pair.priceChange?.h24 || 0,
    volume24h: pair.volume?.h24 || 0,
    marketCap: pair.marketCap || pair.fdv || 0,
    liquidity: pair.liquidity?.usd || 0,
    logoUrl: pair.info?.imageUrl || null,
    ageLabel,
    signalSources: sources,
    dexUrl: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
  }
}

// ─── Signal 1: Keyword/ticker search on DEXScreener ─────────────
const fetchKeywordBetas = async (alphaSymbol) => {
  const terms = getSearchTerms(alphaSymbol)
  const results = []

  for (const term of terms.slice(0, 4)) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${term}`)
      const pairs = res.data?.pairs || []

      const filtered = pairs.filter(
        (p) =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          p.baseToken?.symbol?.toUpperCase() !== alphaSymbol.toUpperCase() &&
          p.baseToken?.symbol !== 'SOL' &&
          p.baseToken?.symbol !== 'USDC'
      )

      filtered.forEach((p) => {
        results.push({ pair: p, sources: ['keyword'] })
      })
    } catch (err) {
      console.warn(`Keyword search failed for "${term}":`, err.message)
    }
  }

  return results
}

// ─── Signal 2: Lore/concept matching ────────────────────────────
const fetchLoreBetas = async (alphaSymbol) => {
  const concepts = getConcepts(alphaSymbol)
  const results = []

  // Search for concept terms that are different from keyword terms
  for (const concept of concepts.slice(0, 3)) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${concept}`)
      const pairs = res.data?.pairs || []

      const filtered = pairs.filter(
        (p) =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          p.baseToken?.symbol?.toUpperCase() !== alphaSymbol.toUpperCase() &&
          p.baseToken?.symbol !== 'SOL' &&
          p.baseToken?.symbol !== 'USDC'
      )

      filtered.forEach((p) => {
        results.push({ pair: p, sources: ['lore'] })
      })
    } catch (err) {
      console.warn(`Lore search failed for "${concept}":`, err.message)
    }
  }

  return results
}

// ─── Signal 3: PumpFun trending ──────────────────────────────────
const fetchPumpFunBetas = async (alphaSymbol) => {
  const concepts = getConcepts(alphaSymbol)
  const results = []

  try {
    // Fetch recently traded coins on PumpFun
    const res = await axios.get(
      `${PUMPFUN_BASE}/coins?sort=last_trade_timestamp&order=DESC&limit=50&includeNsfw=false`,
      { timeout: 8000 }
    )

    const coins = res.data || []

    // Filter: name or symbol contains any of our narrative concepts
    const narrativeCoins = coins.filter((coin) => {
      const nameL = (coin.name || '').toLowerCase()
      const symL = (coin.symbol || '').toLowerCase()
      const descL = (coin.description || '').toLowerCase()

      return concepts.some(
        (c) => nameL.includes(c) || symL.includes(c) || descL.includes(c)
      )
    })

    // These are PumpFun coins — they may not have DEXScreener pairs yet
    // We format them with available data
    narrativeCoins.slice(0, 10).forEach((coin) => {
      results.push({
        pair: {
          pairAddress: coin.mint,
          baseToken: {
            symbol: coin.symbol,
            name: coin.name,
            address: coin.mint,
          },
          priceUsd: coin.usd_market_cap
            ? String(coin.usd_market_cap / (coin.total_supply || 1e9))
            : '0',
          priceChange: { h24: 0 },
          volume: { h24: coin.volume || 0 },
          marketCap: coin.usd_market_cap || 0,
          liquidity: { usd: coin.virtual_sol_reserves ? coin.virtual_sol_reserves * 150 : 0 },
          info: { imageUrl: coin.image_uri || null },
          url: `https://pump.fun/${coin.mint}`,
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

// ─── Merge, deduplicate, score, and sort ─────────────────────────
const mergeAndScore = (rawResults, alphaSymbol) => {
  const seen = new Map()

  rawResults.forEach(({ pair, sources }) => {
    const key = pair.baseToken?.address || pair.pairAddress
    if (!key) return

    if (seen.has(key)) {
      // Merge signal sources if token appears in multiple signals
      const existing = seen.get(key)
      existing.signalSources = [...new Set([...existing.signalSources, ...sources])]
    } else {
      seen.set(key, formatBeta(pair, sources))
    }
  })

  return Array.from(seen.values())
    .filter(
      (b) =>
        b.symbol.toUpperCase() !== alphaSymbol.toUpperCase() &&
        b.symbol !== 'SOL' &&
        b.symbol !== 'USDC' &&
        b.symbol !== 'USDT'
    )
    // Sort: primary = 24h % gain descending, secondary = signal tier
    .sort((a, b) => {
      const changeA = parseFloat(a.priceChange24h) || 0
      const changeB = parseFloat(b.priceChange24h) || 0
      return changeB - changeA
    })
    .slice(0, 30)
}

// ─── Main hook ───────────────────────────────────────────────────
const useBetas = (alpha) => {
  const [betas, setBetas] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const fetchBetas = useCallback(async () => {
    if (!alpha) {
      setBetas([])
      return
    }

    setLoading(true)
    setError(null)
    setBetas([])

    try {
      // Run all three signals in parallel for speed
      const [keywordResults, loreResults, pumpResults] = await Promise.allSettled([
        fetchKeywordBetas(alpha.symbol),
        fetchLoreBetas(alpha.symbol),
        fetchPumpFunBetas(alpha.symbol),
      ])

      const allResults = [
        ...(keywordResults.status === 'fulfilled' ? keywordResults.value : []),
        ...(loreResults.status === 'fulfilled' ? loreResults.value : []),
        ...(pumpResults.status === 'fulfilled' ? pumpResults.value : []),
      ]

      const merged = mergeAndScore(allResults, alpha.symbol)
      setBetas(merged)

      if (merged.length === 0) {
        setError('No beta plays detected yet. Market might be early.')
      }
    } catch (err) {
      console.error('Beta detection failed:', err)
      setError('Detection engine error. Try refreshing.')
    } finally {
      setLoading(false)
    }
  }, [alpha?.id])

  useEffect(() => {
    fetchBetas()
  }, [fetchBetas])

  return { betas, loading, error, refresh: fetchBetas }
}

export { getSignal }
export default useBetas