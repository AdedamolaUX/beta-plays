import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import LEGENDS from '../data/historical_alphas'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const PUMPFUN_BASE     = 'https://frontend-api.pump.fun'

// ─── Thresholds ──────────────────────────────────────────────────
const LIVE_MIN_CHANGE    =  0
const LIVE_MIN_VOLUME    = 10_000
const COOLING_MIN_VOLUME =  5_000
const COOLING_MIN_MCAP   = 10_000
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// ─── localStorage ────────────────────────────────────────────────
const STORAGE_KEY = 'betaplays_seen_alphas'

const saveToHistory = (alphas) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now = Date.now()
    alphas.forEach((alpha) => {
      if (!alpha.address) return
      existing[alpha.address] = {
        ...alpha,
        firstSeen: existing[alpha.address]?.firstSeen || now,
        lastSeen:  now,
      }
    })
    Object.keys(existing).forEach((addr) => {
      if (now - existing[addr].lastSeen > HISTORY_MAX_AGE_MS) delete existing[addr]
    })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
  } catch (err) {
    console.warn('Failed to save alphas:', err.message)
  }
}

// ─── Load historical tokens by price action ──────────────────────
// Tokens not in the current fetch cycle are classified by how they
// were performing when last seen. Price action — not API presence —
// decides whether they go to Live or Cooling.
//
// Positive 24h when last seen → Live (still a runner until proven otherwise)
// Negative 24h when last seen → Cooling (retracing, watch for reversal)

const loadHistoricalByPriceAction = (currentAddresses) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now      = Date.now()

    const historicalLive    = []
    const historicalCooling = []

    Object.values(existing).forEach((a) => {
      const age         = now - a.lastSeen
      const inFeed      = currentAddresses.has(a.address)
      const change      = parseFloat(a.priceChange24h) || 0
      const volume      = a.volume24h || 0
      const mcap        = a.marketCap || 0

      // Skip if still in current feed (already classified fresh)
      if (inFeed) return
      // Skip if too old
      if (age > HISTORY_MAX_AGE_MS) return
      // Skip if no meaningful activity
      if (volume < COOLING_MIN_VOLUME || mcap < COOLING_MIN_MCAP) return

      const ageHours = Math.floor(age / 3600000)
      const ageDays  = Math.floor(age / 86400000)
      const ageLabel = ageDays > 0 ? `${ageDays}d ago` : ageHours > 0 ? `${ageHours}h ago` : 'recently'

      if (change > LIVE_MIN_CHANGE && volume >= LIVE_MIN_VOLUME) {
        // Was pumping — keep in Live
        historicalLive.push({
          ...a,
          isHistorical:  true,
          coolingLabel:  null,
        })
      } else if (change < 0) {
        // Was retracing — move to Cooling
        historicalCooling.push({
          ...a,
          isCooling:    true,
          coolingLabel: `Down ${Math.abs(change).toFixed(1)}% — watching for reversal`,
        })
      }
    })

    return { historicalLive, historicalCooling }
  } catch {
    return { historicalLive: [], historicalCooling: [] }
  }
}

// ─── Format pair → alpha ─────────────────────────────────────────
const formatAlpha = (pair, source = 'boost') => ({
  id:             pair.pairAddress || pair.baseToken?.address,
  symbol:         pair.baseToken?.symbol || '???',
  name:           pair.baseToken?.name   || 'Unknown',
  address:        pair.baseToken?.address || '',
  pairAddress:    pair.pairAddress || '',
  priceUsd:       pair.priceUsd || '0',
  priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
  volume24h:      pair.volume?.h24    || 0,
  marketCap:      pair.marketCap || pair.fdv || 0,
  liquidity:      pair.liquidity?.usd || 0,
  logoUrl:        pair.info?.imageUrl || null,
  pairCreatedAt:  pair.pairCreatedAt  || null,
  isHistorical:   false,
  isLegend:       false,
  isCooling:      false,
  coolingLabel:   null,
  source,
  dexUrl: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
})

// ─── Junk filter ─────────────────────────────────────────────────
const JUNK_SYMBOLS = new Set(['SOL', 'USDC', 'USDT', 'WSOL', 'BTC', 'ETH', 'WBTC'])
const isJunk = (alpha) =>
  JUNK_SYMBOLS.has(alpha.symbol.toUpperCase()) || (alpha.marketCap || 0) === 0

// ─── Source 1: DEXScreener boosted tokens ───────────────────────
const fetchBoostedAlphas = async () => {
  try {
    const res    = await axios.get(`${DEXSCREENER_BASE}/token-boosts/top/v1`, { timeout: 10000 })
    const boosts = (res.data || []).filter((b) => b.chainId === 'solana').slice(0, 20)
    if (!boosts.length) return []
    const pairResults = await Promise.allSettled(
      boosts.map((b) => axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${b.tokenAddress}`))
    )
    const alphas = []
    pairResults.forEach((result) => {
      if (result.status !== 'fulfilled') return
      const pairs = result.value.data?.pairs || []
      const best  = pairs
        .filter((p) => p.chainId === 'solana')
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]
      if (best) alphas.push(formatAlpha(best, 'boost'))
    })
    return alphas
  } catch (err) {
    console.warn('Boosted fetch failed:', err.message)
    return []
  }
}

// ─── Source 2: DEXScreener latest profiles ───────────────────────
const fetchProfileAlphas = async () => {
  try {
    const res      = await axios.get(`${DEXSCREENER_BASE}/token-profiles/latest/v1`, { timeout: 10000 })
    const profiles = (res.data || []).filter((b) => b.chainId === 'solana').slice(0, 20)
    if (!profiles.length) return []
    const pairResults = await Promise.allSettled(
      profiles.map((b) => axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${b.tokenAddress}`))
    )
    const alphas = []
    pairResults.forEach((result) => {
      if (result.status !== 'fulfilled') return
      const pairs = result.value.data?.pairs || []
      const best  = pairs
        .filter((p) => p.chainId === 'solana')
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]
      if (best) alphas.push(formatAlpha(best, 'profile'))
    })
    return alphas
  } catch (err) {
    console.warn('Profile fetch failed:', err.message)
    return []
  }
}

// ─── Source 3: PumpFun graduating tokens ────────────────────────
const fetchPumpFunGraduating = async () => {
  try {
    const res = await axios.get(
      `${PUMPFUN_BASE}/coins?sort=market_cap&order=DESC&limit=50&includeNsfw=false`,
      { timeout: 8000 }
    )
    return (res.data || [])
      .filter((coin) => {
        const mcap = coin.usd_market_cap || 0
        return mcap >= 50_000 && mcap <= 500_000
      })
      .slice(0, 10)
      .map((coin) => ({
        id:             coin.mint,
        symbol:         coin.symbol || '???',
        name:           coin.name   || 'Unknown',
        address:        coin.mint   || '',
        pairAddress:    coin.mint   || '',
        priceUsd:       coin.usd_market_cap
          ? String(coin.usd_market_cap / (coin.total_supply || 1e9))
          : '0',
        priceChange24h: 0,
        volume24h:      coin.volume || 0,
        marketCap:      coin.usd_market_cap || 0,
        liquidity:      coin.virtual_sol_reserves ? coin.virtual_sol_reserves * 150 : 0,
        logoUrl:        coin.image_uri || null,
        pairCreatedAt:  coin.created_timestamp || null,
        isHistorical:   false,
        isLegend:       false,
        isCooling:      false,
        coolingLabel:   null,
        source:         'pumpfun',
        dexUrl:         `https://pump.fun/${coin.mint}`,
      }))
  } catch (err) {
    console.warn('PumpFun graduating fetch failed:', err.message)
    return []
  }
}

// ─── Deduplicate by address ──────────────────────────────────────
const deduplicateAlphas = (alphas) => {
  const seen = new Map()
  alphas.forEach((alpha) => {
    if (!alpha.address) return
    if (!seen.has(alpha.address)) {
      seen.set(alpha.address, alpha)
    } else if ((alpha.volume24h || 0) > (seen.get(alpha.address).volume24h || 0)) {
      seen.set(alpha.address, alpha)
    }
  })
  return Array.from(seen.values())
}

// ─── CORE: Price action classifies fresh tokens ──────────────────
const classifyByPriceAction = (alphas) => {
  const live    = []
  const cooling = []

  alphas.forEach((alpha) => {
    if (isJunk(alpha)) return

    const change = parseFloat(alpha.priceChange24h) || 0
    const volume = alpha.volume24h || 0
    const mcap   = alpha.marketCap || 0

    // PumpFun graduating: no reliable 24h data, treat as Live if active
    if (alpha.source === 'pumpfun') {
      if (volume >= COOLING_MIN_VOLUME && mcap >= COOLING_MIN_MCAP) live.push(alpha)
      return
    }

    if (change > LIVE_MIN_CHANGE && volume >= LIVE_MIN_VOLUME) {
      live.push(alpha)
    } else if (change < 0 && volume >= COOLING_MIN_VOLUME && mcap >= COOLING_MIN_MCAP) {
      cooling.push({
        ...alpha,
        isCooling:    true,
        coolingLabel: `Down ${Math.abs(change).toFixed(1)}% — watching for reversal`,
      })
    }
  })

  return { live, cooling }
}

// ─── Momentum score ──────────────────────────────────────────────
const getMomentumScore = (alpha) => {
  const change      = parseFloat(alpha.priceChange24h) || 0
  const volume      = alpha.volume24h || 0
  const ageMs       = alpha.pairCreatedAt ? Date.now() - alpha.pairCreatedAt : null
  const ageScore    = ageMs ? Math.max(0, 1 - ageMs / (7 * 24 * 3600000)) : 0
  const volScore    = volume > 0 ? Math.min(1, Math.log10(volume) / 7) : 0
  const changeScore = Math.min(1, Math.max(0, change) / 500)
  return (changeScore * 0.5) + (volScore * 0.3) + (ageScore * 0.2)
}

// ─── Main hook ───────────────────────────────────────────────────
const useAlphas = () => {
  const [liveAlphas,    setLiveAlphas]    = useState([])
  const [coolingAlphas, setCoolingAlphas] = useState([])
  const [legends]                         = useState(LEGENDS)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [lastUpdated,   setLastUpdated]   = useState(null)

  const fetchLive = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const [boosted, profiles, pumpfun] = await Promise.allSettled([
        fetchBoostedAlphas(),
        fetchProfileAlphas(),
        fetchPumpFunGraduating(),
      ])

      const freshRaw = deduplicateAlphas([
        ...(boosted.status  === 'fulfilled' ? boosted.value  : []),
        ...(profiles.status === 'fulfilled' ? profiles.value : []),
        ...(pumpfun.status  === 'fulfilled' ? pumpfun.value  : []),
      ])

      // Save everything to localStorage before classifying
      saveToHistory(freshRaw)

      // Classify fresh tokens by price action
      const { live: freshLive, cooling: freshCooling } = classifyByPriceAction(freshRaw)

      // Load historical tokens not in current fetch
      // Split by their last-known price action — same rule applies
      const currentAddresses = new Set(freshRaw.map(a => a.address))
      const { historicalLive, historicalCooling } = loadHistoricalByPriceAction(currentAddresses)

      // Merge fresh + historical, deduplicate
      const freshLiveAddresses    = new Set(freshLive.map(a => a.address))
      const freshCoolingAddresses = new Set(freshCooling.map(a => a.address))

      const allLive = [
        ...freshLive,
        ...historicalLive.filter(a => !freshLiveAddresses.has(a.address)),
      ]
      const allCooling = [
        ...freshCooling,
        ...historicalCooling.filter(a => !freshCoolingAddresses.has(a.address)),
      ]

      // Sort Live by momentum, Cooling by biggest drop first
      const sortedLive = allLive
        .map(a => ({ ...a, momentumScore: getMomentumScore(a) }))
        .sort((a, b) => b.momentumScore - a.momentumScore)
        .slice(0, 40)

      const sortedCooling = allCooling
        .sort((a, b) => (parseFloat(a.priceChange24h) || 0) - (parseFloat(b.priceChange24h) || 0))
        .slice(0, 30)

      if (sortedLive.length === 0) {
        setError('No live runners detected. Trenches might be cooked.')
      }

      setLiveAlphas(sortedLive)
      setCoolingAlphas(sortedCooling)
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Alpha feed failed:', err.message)
      setError('Feed unavailable. Check connection.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Load from storage immediately before first fetch completes
    const { historicalLive, historicalCooling } = loadHistoricalByPriceAction(new Set())
    setLiveAlphas(historicalLive)
    setCoolingAlphas(historicalCooling)
    fetchLive()
  }, [fetchLive])

  useEffect(() => {
    const interval = setInterval(fetchLive, 60_000)
    return () => clearInterval(interval)
  }, [fetchLive])

  return {
    liveAlphas,
    coolingAlphas,
    legends,
    loading,
    error,
    lastUpdated,
    refresh: fetchLive,
  }
}

export default useAlphas