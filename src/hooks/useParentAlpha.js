import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const STORAGE_KEY      = 'betaplays_seen_alphas'

// ─── Save parent to localStorage ─────────────────────────────────
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
      `[ParentDetected] $${parent.symbol} ${change >= 0 ? '→ Live' : '→ Cooling'} ` +
      `(${change >= 0 ? '+' : ''}${change.toFixed(1)}%) via $${derivative.symbol}`
    )
  } catch (err) {
    console.warn('Failed to save parent to history:', err.message)
  }
}

// ─── Fetch token description from DEXScreener ────────────────────
// useParentAlpha runs before useBetas, so alpha.description is often
// empty at this point (descriptions come from token profiles, not
// the boosted/trending feed). We fetch it independently here so the
// tier system has the data it needs to work correctly.
// "$Peakychu" description = "ghost pikachu..." → finds $Pikachu
// "$dippin" description = "alter ego of pippin" → finds $Pippin
const fetchDescription = async (alpha) => {
  if (alpha.description && alpha.description.length > 15) {
    return alpha.description
  }
  try {
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${alpha.address}`,
      { timeout: 6000 }
    )
    const pairs = res.data?.pairs || []
    const desc  = pairs[0]?.info?.description || pairs[0]?.baseToken?.description || ''
    if (desc) console.log(`[ParentSearch] Fetched desc for $${alpha.symbol}: "${desc.slice(0, 60)}..."`)
    return desc
  } catch {
    return ''
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

// ─── Similarity ──────────────────────────────────────────────────
const similarity = (runner, candidate) => {
  const a = runner.toUpperCase()
  const b = candidate.toUpperCase()
  if (a === b) return 1.0
  if (a.startsWith(b) && b.length >= 3) return 0.75 + (b.length / a.length) * 0.2
  if (b.startsWith(a) && a.length >= 3) return 0.80
  const shorter = a.length <= b.length ? a : b
  const longer  = a.length <= b.length ? b : a
  let sharedLen = 0
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) sharedLen++
    else break
  }
  if (sharedLen >= 4 && sharedLen / shorter.length >= 0.75) {
    return 0.65 + (sharedLen / shorter.length) * 0.15
  }
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - editDistance(a, b) / maxLen
}

// ─── Strip prefixes/suffixes to get root symbol candidates ───────
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
  'HOLY', 'DEGEN', 'ALPHA', 'PURE',
]

export const extractRootCandidates = (symbol) => {
  const s     = symbol.toUpperCase()
  const parts = new Set()
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
  const camelParts = symbol
    .replace(/([A-Z][a-z]+)/g, ' $1')
    .replace(/([A-Z]+)(?=[A-Z][a-z])/g, ' $1')
    .trim().split(/\s+/)
    .filter(p => p.length >= 3)
  camelParts.forEach(p => parts.add(p.toUpperCase()))
  parts.delete(s)
  return Array.from(parts)
}

// ─── Format parent pair ───────────────────────────────────────────
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

// ─── Stop words ───────────────────────────────────────────────────
const NAME_STOP = new Set([
  'the', 'a', 'an', 'of', 'dark', 'evil', 'mean', 'baby', 'mini',
  'based', 'super', 'real', 'og', 'little', 'big', 'bad', 'mad',
  'wild', 'holy', 'ghost', 'shadow', 'alter', 'turbo', 'chad',
  'fat', 'first', 'new', 'this', 'that', 'with', 'from', 'have',
  'will', 'just', 'play', 'game', 'coin', 'token', 'every',
])

// ─── Main hook ───────────────────────────────────────────────────
// Parent detection confidence tiers (score boosts):
//
//   TIER 1 (+0.40): $TICKER in description  → "alter ego of $PIPPIN"
//   TIER 2 (+0.25): word in description     → "ghost pikachu" → PIKACHU
//   TIER 3 (+0.10): word in token name      → "Dark Pippin" → PIPPIN
//   TIER 4 (+0.00): symbol prefix/pattern   → PEAKYCHU → PEAKY (weakest)
//
// Key fix: description is fetched independently at step 1 since the
// live feed often strips it out of the alpha object.

const useParentAlpha = (alpha) => {
  const [parent,  setParent]  = useState(null)
  const [loading, setLoading] = useState(false)

  const findParent = useCallback(async () => {
    if (!alpha || alpha.isSzn) { setParent(null); return }

    setLoading(true)
    setParent(null)

    const symbol = alpha.symbol.toUpperCase()

    // ── Step 1: Get description (fetch if missing) ────────────────
    const description = await fetchDescription(alpha)

    // ── Step 2: Build tiered query sets ──────────────────────────
    const symbolQueries     = new Set(extractRootCandidates(symbol))
    const nameQueries       = new Set()
    const descWordQueries   = new Set()
    const descTickerQueries = new Set()

    if (alpha.name) {
      alpha.name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !NAME_STOP.has(w))
        .forEach(w => nameQueries.add(w.toUpperCase()))
    }

    if (description) {
      // Tier 1: explicit $TICKER references
      const tickerMatches = description.match(/\$([A-Za-z]{2,12})/g) || []
      tickerMatches.forEach(t => descTickerQueries.add(t.replace('$', '').toUpperCase()))

      // Tier 2: meaningful nouns from description
      // min length 4 catches tokens like "gork", "frog", "pepe" etc.
      description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !NAME_STOP.has(w))
        .slice(0, 8)
        .forEach(w => descWordQueries.add(w.toUpperCase()))
    }

    const allQueries = new Set([
      ...descTickerQueries,
      ...descWordQueries,
      ...nameQueries,
      ...symbolQueries,
    ])

    if (allQueries.size === 0) { setLoading(false); return }

    // ── Step 3: Score boost per tier ──────────────────────────────
    const getBoost = (query) => {
      if (descTickerQueries.has(query)) return 0.40
      if (descWordQueries.has(query))   return 0.25
      if (nameQueries.has(query))       return 0.10
      return 0
    }

    try {
      const queryList = Array.from(allQueries).slice(0, 10)
      const searches  = await Promise.allSettled(
        queryList.map(q =>
          axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${q}`)
            .then(r => ({ q, data: r.data }))
        )
      )

      let bestMatch = null
      let bestScore = 0

      searches.forEach((result) => {
        if (result.status !== 'fulfilled') return
        const { q, data } = result.value
        const pairs = data?.pairs || []
        const boost = getBoost(q)

        pairs
          .filter(p =>
            p.chainId === 'solana' &&
            (p.marketCap || p.fdv || 0) > (alpha.marketCap || 0) * 0.5 &&
            (p.liquidity?.usd || 0) > 5_000 &&
            p.baseToken?.address !== alpha.address &&
            p.baseToken?.symbol?.toUpperCase() !== symbol
          )
          .forEach(p => {
            const cSym  = p.baseToken?.symbol?.toUpperCase() || ''
            const cName = p.baseToken?.name?.toUpperCase()   || ''
            // Key fix: if the query EXACTLY matches the candidate symbol,
            // score it 1.0. Without this, "PIKACHU" query finding $PIKACHU
            // gets scored as similarity("PEAKYCHU","PIKACHU") = 0.38, losing
            // to $PEAKY on pure symbol pattern matching.
            const queryMatchesCandidate = (q === cSym)
            const baseSim = queryMatchesCandidate
              ? 1.0
              : Math.max(
                  similarity(symbol, cSym),
                  similarity(symbol, cName.split(/\s+/).find(w => w.length >= 4) || ''),
                )
            // Description queries need only 0.30 base sim to qualify
            // Symbol-pattern queries need 0.65 to prevent garbage winning
            const minBase     = boost > 0 ? 0.30 : 0.65
            const totalScore  = baseSim + boost

            if (baseSim >= minBase && totalScore > bestScore) {
              bestScore = totalScore
              bestMatch = p
              console.log(
                `[ParentSearch] Candidate $${cSym}: baseSim=${baseSim.toFixed(2)} ` +
                `boost=${boost} total=${totalScore.toFixed(2)} via query "${q}"`
              )
            }
          })
      })

      const foundParent = bestMatch ? formatParent(bestMatch) : null
      console.log(
        `[ParentSearch] Winner for $${symbol}: ` +
        `${foundParent ? '$' + foundParent.symbol : 'none'} (score ${bestScore.toFixed(2)})`
      )
      setParent(foundParent)
      if (foundParent) saveParentToHistory(foundParent, alpha)

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