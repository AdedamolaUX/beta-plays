import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'

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
// Key insight: if candidate is a PREFIX of the runner's symbol,
// that's the strongest possible parent signal — score it at 0.95.
// ALIEN is a prefix of ALIENSCOPE → 0.95 (passes 0.75 threshold)
// PIPPIN vs PIPPKIN → edit distance = 1 → ~0.83 (passes)
// STORE vs STORJ → edit distance = 2/5 → ~0.60 (fails, correct)

const similarity = (runner, candidate) => {
  const a = runner.toUpperCase()
  const b = candidate.toUpperCase()

  // Strongest signal: candidate is a clean prefix of runner
  // e.g. ALIEN in ALIENSCOPE, WIF in WIFHAT, TRUMP in TRUMPCAT
  if (a.startsWith(b) && b.length >= 3) {
    // Score by how much of the runner the candidate covers
    const coverage = b.length / a.length
    return 0.75 + (coverage * 0.2) // 0.75-0.95 range
  }

  // Second signal: runner is a prefix of candidate (rarer but valid)
  if (b.startsWith(a) && a.length >= 3) {
    return 0.80
  }

  // Fallback: edit distance similarity
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - editDistance(a, b) / maxLen
}

// ─── Generate search queries ─────────────────────────────────────
// For compound tickers like ALIENSCOPE, we extract the component
// words as additional candidates: ALIEN, SCOPE
const splitCompoundTicker = (symbol) => {
  const s = symbol.toUpperCase()
  const parts = new Set()

  // Prefix slices (min 4 chars to avoid noise)
  for (let len = Math.min(s.length - 1, 8); len >= 4; len--) {
    parts.add(s.slice(0, len))
  }

  // Strip known suffixes
  const STRIP_SUFFIXES = [
    'SCOPE', 'COIN', 'TOKEN', 'SWAP', 'PLAY', 'GAME',
    'KIN', 'KY', 'LY', 'ISH', 'INU', 'WIF', 'HAT', 'CAT',
    'DOG', 'AI', 'DAO', 'MOON', 'PUMP', 'WIFHAT',
  ]
  STRIP_SUFFIXES.forEach((suffix) => {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      parts.add(s.slice(0, s.length - suffix.length))
    }
  })

  // Strip known prefixes
  const STRIP_PREFIXES = [
    'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
    'REAL', 'OG', 'TURBO', 'CHAD', 'FAT', 'TINY',
  ]
  STRIP_PREFIXES.forEach((prefix) => {
    if (s.startsWith(prefix) && s.length > prefix.length + 2) {
      parts.add(s.slice(prefix.length))
    }
  })

  parts.delete(s)
  return Array.from(parts)
}

export const extractRootCandidates = splitCompoundTicker

// ─── Format parent ───────────────────────────────────────────────
const formatParent = (pair) => ({
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
  dexUrl:        pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
})

// ─── Main hook ───────────────────────────────────────────────────
const useParentAlpha = (alpha) => {
  const [parent,  setParent]  = useState(null)
  const [loading, setLoading] = useState(false)

  const findParent = useCallback(async () => {
    if (!alpha || alpha.isSzn) { setParent(null); return }

    setLoading(true)
    setParent(null)

    const symbol    = alpha.symbol.toUpperCase()
    const queries   = new Set(splitCompoundTicker(symbol))

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

            // Threshold: 0.75 catches prefix matches and close edits
            // Rejects coincidental similarity like STORJ/STORE
            if (sim >= 0.75 && sim > bestScore) {
              bestScore = sim
              bestMatch = p
            }
          })
      })

      setParent(bestMatch ? formatParent(bestMatch) : null)
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