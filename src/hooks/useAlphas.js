import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import LEGENDS from '../data/historical_alphas'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'

// ─── localStorage keys ───────────────────────────────────────────
const STORAGE_KEY = 'betaplays_seen_alphas'
const COOLING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ─── Persist alphas to localStorage ─────────────────────────────
// Every time a token appears in Live, we record it with a timestamp.
// When it falls out of Live, it becomes a Cooling candidate.

const saveToHistory = (alphas) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now = Date.now()
    alphas.forEach((alpha) => {
      if (!alpha.address) return
      // Update or create entry — always refresh lastSeen
      existing[alpha.address] = {
        ...alpha,
        firstSeen: existing[alpha.address]?.firstSeen || now,
        lastSeen: now,
      }
    })
    // Prune entries older than 30 days
    Object.keys(existing).forEach((addr) => {
      if (now - existing[addr].lastSeen > COOLING_MAX_AGE_MS) {
        delete existing[addr]
      }
    })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
  } catch (err) {
    console.warn('Failed to save alphas to history:', err.message)
  }
}

// ─── Load cooling alphas from localStorage ───────────────────────
// Cooling = was seen in Live, but NOT in current Live feed,
// and was last seen within the last 30 days.

const loadCoolingAlphas = (liveAlphas) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now = Date.now()
    const liveAddresses = new Set(liveAlphas.map((a) => a.address))

    return Object.values(existing)
      .filter((alpha) => {
        const age = now - alpha.lastSeen
        const isStillLive = liveAddresses.has(alpha.address)
        return !isStillLive && age <= COOLING_MAX_AGE_MS
      })
      .map((alpha) => ({
        ...alpha,
        isCooling: true,
        coolingAge: Date.now() - alpha.lastSeen,
        coolingLabel: getCoolingLabel(Date.now() - alpha.lastSeen),
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen) // Most recently cooled first
  } catch (err) {
    console.warn('Failed to load cooling alphas:', err.message)
    return []
  }
}

const getCoolingLabel = (ageMs) => {
  const hours = ageMs / 3600000
  const days = ageMs / 86400000
  if (hours < 1)  return 'Cooled <1h ago'
  if (hours < 24) return `Cooled ${Math.floor(hours)}h ago`
  if (days < 7)   return `Cooled ${Math.floor(days)}d ago`
  return `Cooled ${Math.floor(days)}d ago`
}

// ─── Format DEXScreener pair as alpha ───────────────────────────
const formatAlpha = (pair) => ({
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
  pairCreatedAt: pair.pairCreatedAt || null,
  isHistorical: false,
  isLegend: false,
  dexUrl: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
})

// ─── Main hook ───────────────────────────────────────────────────
const useAlphas = () => {
  const [liveAlphas,    setLiveAlphas]    = useState([])
  const [coolingAlphas, setCoolingAlphas] = useState([])
  const [legends,       setLegends]       = useState(LEGENDS)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [lastUpdated,   setLastUpdated]   = useState(null)

  const fetchLive = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/token-boosts/top/v1`, {
        timeout: 10000,
      })

      const boosts = res.data || []
      const solanaBoosts = boosts.filter((b) => b.chainId === 'solana').slice(0, 20)

      if (solanaBoosts.length === 0) {
        setError('No live runners detected. Trenches might be cooked.')
        setLoading(false)
        return
      }

      // Fetch pair data for each boosted token
      const pairResults = await Promise.allSettled(
        solanaBoosts.map((boost) =>
          axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${boost.tokenAddress}`)
        )
      )

      const alphas = []
      pairResults.forEach((result) => {
        if (result.status !== 'fulfilled') return
        const pairs = result.value.data?.pairs || []
        const best = pairs
          .filter((p) => p.chainId === 'solana')
          .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]
        if (best) alphas.push(formatAlpha(best))
      })

      const sorted = alphas.sort(
        (a, b) => (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
      )

      // Save to localStorage before setting state
      saveToHistory(sorted)

      setLiveAlphas(sorted)
      setCoolingAlphas(loadCoolingAlphas(sorted))
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Failed to fetch live alphas:', err.message)
      setError('Feed unavailable. Check connection.')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    // Load cooling from storage immediately (before network)
    setCoolingAlphas(loadCoolingAlphas([]))
    fetchLive()
  }, [fetchLive])

  // Auto-refresh every 60s
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