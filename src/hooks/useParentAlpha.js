import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const STORAGE_KEY      = 'betaplays_seen_alphas'

// ─── Save parent to localStorage ────────────────────────────────
// Save ALL detected parents unconditionally.
// loadHistoricalByPriceAction in useAlphas.js will classify them:
// positive 24h → surfaces in Live
// negative 24h → surfaces in Cooling
// This means $PIPPIN at +9.4% shows in Live, $Aliens at -44% shows in Cooling.
// No special cases needed — the existing classifier handles it.
const saveParentToHistory = (parent, derivative) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now      = Date.now()

    existing[parent.address] = {
      ...parent,
      firstSeen:     existing[parent.address]?.firstSeen || now,
      lastSeen:      now,
      coolingReason: `Parent of $${derivative.symbol}`,
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))

    const change = parseFloat(parent.priceChange24h) || 0
    console.log(
      `[ParentDetected] $${parent.symbol} ${change >= 0 ? '→ Live' : '→ Cooling'} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%) via $${derivative.symbol}`
    )
  } catch (err) {
    console.warn('Failed to save parent to history:', err.message)
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

  // Exact match
  if (a === b) return 1.0

  // b is a prefix of a (PIPPIN is a prefix of PIPPINS) → strong signal
  if (a.startsWith(b) && b.length >= 3) {
    const coverage = b.length / a.length
    return 0.75 + (coverage * 0.2)
  }

  // a is a prefix of b (ALIEN is prefix of ALIENSCOPE) → strong signal
  if (b.startsWith(a) && a.length >= 3) return 0.80

  // Shared prefix — handles PIPPIKO ↔ PIPPIN (both start with PIPPI)
  // If the two strings share 80%+ of the shorter string as a prefix, it's a match
  const shorter  = a.length <= b.length ? a : b
  const longer   = a.length <= b.length ? b : a
  let sharedLen  = 0
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) sharedLen++
    else break
  }
  if (sharedLen >= 4 && sharedLen / shorter.length >= 0.75) {
    return 0.65 + (sharedLen / shorter.length) * 0.15
  }

  // Edit distance fallback
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - editDistance(a, b) / maxLen
}

// ─── Compound ticker decomposition ──────────────────────────────
// ALIENSCOPE → ['ALIEN', 'SCOPE']
// WIFHAT     → ['WIF', 'HAT']
// TRUMPCAT   → ['TRUMP', 'CAT']
// PIPPKIN    → ['PIPP', 'PIPPIN' prefix slices...]
const STRIP_SUFFIXES = [
  'SCOPE', 'COIN', 'TOKEN', 'SWAP', 'PLAY', 'GAME',
  'KIN', 'KY', 'LY', 'ISH', 'INU', 'WIF', 'HAT', 'CAT',
  'DOG', 'AI', 'DAO', 'MOON', 'PUMP', 'WIFHAT',
]
const STRIP_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
  'REAL', 'OG', 'TURBO', 'CHAD', 'FAT', 'TINY',
  'MEAN', 'DARK', 'EVIL', 'BASED', 'LITTLE', 'BIG',
  'GOOD', 'BAD', 'MAD', 'SAD', 'GLAD', 'WILD',
  'HOLY', 'DEGEN', 'ALPHA', 'BASED', 'PURE',
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

  // CamelCase split: AlienScope → ALIEN, SCOPE
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

    // ── Name-based queries ───────────────────────────────────────
    // Token name often reveals the parent when the symbol doesn't.
    // "Dark Pippin" → symbol DIPPIN → name gives us "Pippin"
    // "Ghost Pikachu" → symbol PEAKYCHU → name gives us "Pikachu"
    const NAME_STOP = new Set(['the', 'a', 'an', 'of', 'dark', 'evil', 'mean',
      'baby', 'mini', 'based', 'super', 'real', 'og', 'little', 'big', 'bad',
      'mad', 'wild', 'holy', 'ghost', 'shadow', 'alter', 'turbo', 'chad', 'fat'])

    if (alpha.name) {
      alpha.name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !NAME_STOP.has(w))
        .forEach(w => queries.add(w.toUpperCase()))
    }

    // ── Description-based queries ────────────────────────────────
    // "the alter ego of pippin" → extract "pippin"
    // "ghost pikachu. first new pikachu variant" → extract "pikachu"
    // We specifically look for $ prefixed tickers AND significant nouns
    if (alpha.description) {
      // Dollar-sign tickers are the strongest signal: "alter ego of $PIPPIN"
      const tickerMatches = alpha.description.match(/\$([A-Z]{2,12})/gi) || []
      tickerMatches.forEach(t => queries.add(t.replace('$', '').toUpperCase()))

      // Also extract meaningful words from description
      alpha.description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 5 && !NAME_STOP.has(w))
        .slice(0, 4)  // Only top 4 — avoid noise
        .forEach(w => queries.add(w.toUpperCase()))
    }

    if (queries.size === 0) { setLoading(false); return }

    try {
      const searches = await Promise.allSettled(
        Array.from(queries).slice(0, 10).map((q) =>
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
            (p.marketCap || p.fdv || 0) > (alpha.marketCap || 0) * 0.5 && // relaxed: parent can be as small as 50% of alpha
            (p.liquidity?.usd || 0) > 5_000 &&
            p.baseToken?.address !== alpha.address &&
            p.baseToken?.symbol?.toUpperCase() !== symbol
          )
          .forEach((p) => {
            const candidateSymbol = p.baseToken?.symbol?.toUpperCase() || ''
            const candidateName   = p.baseToken?.name?.toUpperCase()   || ''
            const sim = Math.max(
              similarity(symbol, candidateSymbol),
              // Also score against name — catches DIPPIN vs PIPPIN via "Pippin" name
              similarity(symbol, candidateName.split(/\s+/).find(w => w.length >= 4) || ''),
            )

            if (sim >= 0.65 && sim > bestScore) {
              bestScore = sim
              bestMatch = p
            }
          })
      })

      const foundParent = bestMatch ? formatParent(bestMatch) : null
      setParent(foundParent)

      // ── Save parent to localStorage unconditionally ──────────────
      // Positive parent → will appear in Live via loadHistoricalByPriceAction
      // Negative parent → will appear in Cooling via loadHistoricalByPriceAction
      // The classifier in useAlphas.js handles placement, not this hook
      if (foundParent) {
        saveParentToHistory(foundParent, alpha)
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