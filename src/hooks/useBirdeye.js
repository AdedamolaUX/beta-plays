// ─── Birdeye API Integration ──────────────────────────────────────
// All Birdeye calls go through the backend proxy at /api/birdeye.
// The API key NEVER touches the frontend — it lives in server/.env.
//
// Local dev:  calls http://localhost:3001/api/birdeye
// Production: calls https://your-render-url.onrender.com/api/birdeye
//
// To configure:
//   1. Add BIRDEYE_API_KEY=your_key to server/.env
//   2. Add BIRDEYE_API_KEY to your Render/Railway env vars
//   No frontend .env changes needed.

import { useState, useEffect } from 'react'

// ── Backend URL ───────────────────────────────────────────────────
// Same pattern already used by useAIBetaScoring.js
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map()

// ─── Fetch via backend proxy ──────────────────────────────────────
const fetchBirdeye = async (endpoint, address) => {
  const key    = `${endpoint}:${address}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/birdeye?endpoint=${endpoint}&address=${address}`
    )
    if (!res.ok) throw new Error(`Birdeye proxy ${res.status}`)
    const json = await res.json()
    const data = json?.data || json || null
    if (data) cache.set(key, { data, ts: Date.now() })
    return data
  } catch (err) {
    console.warn(`[Birdeye] ${endpoint} failed for ${address}:`, err.message)
    return null
  }
}

// ─── Concentration risk ───────────────────────────────────────────
const DEX_ADDRESSES = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
])

const getConcentrationRisk = (holders) => {
  if (!holders?.items?.length) return null
  const real     = holders.items.filter(h => !DEX_ADDRESSES.has(h.owner))
  const top10Pct = real.slice(0, 10).reduce((sum, h) => sum + (h.percentage || 0), 0)
  const top3Pct  = real.slice(0, 3).reduce((sum, h) => sum + (h.percentage || 0), 0)
  return {
    top10Pct:  Math.round(top10Pct * 100) / 100,
    top3Pct:   Math.round(top3Pct * 100) / 100,
    risk:      top10Pct > 50 ? 'HIGH' : top10Pct > 30 ? 'MED' : 'LOW',
    riskColor: top10Pct > 50 ? 'var(--red)' : top10Pct > 30 ? 'var(--amber)' : 'var(--neon-green)',
  }
}

// ─── Main hook ────────────────────────────────────────────────────
const useBirdeye = (address) => {
  const [birdeye, setBirdeye] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!address) { setBirdeye(null); return }

    let cancelled = false
    setLoading(true)

    Promise.all([
      fetchBirdeye('token_overview', address),
      fetchBirdeye('holders', address),
    ]).then(([overview, holders]) => {
      if (cancelled) return

      const concentration = getConcentrationRisk(holders)

      setBirdeye({
        hasData:      true,
        change7d:     overview?.priceChange7dPercent  ?? overview?.price7dChangePercent  ?? null,
        change30d:    overview?.priceChange30dPercent ?? overview?.price30dChangePercent ?? null,
        volume7d:     overview?.v7dUSD ?? null,
        tradeCount24h: overview?.trade24h ?? null,
        buyCount24h:  overview?.buy24h   ?? null,
        sellCount24h: overview?.sell24h  ?? null,
        buyRatio:     overview?.buy24h && overview?.sell24h
          ? overview.buy24h / (overview.buy24h + overview.sell24h)
          : null,
        holderCount:  holders?.total ?? overview?.holder ?? null,
        concentration,
        uniqueMakers: overview?.uniqueWallet24h ?? null,
        priceUsd:     overview?.price ?? null,
        mcap:         overview?.mc    ?? null,
      })
    }).catch(err => {
      if (!cancelled) {
        console.warn('[Birdeye] Hook failed:', err.message)
        setBirdeye({ hasData: false })
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [address])

  return { birdeye, loading }
}

export default useBirdeye