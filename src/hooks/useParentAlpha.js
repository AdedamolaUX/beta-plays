import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'

// ─── Edit Distance (Levenshtein) ─────────────────────────────────
// Measures how many character changes separate two strings.
// PIPPKIN vs PIPPIN = 1 change = very likely related.
// PIPPKIN vs BONK = 6 changes = unrelated.
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

// ─── Similarity score 0-1 ────────────────────────────────────────
const similarity = (a, b) => {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - editDistance(a.toUpperCase(), b.toUpperCase()) / maxLen
}

// ─── Generate search queries from runner symbol ──────────────────
// Strategy: search with progressively shorter prefixes of the symbol
// so "PIPPKIN" generates queries: "PIPPK", "PIPP", "PIPP", "PIP"
// DEXScreener substring search will surface "PIPPIN" for "PIPP"
export const extractRootCandidates = (symbol) => {
  const s = symbol.toUpperCase()
  const candidates = new Set()

  // Progressively shorter prefixes (min 3 chars)
  for (let len = s.length - 1; len >= 3; len--) {
    candidates.add(s.slice(0, len))
  }

  // Also try stripping known suffixes for direct ticker matches
  const STRIP_SUFFIXES = [
    'KIN', 'KY', 'LY', 'ISH', 'INU', 'WIF', 'HAT', 'CAT',
    'DOG', 'AI', 'DAO', 'MOON', 'PUMP', 'WIFHAT',
  ]
  STRIP_SUFFIXES.forEach((suffix) => {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      candidates.add(s.slice(0, s.length - suffix.length))
    }
  })

  // Strip known prefixes
  const STRIP_PREFIXES = [
    'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
    'REAL', 'OG', 'TURBO', 'CHAD', 'FAT', 'TINY',
  ]
  STRIP_PREFIXES.forEach((prefix) => {
    if (s.startsWith(prefix) && s.length > prefix.length + 2) {
      candidates.add(s.slice(prefix.length))
    }
  })

  candidates.delete(s)
  return Array.from(candidates)
}

// ─── Format parent ───────────────────────────────────────────────
const formatParent = (pair) => ({
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
  dexUrl: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
})

// ─── Main hook ───────────────────────────────────────────────────
const useParentAlpha = (alpha) => {
  const [parent, setParent] = useState(null)
  const [loading, setLoading] = useState(false)

  const findParent = useCallback(async () => {
    if (!alpha || alpha.isSzn) { setParent(null); return }

    setLoading(true)
    setParent(null)

    // Only search with a few distinct prefix lengths to avoid hammering API
    const symbol = alpha.symbol.toUpperCase()
    const queries = new Set()

    // Take prefix slices of 3, 4, 5 chars max — enough to find parent
    for (let len = Math.min(symbol.length - 1, 6); len >= 3; len--) {
      queries.add(symbol.slice(0, len))
    }

    // Also strip known suffixes for exact ticker match
    const STRIP_SUFFIXES = ['KIN', 'KY', 'LY', 'ISH', 'INU', 'WIF', 'HAT', 'CAT', 'DOG']
    STRIP_SUFFIXES.forEach((suffix) => {
      if (symbol.endsWith(suffix) && symbol.length > suffix.length + 2) {
        queries.add(symbol.slice(0, symbol.length - suffix.length))
      }
    })

    try {
      const searches = await Promise.allSettled(
        Array.from(queries).slice(0, 5).map((q) =>
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
            (p.liquidity?.usd || 0) > 10000 &&
            p.baseToken?.address !== alpha.address &&
            p.baseToken?.symbol?.toUpperCase() !== symbol
          )
          .forEach((p) => {
            const candidateSymbol = p.baseToken?.symbol?.toUpperCase() || ''

            // Score by similarity — higher = more likely parent
            const sim = similarity(symbol, candidateSymbol)

            // Must be at least 60% similar to be considered a parent
            // This prevents totally unrelated high-mcap tokens from matching
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