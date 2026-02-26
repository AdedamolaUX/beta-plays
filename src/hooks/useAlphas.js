import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import LEGENDS from '../data/historical_alphas'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const PUMPFUN_BASE     = 'https://frontend-api.pump.fun'

// ─── localStorage ────────────────────────────────────────────────
const STORAGE_KEY        = 'betaplays_seen_alphas'
const COOLING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const saveToHistory = (alphas) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now = Date.now()
    alphas.forEach((alpha) => {
      if (!alpha.address) return
      existing[alpha.address] = {
        ...alpha,
        firstSeen: existing[alpha.address]?.firstSeen || now,
        lastSeen: now,
      }
    })
    Object.keys(existing).forEach((addr) => {
      if (now - existing[addr].lastSeen > COOLING_MAX_AGE_MS) delete existing[addr]
    })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
  } catch (err) {
    console.warn('Failed to save alphas:', err.message)
  }
}

const getCoolingLabel = (ageMs) => {
  const hours = ageMs / 3600000
  const days  = ageMs / 86400000
  if (hours < 1)  return 'Cooled <1h ago'
  if (hours < 24) return `Cooled ${Math.floor(hours)}h ago`
  return `Cooled ${Math.floor(days)}d ago`
}

const loadCoolingAlphas = (liveAlphas) => {
  try {
    const existing     = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now          = Date.now()
    const liveAddresses = new Set(liveAlphas.map((a) => a.address))
    return Object.values(existing)
      .filter((a) => !liveAddresses.has(a.address) && now - a.lastSeen <= COOLING_MAX_AGE_MS)
      .map((a) => ({
        ...a,
        isCooling: true,
        coolingAge: now - a.lastSeen,
        coolingLabel: getCoolingLabel(now - a.lastSeen),
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  } catch (err) {
    return []
  }
}

// ─── Format pair → alpha ─────────────────────────────────────────
const formatAlpha = (pair, source = 'boost') => ({
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
  isHistorical:  false,
  isLegend:      false,
  source,
  dexUrl: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
})

// ─── Composite momentum score ────────────────────────────────────
// Ranks tokens by gain, volume, and freshness combined.
// This is what makes organic runners float above paid boosts.
const getMomentumScore = (alpha, index, total) => {
  const change   = parseFloat(alpha.priceChange24h) || 0
  const volume   = alpha.volume24h || 0
  const ageMs    = alpha.pairCreatedAt ? Date.now() - alpha.pairCreatedAt : null
  const ageScore = ageMs
    ? Math.max(0, 1 - ageMs / (7 * 24 * 3600000)) // Higher score for newer tokens
    : 0

  // Normalise volume to a 0-1 score (log scale)
  const volScore = volume > 0 ? Math.min(1, Math.log10(volume) / 7) : 0

  // Change score: 0-500% maps to 0-1
  const changeScore = Math.min(1, Math.max(0, change) / 500)

  return (changeScore * 0.5) + (volScore * 0.3) + (ageScore * 0.2)
}

// ─── Source 1: DEXScreener boosted tokens ───────────────────────
const fetchBoostedAlphas = async () => {
  try {
    const res = await axios.get(`${DEXSCREENER_BASE}/token-boosts/top/v1`, { timeout: 10000 })
    const boosts = (res.data || []).filter((b) => b.chainId === 'solana').slice(0, 15)
    if (boosts.length === 0) return []

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
// Tokens where devs just updated their profile = active projects
const fetchProfileAlphas = async () => {
  try {
    const res = await axios.get(`${DEXSCREENER_BASE}/token-profiles/latest/v1`, { timeout: 10000 })
    const profiles = (res.data || []).filter((b) => b.chainId === 'solana').slice(0, 15)
    if (profiles.length === 0) return []

    const pairResults = await Promise.allSettled(
      profiles.map((b) => axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${b.tokenAddress}`))
    )

    const alphas = []
    pairResults.forEach((result) => {
      if (result.status !== 'fulfilled') return
      const pairs = result.value.data?.pairs || []
      const best  = pairs
        .filter((p) =>
          p.chainId === 'solana' &&
          (p.volume?.h24 || 0) > 50_000 &&       // Must have real volume
          (parseFloat(p.priceChange?.h24) || 0) > 20  // Must be gaining
        )
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]
      if (best) alphas.push(formatAlpha(best, 'profile'))
    })
    return alphas
  } catch (err) {
    console.warn('Profile fetch failed:', err.message)
    return []
  }
}

// ─── Source 3: PumpFun graduating tokens ─────────────────────────
// Tokens near or past the $69K graduation threshold = organic breakouts
const fetchPumpFunGraduating = async () => {
  try {
    const res = await axios.get(
      `${PUMPFUN_BASE}/coins?sort=market_cap&order=DESC&limit=50&includeNsfw=false`,
      { timeout: 8000 }
    )
    const coins = res.data || []

    return coins
      .filter((coin) => {
        const mcap = coin.usd_market_cap || 0
        // Near graduation ($50K-$150K) or recently graduated
        return mcap >= 50_000 && mcap <= 500_000
      })
      .slice(0, 10)
      .map((coin) => ({
        id:            coin.mint,
        symbol:        coin.symbol || '???',
        name:          coin.name   || 'Unknown',
        address:       coin.mint   || '',
        pairAddress:   coin.mint   || '',
        priceUsd:      coin.usd_market_cap
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
    } else {
      // Keep the one with higher volume
      const existing = seen.get(alpha.address)
      if ((alpha.volume24h || 0) > (existing.volume24h || 0)) {
        seen.set(alpha.address, alpha)
      }
    }
  })
  return Array.from(seen.values())
}

// ─── Filter junk ────────────────────────────────────────────────
const JUNK_SYMBOLS = new Set(['SOL', 'USDC', 'USDT', 'WSOL', 'BTC', 'ETH', 'WBTC'])

const filterJunk = (alphas) =>
  alphas.filter((a) =>
    !JUNK_SYMBOLS.has(a.symbol.toUpperCase()) &&
    (a.marketCap || 0) > 0
  )

// ─── Main hook ───────────────────────────────────────────────────
const useAlphas = () => {
  const [liveAlphas,    setLiveAlphas]    = useState([])
  const [coolingAlphas, setCoolingAlphas] = useState([])
  const [legends]                         = useState(LEGENDS)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [lastUpdated,   setLastUpdated]   = useState(null)
  const [sourceStats,   setSourceStats]   = useState({})

  const fetchLive = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      // Fetch all three sources in parallel
      const [boosted, profiles, pumpfun] = await Promise.allSettled([
        fetchBoostedAlphas(),
        fetchProfileAlphas(),
        fetchPumpFunGraduating(),
      ])

      const boostedAlphas  = boosted.status  === 'fulfilled' ? boosted.value  : []
      const profileAlphas  = profiles.status === 'fulfilled' ? profiles.value : []
      const pumpfunAlphas  = pumpfun.status  === 'fulfilled' ? pumpfun.value  : []

      setSourceStats({
        boost:   boostedAlphas.length,
        profile: profileAlphas.length,
        pumpfun: pumpfunAlphas.length,
      })

      // Merge, dedupe, filter junk
      const allAlphas = deduplicateAlphas(
        filterJunk([...boostedAlphas, ...profileAlphas, ...pumpfunAlphas])
      )

      if (allAlphas.length === 0) {
        setError('No live runners detected. Trenches might be cooked.')
        setLoading(false)
        return
      }

      // Sort by composite momentum score
      const sorted = allAlphas
        .map((alpha, i, arr) => ({
          ...alpha,
          momentumScore: getMomentumScore(alpha, i, arr.length),
        }))
        .sort((a, b) => b.momentumScore - a.momentumScore)
        .slice(0, 25)

      saveToHistory(sorted)
      setLiveAlphas(sorted)
      setCoolingAlphas(loadCoolingAlphas(sorted))
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Alpha feed failed:', err.message)
      setError('Feed unavailable. Check connection.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setCoolingAlphas(loadCoolingAlphas([]))
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
    sourceStats,
    refresh: fetchLive,
  }
}

export default useAlphas