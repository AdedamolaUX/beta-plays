import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const STORAGE_KEY      = 'betaplays_seen_alphas'

// ─── Write parent to localStorage cooling pool ───────────────────
// Called when: derivative is pumping AND parent is down.
// This is proactive cooling — the parent didn't need to fall out of
// the Live feed naturally. We detected the setup and surfaced it.
const saveParentAsCooling = (parent, derivative) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now      = Date.now()
    const change   = parseFloat(parent.priceChange24h) || 0

    // Only write if parent is genuinely negative
    if (change >= 0) return

    existing[parent.address] = {
      ...parent,
      firstSeen:    existing[parent.address]?.firstSeen || now,
      lastSeen:     now,
      isCooling:    true,
      // Label surfaces the narrative context — not internal mechanism
      coolingLabel: `Down ${Math.abs(change).toFixed(1)}% — watching for reversal`,
      // Tag so we know why it's here
      coolingReason: `Derivative $${derivative.symbol} running while parent consolidates`,
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
    console.log(`[ProactiveCooling] $${parent.symbol} added — $${derivative.symbol} running while parent is down ${Math.abs(change).toFixed(1)}%`)
  } catch (err) {
    console.warn('Failed to save parent to cooling:', err.message)
  }
}

// ─── Edit Distance ───────────────────────────────────────────────
const editDistance = (a, b) => {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

// ─── Similarity scoring ──────────────────────────────────────────
// Prefix match: ALIEN is prefix of ALIENSCOPE → 0.95
// Reverse prefix: ALIENSCOPE starts in ALIEN → 0.80
// Edit distance fallback for close tickers like PIPPIN/PIPPKIN
const similarity = (runner, candidate) => {
  const a = runner.toUpperCase()
  const b = candidate.toUpperCase()

  if (a.startsWith(b) && b.length >= 3) {
    const coverage = b.length / a.length
    return 0.75 + (coverage * 0.2)
  }

  if (b.startsWith(a) && a.length >= 3) return 0.80

  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - editDistance(a, b) / maxLen
}

// ─── Compound ticker decomposition ──────────────────────────────
// ALIENSCOPE → ['ALIEN', 'SCOPE', 'ALIENS']
// WIFHAT     → ['WIF', 'HAT']
// TRUMPCAT   → ['TRUMP', 'CAT']
const STRIP_SUFFIXES = [
  'SCOPE', 'COIN', 'TOKEN', 'SWAP', 'PLAY', 'GAME',
  'KIN', 'KY', 'LY', 'ISH', 'INU', 'WIF', 'HAT', 'CAT',
  'DOG', 'AI', 'DAO', 'MOON', 'PUMP', 'WIFHAT',
]
const STRIP_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
  'REAL', 'OG', 'TURBO', 'CHAD', 'FAT', 'TINY',
]

export const extractRootCandidates = (symbol) => {
  const s     = symbol.toUpperCase()
  const parts = new Set()

  // Prefix slices (min 4 chars)
  for (let len = Math.min(s.length - 1, 8); len >= 4; len--) {
    parts.add(s.slice(0, len))
  }

  STRIP_SUFFIXES.forEach((suffix) => {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      parts.add(s.slice(0, s.length - suffix.length))
    }
  })

  STRIP_PREFIXES.forEach((prefix) => {
    if (s.startsWith(prefix) && s.length > prefix.length + 2) {
      parts.add(s.slice(prefix.length))
    }
  })

  // CamelCase split
  const camelParts = symbol
    .replace(/([A-Z][a-z]+)/g, ' $1')
    .replace(/([A-Z]+)(?=[A-Z][a-z])/g, ' $1')
    .trim().split(/\s+/)
    .filter(p => p.length >= 3)
  camelParts.forEach(p => parts.add(p.toUpperCase()))

  parts.delete(s)
  return Array.from(parts)
}

// ─── Format parent ───────────────────────────────────────────────
const formatParent = (pair) => ({
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
  dexUrl:         pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
})

// ─── Main hook ───────────────────────────────────────────────────
const useParentAlpha = (alpha) => {
  const [parent,  setParent]  = useState(null)
  const [loading, setLoading] = useState(false)

  const findParent = useCallback(async () => {
    if (!alpha || alpha.isSzn) { setParent(null); return }

    setLoading(true)
    setParent(null)

    const symbol  = alpha.symbol.toUpperCase()
    const queries = new Set(extractRootCandidates(symbol))

    if (queries.size === 0) { setLoading(false); return }

    try {
      const searches = await Promise.allSettled(
        Array.from(queries).slice(0, 6).map((q) =>
          axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${q}`)
        )
      )

      let bestMatch = null
      let bestScore = 0

      searches.forEach((result) => {
        if (result.status !== 'fulfilled') return
        const pairs = result.value.data?.pairs || []

        pairs
          .filter((p) =>
            p.chainId === 'solana' &&
            (p.marketCap || p.fdv || 0) > (alpha.marketCap || 0) &&
            (p.liquidity?.usd || 0) > 10_000 &&
            p.baseToken?.address !== alpha.address &&
            p.baseToken?.symbol?.toUpperCase() !== symbol
          )
          .forEach((p) => {
            const candidateSymbol = p.baseToken?.symbol?.toUpperCase() || ''
            const sim = similarity(symbol, candidateSymbol)

            if (sim >= 0.75 && sim > bestScore) {
              bestScore = sim
              bestMatch = p
            }
          })
      })

      const foundParent = bestMatch ? formatParent(bestMatch) : null
      setParent(foundParent)

      // ── Proactive Cooling ────────────────────────────────────────
      // If the derivative (alpha) is pumping AND the parent is down,
      // write the parent to localStorage cooling immediately.
      // It will surface in the Cooling tab on the next render cycle.
      if (foundParent) {
        const derivativeChange = parseFloat(alpha.priceChange24h) || 0
        const parentChange     = parseFloat(foundParent.priceChange24h) || 0

        if (derivativeChange > 0 && parentChange < 0) {
          saveParentAsCooling(foundParent, alpha)
        }
      }

    } catch (err) {
      console.warn('Parent alpha lookup failed:', err.message)
      setParent(null)
    } finally {
      setLoading(false)
    }
  }, [alpha?.id])

  useEffect(() => { findParent() }, [findParent])

  return { parent, loading }
}

export default useParentAlpha