import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const STORAGE_KEY      = 'betaplays_seen_alphas'
const BACKEND_URL      = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// ─── Save parent to localStorage + Supabase ──────────────────────
const saveParentToHistory = (parent, derivative, sourceType = 'root') => {
  try {
    // Keep localStorage write — fast local session cache
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now      = Date.now()
    existing[parent.address] = {
      ...parent,
      firstSeen:     existing[parent.address]?.firstSeen || now,
      lastSeen:      now,
      coolingReason: `Parent of $${derivative.symbol}`,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))

    const parentMap = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
    parentMap[derivative.address] = { symbol: parent.symbol, address: parent.address, sourceType }
    localStorage.setItem('betaplays_parent_map', JSON.stringify(parentMap))

    const change = parseFloat(parent.priceChange24h) || 0
    console.log(
      `[ParentDetected] $${parent.symbol} ${change >= 0 ? '→ Live' : '→ Cooling'} ` +
      `(${change >= 0 ? '+' : ''}${change.toFixed(1)}%) via $${derivative.symbol}`
    )
  } catch (err) {
    console.warn('Failed to save parent to localStorage:', err.message)
  }

  // Write to Supabase — fire and forget, non-blocking
  // This makes the derivative→parent relationship available to all users/devices
  fetch(`${BACKEND_URL}/api/record-parent`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      derivativeAddress: derivative.address,
      derivativeSymbol:  derivative.symbol,
      parentAddress:     parent.address,
      parentSymbol:      parent.symbol,
      parentName:        parent.name    || null,
      parentLogoUrl:     parent.logoUrl || null,
      parentMarketCap:   parent.marketCap || 0,
    }),
  }).catch(err => console.warn('[ParentMap] Supabase write failed:', err.message))
}

// ─── Load parent map from Supabase ───────────────────────────────
// Returns { [derivativeAddress]: { symbol, address } }
// Same shape as betaplays_parent_map in localStorage.
// Falls back to localStorage if Supabase is unavailable.
let _parentMapCache     = null
let _parentMapCacheTime = 0
const PARENT_MAP_TTL_MS = 5 * 60 * 1000  // 5 minutes

const loadParentMap = async () => {
  const now = Date.now()
  if (_parentMapCache && (now - _parentMapCacheTime) < PARENT_MAP_TTL_MS) {
    return _parentMapCache
  }
  try {
    const res = await fetch(`${BACKEND_URL}/api/parent-map`)
    if (!res.ok) throw new Error('parent-map fetch failed')
    const { map } = await res.json()
    if (map && Object.keys(map).length > 0) {
      // Merge with localStorage so locally-discovered parents aren't lost
      const local = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
      const merged = { ...local, ...map }  // Supabase wins on conflict
      localStorage.setItem('betaplays_parent_map', JSON.stringify(merged))
      _parentMapCache     = merged
      _parentMapCacheTime = now
      console.log(`[ParentMap] Loaded ${Object.keys(map).length} parent relationship(s) from Supabase`)
      return merged
    }
  } catch { /* fall through to localStorage */ }

  // Fallback: localStorage
  try {
    return JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
  } catch { return {} }
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

  // Try DEXScreener first
  try {
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${alpha.address}`,
      { timeout: 6000 }
    )
    const pairs = res.data?.pairs || []
    const desc  = pairs[0]?.info?.description || pairs[0]?.baseToken?.description || ''
    if (desc) {
      console.log(`[ParentSearch] DEX desc for $${alpha.symbol}: "${desc.slice(0, 80)}..."`)
      return desc
    }
    console.log(`[ParentSearch] DEX desc EMPTY for $${alpha.symbol} (pairs: ${pairs.length})`)
  } catch { /* fall through to Birdeye */ }

  // Birdeye fallback 1: token_overview
  try {
    const res = await axios.get(
      `${BACKEND_URL}/api/birdeye?endpoint=token_overview&address=${alpha.address}`,
      { timeout: 6000 }
    )
    const d = res.data?.data
    const desc = d?.extensions?.description || d?.description || ''
    if (desc && desc.length > 15) {
      console.log(`[ParentSearch] Birdeye overview desc for $${alpha.symbol}: "${desc.slice(0, 80)}..."`)
      return desc
    }
  } catch { /* fall through */ }

  // Birdeye fallback 2: token_metadata
  try {
    const res = await axios.get(
      `${BACKEND_URL}/api/birdeye?endpoint=token_metadata&address=${alpha.address}`,
      { timeout: 6000 }
    )
    const d = res.data?.data
    const desc = d?.extensions?.description || d?.description || ''
    if (desc && desc.length > 15) {
      console.log(`[ParentSearch] Birdeye metadata desc for $${alpha.symbol}: "${desc.slice(0, 80)}..."`)
      return desc
    }
  } catch { /* fall through */ }

  return ''
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
  // Derivative prefixes/suffixes — valid in symbol context but not as parent queries
  'the', 'a', 'an', 'of', 'dark', 'evil', 'mean', 'baby', 'mini',
  'based', 'super', 'real', 'og', 'little', 'big', 'bad', 'mad',
  'wild', 'holy', 'ghost', 'shadow', 'alter', 'turbo', 'chad',
  'fat', 'first', 'new', 'this', 'that', 'with', 'from', 'have',
  'will', 'just', 'play', 'game', 'coin', 'token', 'every',
  // Common English verbs — appear in descriptions, never token names
  'tired', 'needed', 'looking', 'meet', 'meets', 'came', 'come',
  'runs', 'running', 'goes', 'going', 'gets', 'getting', 'make',
  'makes', 'made', 'take', 'takes', 'took', 'said', 'says', 'know',
  'knew', 'want', 'wanted', 'love', 'loved', 'hate', 'hated',
  'find', 'found', 'look', 'looked', 'feel', 'feels', 'felt',
  'call', 'calls', 'called', 'show', 'shows', 'showed',
  // Common English nouns/adjectives — generic, not token-specific
  'peace', 'hope', 'time', 'life', 'world', 'home', 'hand', 'away',
  'long', 'good', 'great', 'best', 'only', 'even', 'back', 'down',
  'over', 'also', 'into', 'than', 'then', 'when', 'your', 'they',
  'them', 'their', 'were', 'been', 'being', 'more', 'some', 'very',
  'here', 'there', 'which', 'after', 'before', 'about', 'between',
  // Crypto/project generic terms
  'pump', 'moon', 'gem', 'alpha', 'beta', 'degen', 'based', 'sent',
  'community', 'ecosystem', 'protocol', 'platform', 'launch',
  // All-caps narrative words common in token descriptions (never token names)
  'finally', 'girlfriend', 'boyfriend', 'officially',
  'introducing', 'presenting', 'welcome',
  'never', 'always', 'still', 'already',
])

// ─── Infrastructure/stablecoin blocklist ─────────────────────────
// These tokens should never be identified as a parent alpha.
// They are base-layer infrastructure, not narrative runners.
const PARENT_BLOCKLIST = new Set([
  'So11111111111111111111111111111111111111112',   // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
  'jtojtomepa8bdya7p3afruyv91fdfkdrjqhmpua3bef',   // JTO
  'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk',   // WEN
])

// ─── Naming anchor check ──────────────────────────────────────────
// Before scoring, candidate must share a naming element with the runner.
// Uses extractRootCandidates first (strips BABY/MINI/etc prefixes and
// COIN/INU/etc suffixes). Falls back to raw substring check.
// Prevents pure ratio matches with zero naming relationship.
export const hasNamingAnchor = (runnerSymbol, candidateSymbol, candidateName) => {
  const rSym  = runnerSymbol.toUpperCase()
  const cSym  = candidateSymbol.toUpperCase()
  const cName = (candidateName || '').toUpperCase()

  // Direct substring either way
  if (rSym.includes(cSym) && cSym.length >= 3) return true
  if (cSym.includes(rSym) && rSym.length >= 3) return true

  // Root candidates of the runner — strip BABY, MINI, INU etc
  const runnerRoots = extractRootCandidates(rSym)
  for (const root of runnerRoots) {
    if (root.length < 3) continue
    if (cSym === root) return true
    if (cSym.includes(root)) return true
    if (cName.split(/\s+/).some(w => w === root)) return true
  }

  // Root candidates of the candidate — catch $PEAKYCHU → $PIKACHU
  const candidateRoots = extractRootCandidates(cSym)
  for (const root of candidateRoots) {
    if (root.length < 3) continue
    if (rSym === root) return true
    if (rSym.includes(root)) return true
  }

  return false
}

// ─── Main hook ───────────────────────────────────────────────────
// Parent detection confidence tiers (score boosts):
//
//   TIER 1 (+0.40): $TICKER in description  → "alter ego of $PIPPIN"
//   TIER 2 (+0.25): word in description     → "ghost pikachu" → PIKACHU
//   TIER 3 (+0.10): word in token name      → "Dark Pippin" → PIPPIN
//   TIER 4 (+0.00): symbol prefix/pattern   → PEAKYCHU → PEAKY (weakest)
//
// Momentum weighting (added Session 18):
//   +0.20: candidate is currently in liveAlphas → this IS the active meta
//   +0.15: priceChange1h > 5% → actively running right now
//   +0.10: priceChange1h > 0% → positive momentum
//   +0.05: priceChange24h > 0% → at least positive on the day
//   +0.00: negative → not the current narrative
//
// This ensures $CHIBI beats $TRUMP for $ChibiTrump when CHIBI is the
// active meta — regardless of TRUMP's larger mcap.
// mcapBoost kept but demoted to tiebreaker (max +0.05).

const useParentAlpha = (alpha, liveAlphas = [], resolvedDescription = null) => {
  const [parent,  setParent]  = useState(null)
  const [loading, setLoading] = useState(false)

  const findParent = useCallback(async () => {
    if (!alpha || alpha.isSzn) { setParent(null); return }

    setLoading(true)
    setParent(null)

    const symbol = alpha.symbol.toUpperCase()

    // Build live address set inside callback — always fresh
    const liveAddressSet = new Set((liveAlphas || []).map(a => a.address).filter(Boolean))

    // ── Step 1: Get description (use pre-resolved if available) ──
    // resolvedDescription comes from useBetas (Birdeye + 3 fallbacks) — more
    // reliable than fetchDescription (DEXScreener-only).
    const description = resolvedDescription || await fetchDescription(alpha)
    if (resolvedDescription) console.log(`[ParentSearch] Using pre-resolved description for $${alpha.symbol}: "${resolvedDescription.slice(0, 60)}..."`)

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

      // Tier 1b: capitalised proper nouns (e.g. "Jotchua was tired...") and
      // ALL-CAPS token names (e.g. "JOTCHUA FINALLY GOT A GIRLFRIEND").
      // Both get same high-confidence boost as explicit $TICKER.
      description
        .split(/\s+/)
        .filter(w =>
          (/^[A-Z][a-zA-Z]{3,}$/.test(w) || /^[A-Z]{4,}$/.test(w)) &&
          !NAME_STOP.has(w.toLowerCase())
        )
        .forEach(w => descTickerQueries.add(w.toUpperCase()))

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
      if (descTickerQueries.has(query)) return 0.55  // explicit $TICKER in description — highest confidence
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

      // bestBySymbol: symbol → { match, score, isDesc, totalLiq, totalVol, pairCreatedAt }
      // Tracks best score per symbol across all queries.
      // When multiple tokens share a symbol (same name, different CA), the
      // score determines which symbol wins; fundamentals (mcap × age) determine
      // which token of that symbol wins — prevents a pumping copycat beating the OG.
      const bestBySymbol = new Map()

      searches.forEach((result) => {
        if (result.status !== 'fulfilled') return
        const { q, data } = result.value
        const pairs = data?.pairs || []
        const boost = getBoost(q)

        // ── Consolidate pairs by baseToken address ────────────────
        // DEXScreener returns multiple pairs per token (e.g. Raydium + PumpSwap).
        // Scoring pairs individually lets a small pumping pair beat the dominant
        // pair of the same token on momentum alone.
        // Fix: group by address, pick highest-liq pair as representative, but
        // carry best momentum signal and total volume across ALL pairs of that token.
        const pairsByAddress = new Map()
        pairs.forEach(p => {
          const addr = p.baseToken?.address || ''
          if (!addr) return
          const pLiq       = p.liquidity?.usd || 0
          const pVol       = p.volume?.h24    || 0
          const pChange1h  = parseFloat(p.priceChange?.h1  || 0)
          const pChange24h = parseFloat(p.priceChange?.h24 || 0)
          const existing   = pairsByAddress.get(addr)
          if (!existing) {
            const pTxns = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)
            pairsByAddress.set(addr, { rep: p, totalLiq: pLiq, totalVol: pVol, totalTxns: pTxns, bestChange1h: pChange1h, bestChange24h: pChange24h })
          } else {
            existing.totalLiq      += pLiq
            existing.totalVol      += pVol
            existing.totalTxns     += (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)
            existing.bestChange1h   = Math.max(existing.bestChange1h,  pChange1h)
            existing.bestChange24h  = Math.max(existing.bestChange24h, pChange24h)
            if (pLiq > (existing.rep.liquidity?.usd || 0)) existing.rep = p
          }
        })

        Array.from(pairsByAddress.values())
          .filter(({ rep: p, totalLiq, totalVol, totalTxns }) => {
            const cSym  = p.baseToken?.symbol?.toUpperCase() || ''
            const cAddr = p.baseToken?.address || ''
            const cMcap = p.marketCap || p.fdv || 0

            if (PARENT_BLOCKLIST.has(cAddr)) return false

            const isDescSourced = descTickerQueries.has(q) || descWordQueries.has(q)
            if (!isDescSourced && !hasNamingAnchor(symbol, cSym, p.baseToken?.name || '')) {
              if (totalLiq > 5_000) {
                console.log(`[ParentFilter] ⛔ No naming anchor — $${symbol} vs $${cSym}`)
              }
              return false
            }

            // ── Dynamic liquidity health check ────────────────────
            // Uses consolidated liq across all pairs — reflects full tradeable depth.
            // Tiers (minimum liq/mcap ratio required):
            //   < $100K mcap  → 1.0% | $100K–$1M → 2.0% | $1M–$10M → 1.0%
            //   $10M–$100M    → 0.5% | > $100M   → 0.2%
            // Absolute floor: $10K consolidated liq.
            const getMinLiqRatio = (mcap) => {
              if (mcap < 100_000)    return 0.010
              if (mcap < 1_000_000)  return 0.020
              if (mcap < 10_000_000) return 0.010
              if (mcap < 100_000_000) return 0.005
              return 0.002
            }
            const minRatio        = getMinLiqRatio(cMcap)
            const liqRatio        = cMcap > 0 ? totalLiq / cMcap : 0
            const hasHealthyRatio = totalLiq >= 10_000 && liqRatio >= minRatio

            if (totalLiq > 0 && !hasHealthyRatio) {
              console.log(
                `[ParentFilter] Rejected $${p.baseToken?.symbol} — ` +
                `liq $${Math.round(totalLiq).toLocaleString()} / mcap $${Math.round(cMcap).toLocaleString()} ` +
                `= ${(liqRatio * 100).toFixed(2)}% (need ${(minRatio * 100).toFixed(1)}%)`
              )
            }

            // Ghost token guard — two checks:
            // 1. Near-zero activity: vol < $1K AND txns < 10 → dead/fake token
            // 2. Vol/mcap credibility: large mcap must have proportional trading.
            //    Real $10M+ tokens turn over at least 0.1% daily. Ghost tokens don't.
            //    This catches $10B fake mcap with $1K volume without capping real tokens.
            const isGhost = totalVol < 1_000 && totalTxns < 10
            const minVolForMcap = cMcap > 10_000_000 ? cMcap * 0.001 : 0
            const failsCredibility = minVolForMcap > 0 && totalVol < minVolForMcap
            if (isGhost || failsCredibility) {
              console.log(`[ParentFilter] ⛔ ${isGhost ? 'Ghost' : 'Low-vol'} token $${p.baseToken?.symbol} — vol=$${Math.round(totalVol)} mcap=$${Math.round(cMcap).toLocaleString()} txns=${totalTxns}`)
              return false
            }

            return (
              p.chainId === 'solana' &&
              cMcap > (alpha.marketCap || 0) * 0.5 &&
              totalLiq > 5_000 &&
              hasHealthyRatio &&
              cAddr !== alpha.address &&
              cSym  !== symbol &&
              cSym.length >= 3 &&
              !/^\d+$/.test(cSym) &&
              !/^[^A-Z]+$/.test(cSym)
            )
          })
          .forEach(({ rep: p, totalLiq, totalVol, bestChange1h, bestChange24h }) => {
            const cSym  = p.baseToken?.symbol?.toUpperCase() || ''
            const cName = p.baseToken?.name?.toUpperCase()   || ''
            const cAddr = p.baseToken?.address || ''
            const cMcap = p.marketCap || p.fdv || 0

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
            const minBase = boost > 0 ? 0.30 : 0.65

            // ── Momentum — best change across all pairs of this token ─
            const isLiveNow = liveAddressSet.has(cAddr)
            const momentumBoost =
              isLiveNow          ? 0.20 :
              bestChange1h > 5   ? 0.15 :
              bestChange1h > 0   ? 0.10 :
              bestChange24h > 0  ? 0.05 :
              0

            // ── Fundamentals tiebreakers (max +0.08 combined) ─────
            // mcap: established tokens are larger — max +0.05
            // volume: active trading confirms real narrative — max +0.03
            const mcapTiebreaker = Math.min(cMcap / 1_000_000_000, 0.05)
            const volTiebreaker  = Math.min(totalVol / 10_000_000, 0.03)
            const totalScore     = baseSim + boost + momentumBoost + mcapTiebreaker + volTiebreaker

            if (baseSim >= minBase) {
              // Track ALL qualifying candidates per symbol (symbol → array).
              // Same symbol can appear with different CAs (OG vs copycat).
              // We resolve which CA wins after the loop via fundamentals rank.
              // Dedupe by CA: if same address seen again with higher score, update in place.
              if (!bestBySymbol.has(cSym)) bestBySymbol.set(cSym, [])
              const bucket   = bestBySymbol.get(cSym)
              const existing = bucket.find(e => (e.match.baseToken?.address || '') === cAddr)
              if (existing) {
                if (totalScore > existing.score) {
                  existing.score  = totalScore
                  existing.isDesc = existing.isDesc || descTickerQueries.has(q) || descWordQueries.has(q)
                }
              } else {
                bucket.push({
                  match:         p,
                  score:         totalScore,
                  isDesc:        descTickerQueries.has(q) || descWordQueries.has(q),
                  totalLiq,
                  totalVol,
                  pairCreatedAt: p.pairCreatedAt || 0,
                })
              }
              console.log(
                `[ParentSearch] Candidate $${cSym} (${(p.baseToken?.address||'').slice(0,8)}): ` +
                `baseSim=${baseSim.toFixed(2)} descBoost=${boost} momentum=${momentumBoost} ` +
                `liq=$${Math.round(totalLiq).toLocaleString()} vol=$${Math.round(totalVol).toLocaleString()} ` +
                `total=${totalScore.toFixed(2)} via query "${q}"`
              )
            }
          })
      })

      // ── Resolve winner ────────────────────────────────────────────
      // Step 1: For each symbol with multiple CAs (same name, different token),
      //         pick the CA with the best fundamentals rank: mcap × log(ageDays+1).
      //         This ensures the OG beats a pumping copycat launched yesterday.
      // Step 2: Among all symbols, pick the one with the highest score.
      const fundamentalsRank = (entry) => {
        // No mcap cap — legitimate large parents ($WIF, $BONK) must not be penalised.
        // Ghost tokens are caught by the credibility filter before reaching this point.
        const mcap    = entry.match.marketCap || entry.match.fdv || 0
        const vol     = entry.totalVol || 0
        const ageMs   = Date.now() - (entry.pairCreatedAt || Date.now())
        const ageDays = Math.max(ageMs / 86_400_000, 0)
        const ageFactor = Math.log(ageDays + 1)
        return (mcap * 0.6 + vol * 50 * 0.4) * ageFactor
      }

      let bestMatch = null
      let bestScore = 0
      let bestIsDesc = false

      for (const [sym, candidates] of bestBySymbol) {
        // Pick the best CA for this symbol: most fundamental if collision, else only entry
        const winner = candidates.length === 1
          ? candidates[0]
          : candidates.reduce((a, b) => fundamentalsRank(a) >= fundamentalsRank(b) ? a : b)

        if (winner.score > bestScore) {
          bestScore  = winner.score
          bestMatch  = winner.match
          bestIsDesc = winner.isDesc
          if (candidates.length > 1) {
            console.log(
              `[ParentSearch] Symbol collision $${sym}: ${candidates.length} CAs — ` +
              `picked ${(winner.match.baseToken?.address||'').slice(0,8)} by fundamentals ` +
              `(mcap=$${Math.round(winner.match.marketCap||0).toLocaleString()})`
            )
          }
        }
      }

      // ── Step 4: Semantic alignment gate ──────────────────────────
      // Prevents cross-universe mismatches like $PANDU → $IRAN.
      // A candidate can win on string similarity alone even when it's
      // thematically unrelated (geopolitics vs animals, slang vs anime).
      // We build identity token sets for both sides and check overlap.
      // If there's zero thematic overlap AND the score is weak, reject.
      //
      // "Identity tokens" = meaningful words extracted from symbol/name/desc.
      // We tokenise, strip stop words, and compare as sets.
      // Jaccard overlap of 0 with score < HIGH_CONFIDENCE_FLOOR → reject.
      //
      // HIGH_CONFIDENCE_FLOOR (1.30): requires baseSim=1.0 + meaningful boosts
      // non-zero boost (desc match, momentum, or mcap). Pure symbol-pattern
      // wins with no semantic evidence won't clear this bar.

      const HIGH_CONFIDENCE_FLOOR = 1.30

      const tokenise = (str = '') =>
        str
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 3 && !NAME_STOP.has(w))

      // Alpha identity: symbol root candidates + name words + desc words
      const alphaIdentityTokens = new Set([
        ...Array.from(symbolQueries).map(q => q.toLowerCase()),
        ...Array.from(nameQueries).map(q => q.toLowerCase()),
        ...Array.from(descWordQueries).map(q => q.toLowerCase()),
        ...Array.from(descTickerQueries).map(q => q.toLowerCase()),
        symbol.toLowerCase(),
      ])

      let semanticAlignmentOk = true

      if (bestMatch) {
        const candidateSym  = (bestMatch.baseToken?.symbol || '').toLowerCase()
        const candidateName = bestMatch.baseToken?.name   || ''
        const candidateDesc = bestMatch.info?.description  || ''

        // Candidate identity: symbol + name words + description words
        const candidateTokens = new Set([
          candidateSym,
          ...tokenise(candidateName),
          ...tokenise(candidateDesc).slice(0, 10),
          // Also add root candidates of the candidate symbol for partial matches
          ...extractRootCandidates(candidateSym.toUpperCase()).map(r => r.toLowerCase()),
        ])

        // Jaccard-style: count shared tokens between both identity sets
        let sharedCount = 0
        for (const t of alphaIdentityTokens) {
          if (candidateTokens.has(t)) sharedCount++
        }

        const hasOverlap = sharedCount > 0

        if (!hasOverlap && bestScore < HIGH_CONFIDENCE_FLOOR) {
          console.log(
            `[ParentSearch] REJECTED $${bestMatch.baseToken?.symbol} — ` +
            `zero semantic overlap with $${symbol} identity set, score ${bestScore.toFixed(2)} < ${HIGH_CONFIDENCE_FLOOR} threshold. ` +
            `Alpha tokens: [${Array.from(alphaIdentityTokens).join(', ')}] | ` +
            `Candidate tokens: [${Array.from(candidateTokens).join(', ')}]`
          )
          semanticAlignmentOk = false
        } else if (hasOverlap) {
          console.log(
            `[ParentSearch] Alignment OK for $${bestMatch.baseToken?.symbol} — ` +
            `${sharedCount} shared token(s), score ${bestScore.toFixed(2)}`
          )
        } else {
          console.log(
            `[ParentSearch] High-confidence override for $${bestMatch.baseToken?.symbol} — ` +
            `no overlap but score ${bestScore.toFixed(2)} >= ${HIGH_CONFIDENCE_FLOOR}, accepting`
          )
        }
      }

      const foundParent = (bestMatch && semanticAlignmentOk) ? formatParent(bestMatch) : null
      console.log(
        `[ParentSearch] Winner for $${symbol}: ` +
        `${foundParent ? '$' + foundParent.symbol : 'none'} (score ${bestScore.toFixed(2)})`
      )
      setParent(foundParent)
      if (foundParent) saveParentToHistory(foundParent, alpha, bestIsDesc ? 'desc' : 'root')

    } catch (err) {
      console.warn('Parent alpha lookup failed:', err.message)
      setParent(null)
    } finally {
      setLoading(false)
    }
  }, [alpha?.id, resolvedDescription])

  useEffect(() => { findParent() }, [findParent])

  return { parent, loading }
}

export default useParentAlpha