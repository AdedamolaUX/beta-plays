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
      const prev     = existing[alpha.address]
      const prevPeak = prev?.peakMarketCap || 0
      // Cap % change before storing — bonding curve artifacts can show >100000%
      const safePriceChange = Math.min(Math.max(parseFloat(alpha.priceChange24h) || 0, -100), 5000)
      existing[alpha.address] = {
        ...alpha,
        priceChange24h:  safePriceChange,
        firstSeen:       prev?.firstSeen || Date.now(),
        lastSeen:        Date.now(),
        peakMarketCap:   Math.max(prevPeak, alpha.marketCap || 0),
        mcapAtFirstSeen: prev?.mcapAtFirstSeen || alpha.marketCap || 0,
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

      // ── Staleness guard ─────────────────────────────────────────
      // If data is more than 2 hours old, the 24h% is unreliable.
      // Bonding curve tokens especially show wild % that don't reflect
      // current reality. Cap and flag as stale rather than mislead.
      const ageHours    = age / 3600000
      const isStale     = ageHours > 2
      // Cap bonding-curve artifacts — legitimate moves don't exceed 5000%
      const cappedChange = Math.min(Math.max(change, -100), 5000)

      const ageLabel = Math.floor(ageHours / 24) > 0
        ? `${Math.floor(ageHours / 24)}d ago`
        : ageHours > 0 ? `${Math.floor(ageHours)}h ago` : 'recently'

      // Dump detection: if we've seen a peak and current is way below, don't show as live
      const peak    = a.peakMarketCap || 0
      const dumped  = peak > 50_000 && mcap > 0 && (mcap / peak) < 0.25

      if (dumped) {
        // Force into cooling regardless of 24h%
        historicalCooling.push({
          ...a,
          priceChange24h: cappedChange,
          isCooling:      true,
          isDumped:       true,
          isHistorical:   true,
          coolingLabel:   `Dumped — ${Math.round((1 - mcap/peak) * 100)}% from peak`,
        })
        return
      }

      if (cappedChange > LIVE_MIN_CHANGE && volume >= LIVE_MIN_VOLUME && !isStale) {
        // Was pumping and data is still fresh enough to trust
        historicalLive.push({
          ...a,
          priceChange24h: cappedChange,
          isHistorical:   true,
          coolingLabel:   null,
        })
      } else if (cappedChange < 0 || isStale) {
        // Retracing, OR data too old to show as live — move to Cooling
        historicalCooling.push({
          ...a,
          priceChange24h: cappedChange,
          isCooling:      true,
          isHistorical:   true,
          coolingLabel:   isStale ? `Last seen ${ageLabel}` : 'Watching for reversal',
        })
      }
    })

    return { historicalLive, historicalCooling }
  } catch {
    return { historicalLive: [], historicalCooling: [] }
  }
}

// ─── Load positioning plays ───────────────────────────────────────
// "Positioning Plays" = tokens that:
//   1. Had a meaningful peak (>$50K mcap)
//   2. Have drawn down significantly from that peak (>40%)
//   3. Still have volume alive (someone is still interested)
//   4. Still have liquidity (can actually be traded)
//
// Sorted by: opportunity score = drawdown depth × volume aliveness
// The signal: big peak + big drawdown + still trading = degen magnet
// These are the tokens traders position in for the second leg.

const loadPositioningPlays = () => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now      = Date.now()

    return Object.values(existing)
      .filter(a => {
        const peak      = a.peakMarketCap || 0
        const current   = a.marketCap     || 0
        const volume    = a.volume24h     || 0
        const liquidity = a.liquidity     || 0
        const age       = now - (a.firstSeen || now)

        if (peak < 50_000)     return false  // Never had meaningful size
        if (current === 0)     return false  // Dead
        if (volume < 5_000)    return false  // No one trading it
        if (liquidity < 3_000) return false  // Can't get in/out
        if (age < 12 * 3600000) return false // Too new — need history

        const drawdown = (peak - current) / peak
        return drawdown >= 0.40  // Down 40%+ from peak
      })
      .map(a => {
        const peak        = a.peakMarketCap || 0
        const current     = a.marketCap     || 0
        const drawdown    = peak > 0 ? ((peak - current) / peak) : 0
        const ageDays     = (now - (a.firstSeen || now)) / 86400000

        // Opportunity score:
        //   Deep drawdown = more room to recover
        //   High volume = still being traded actively
        //   Not too old = narrative still fresh
        const volScore      = Math.min(a.volume24h / 500_000, 1)
        const drawdownScore = Math.min(drawdown, 0.99)
        const freshnessScore = Math.max(0, 1 - ageDays / 14)  // Freshest in 14d
        const opportunityScore = Math.round(
          (drawdownScore * 0.50 + volScore * 0.30 + freshnessScore * 0.20) * 100
        )

        return {
          ...a,
          isPositioning:    true,
          drawdownPct:      Math.round(drawdown * 100),
          opportunityScore,
          peakMarketCap:    peak,
          ageDays:          Math.round(ageDays),
        }
      })
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, 30)

  } catch {
    return []
  }
}
const formatAlpha = (pair, source = 'boost', extraDescription = '') => ({
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
  // ── Description: best available from pair info or passed in ────
  description:    pair.info?.description || pair.baseToken?.description || extraDescription || '',
  website:        pair.info?.websites?.[0]?.url || null,
  twitter:        pair.info?.socials?.find(s => s.type === 'twitter')?.url || null,
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

    // Build a description map from the profile endpoint — it has the richest data
    // Profile fields: tokenAddress, description, links, icon, header
    const descriptionMap = {}
    profiles.forEach((p) => {
      if (p.tokenAddress && p.description) {
        descriptionMap[p.tokenAddress] = p.description
      }
    })

    const pairResults = await Promise.allSettled(
      profiles.map((b) => axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${b.tokenAddress}`))
    )
    const alphas = []
    pairResults.forEach((result, i) => {
      if (result.status !== 'fulfilled') return
      const pairs = result.value.data?.pairs || []
      const best  = pairs
        .filter((p) => p.chainId === 'solana')
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]
      if (best) {
        // Pass profile description as fallback — this is richer than pair.info.description
        const profileDesc = descriptionMap[profiles[i]?.tokenAddress] || ''
        alphas.push(formatAlpha(best, 'profile', profileDesc))
      }
    })
    return alphas
  } catch (err) {
    console.warn('Profile fetch failed:', err.message)
    return []
  }
}

// ─── Source 3: PumpFun graduating tokens ────────────────────────
// ─── Source 3: PumpFun bonded tokens → real DEX data ────────────
// PumpFun tokens graduate at ~$35K bonding. After migration they live
// on Raydium and DEXScreener shows real price action.
//
// Two-phase fetch:
//   Phase A: PumpFun API → get recently bonded coins (complete: true)
//            with their raydium_pool address
//   Phase B: DEXScreener → fetch real pair data using raydium_pool
//            This replaces the frozen bonding curve snapshot with
//            actual post-bond price action, volume, and mcap
//
// Also keeps a pre-graduation watch: tokens approaching bonding
// are surfaced as early signal (source: 'pumpfun_pre')

const fetchPumpFunBonded = async () => {
  try {
    // Fetch recently bonded coins (last 48h activity, sorted by migration time)
    const res = await axios.get(
      `${PUMPFUN_BASE}/coins?sort=last_trade_timestamp&order=DESC&limit=100&includeNsfw=false`,
      { timeout: 8000 }
    )

    const coins = res.data || []

    // Split: bonded (complete=true) vs approaching graduation
    // PumpFun now graduates to EITHER Raydium OR PumpSwap (their own DEX)
    // We handle both pool types
    const bonded      = coins.filter(c => c.complete && (c.raydium_pool || c.pool_address))
    const approaching = coins.filter(c => !c.complete && (c.usd_market_cap || 0) >= 20_000 && (c.usd_market_cap || 0) <= 34_000)

    // ── Phase B: fetch real DEX data for bonded tokens ───────────
    // raydium_pool = graduated to Raydium (old flow)
    // pool_address = graduated to PumpSwap (new flow, their own DEX)
    // Both are indexed by DEXScreener — same fetch works for both
    const bondedResults = []
    if (bonded.length > 0) {
      const pairFetches = await Promise.allSettled(
        bonded.slice(0, 20).map(coin => {
          const poolAddr = coin.raydium_pool || coin.pool_address
          return axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${poolAddr}`, { timeout: 6000 })
            .then(r => ({ coin, pairs: r.data?.pairs || [] }))
        })
      )

      pairFetches.forEach(result => {
        if (result.status !== 'fulfilled') return
        const { coin, pairs } = result.value

        // Find the best Solana pair by volume
        const best = pairs
          .filter(p => p.chainId === 'solana')
          .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]

        if (!best) return

        const postBondMcap = best.marketCap || best.fdv || 0

        // Real post-bond data from DEXScreener — no more frozen snapshot
        bondedResults.push({
          id:              best.pairAddress || coin.mint,
          symbol:          best.baseToken?.symbol || coin.symbol || '???',
          name:            best.baseToken?.name   || coin.name   || 'Unknown',
          address:         best.baseToken?.address || coin.mint  || '',
          pairAddress:     best.pairAddress || '',
          priceUsd:        best.priceUsd || '0',
          priceChange24h:  parseFloat(best.priceChange?.h24 || 0),  // REAL 24h change
          volume24h:       best.volume?.h24    || 0,                 // REAL volume
          marketCap:       postBondMcap,                             // REAL mcap
          liquidity:       best.liquidity?.usd || 0,
          logoUrl:         best.info?.imageUrl || coin.image_uri || null,
          description:     best.info?.description || coin.description || '',
          pairCreatedAt:   best.pairCreatedAt || coin.created_timestamp || null,
          isHistorical:    false,
          isLegend:        false,
          isCooling:       false,
          coolingLabel:    null,
          source:          'pumpfun_bonded',
          bondedAt:        coin.created_timestamp || null,
          poolAddress:     coin.raydium_pool || coin.pool_address,
          isPumpSwap:      !coin.raydium_pool && !!coin.pool_address,
          dexUrl:          best.url || `https://dexscreener.com/solana/${best.pairAddress}`,
        })
      })
    }

    // ── Pre-graduation tokens approaching bonding ─────────────────
    // Surfaced as early narrative signal — $20K–$34K mcap on bonding curve
    // These are NOT shown with real price data (we don't have it yet)
    // but they flag narratives about to graduate and spawn betas
    const preGradResults = approaching.slice(0, 8).map(coin => ({
      id:              coin.mint,
      symbol:          coin.symbol || '???',
      name:            coin.name   || 'Unknown',
      address:         coin.mint   || '',
      pairAddress:     coin.mint   || '',
      priceUsd:        coin.usd_market_cap ? String(coin.usd_market_cap / (coin.total_supply || 1e9)) : '0',
      priceChange24h:  0,           // Bonding curve — not real price action
      volume24h:       coin.volume || 0,
      marketCap:       coin.usd_market_cap || 0,
      liquidity:       coin.virtual_sol_reserves ? coin.virtual_sol_reserves * 150 : 0,
      logoUrl:         coin.image_uri || null,
      description:     coin.description || '',
      pairCreatedAt:   coin.created_timestamp || null,
      isHistorical:    false,
      isLegend:        false,
      isCooling:       false,
      coolingLabel:    null,
      source:          'pumpfun_pre',   // pre-graduation — approaching bonding
      bondingProgress: Math.round(((coin.usd_market_cap || 0) / 35_000) * 100),
      dexUrl:          `https://pump.fun/${coin.mint}`,
    }))

    console.log(`[PumpFun] ${bondedResults.length} bonded (real DEX data), ${preGradResults.length} approaching graduation`)
    return [...bondedResults, ...preGradResults]

  } catch (err) {
    console.warn('PumpFun bonded fetch failed:', err.message)
    return []
  }
}

// ─── Source 4: DEXScreener new pairs — universal launchpad coverage ─
// Catches graduates from ALL launchpads: PumpFun, Bonk.fun, Bags, Moonshot,
// LetsBonk, etc. without needing individual API integrations.
// DEXScreener indexes every new Solana pair within minutes of creation.
// We filter to pairs with real volume + liquidity to avoid pure junk.
const fetchNewPairs = async () => {
  try {
    const res = await axios.get(
      `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
      { timeout: 8000 }
    )
    const profiles = res.data || []

    // Fetch actual pair data for the most promising new profiles
    const solanaProfiles = profiles
      .filter(p => p.chainId === 'solana' && p.tokenAddress)
      .slice(0, 20)

    if (solanaProfiles.length === 0) return []

    const pairFetches = await Promise.allSettled(
      solanaProfiles.map(p =>
        axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${p.tokenAddress}`, { timeout: 5000 })
          .then(r => ({ profile: p, pairs: r.data?.pairs || [] }))
      )
    )

    const results = []
    pairFetches.forEach(result => {
      if (result.status !== 'fulfilled') return
      const { profile, pairs } = result.value

      const best = pairs
        .filter(p =>
          p.chainId === 'solana' &&
          (p.volume?.h24 || 0) >= 10_000 &&
          (p.liquidity?.usd || 0) >= 2_000
        )
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]

      if (!best) return

      results.push({
        id:             best.pairAddress,
        symbol:         best.baseToken?.symbol || '???',
        name:           best.baseToken?.name   || 'Unknown',
        address:        best.baseToken?.address || '',
        pairAddress:    best.pairAddress || '',
        priceUsd:       best.priceUsd || '0',
        priceChange24h: parseFloat(best.priceChange?.h24 || 0),
        volume24h:      best.volume?.h24    || 0,
        marketCap:      best.marketCap || best.fdv || 0,
        liquidity:      best.liquidity?.usd || 0,
        logoUrl:        best.info?.imageUrl || profile.icon || null,
        description:    best.info?.description || profile.description || '',
        pairCreatedAt:  best.pairCreatedAt || null,
        isHistorical:   false,
        isLegend:       false,
        isCooling:      false,
        coolingLabel:   null,
        source:         'dex_new',
        dexUrl:         best.url || `https://dexscreener.com/solana/${best.pairAddress}`,
      })
    })

    console.log(`[NewPairs] ${results.length} new pairs from DEXScreener profiles`)
    return results
  } catch (err) {
    console.warn('DEXScreener new pairs fetch failed:', err.message)
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

// ─── Dump detection ──────────────────────────────────────────────
// A token showing +1164% 24h but sitting at $7K mcap after a $800K peak
// is a dump, not a runner. Cross-reference current mcap vs stored peak.
const isDumped = (alpha) => {
  const peak    = alpha.peakMarketCap || 0
  const current = alpha.marketCap     || 0
  if (peak < 50_000)   return false  // Too small to have meaningful peak data
  if (current === 0)   return false
  return (current / peak) < 0.25     // Lost 75%+ from peak = dumped
}

// Approximate weekly performance from stored mcap data
// Not exact (we don't have OHLC) but meaningful directional signal
const getWeeklyContext = (alpha) => {
  const mcapNow      = alpha.marketCap     || 0
  const mcapFirst    = alpha.mcapAtFirstSeen || 0
  const mcapPeak     = alpha.peakMarketCap  || 0
  const ageMs        = Date.now() - (alpha.firstSeen || Date.now())
  const ageDays      = ageMs / 86400000

  if (ageDays < 1 || mcapFirst === 0) return null

  const changeSinceFirst = mcapFirst > 0 ? ((mcapNow - mcapFirst) / mcapFirst) * 100 : 0
  const drawdownFromPeak = mcapPeak  > 0 ? ((mcapNow - mcapPeak)  / mcapPeak)  * 100 : 0

  return {
    ageDays:          Math.round(ageDays),
    changeSinceFirst: Math.round(changeSinceFirst),
    drawdownFromPeak: Math.round(drawdownFromPeak),
    peakMarketCap:    mcapPeak,
  }
}

// ─── Core: Price action classifies fresh tokens ──────────────────
const classifyByPriceAction = (alphas) => {
  const live    = []
  const cooling = []

  alphas.forEach((alpha) => {
    if (isJunk(alpha)) return

    const change  = Math.min(Math.max(parseFloat(alpha.priceChange24h) || 0, -100), 5000)
    const volume  = alpha.volume24h || 0
    const mcap    = alpha.marketCap || 0
    const dumped  = isDumped(alpha)
    const weekCtx = getWeeklyContext(alpha)

    // Dumped tokens go straight to cooling regardless of 24h %
    // This fixes the $Wisoldman problem: +1164% 24h but down 95% from peak
    if (dumped) {
      cooling.push({
        ...alpha,
        isCooling:      true,
        isDumped:        true,
        weeklyContext:   weekCtx,
        coolingLabel:    `Dumped — ${weekCtx?.drawdownFromPeak?.toFixed(0) || '?'}% from peak`,
      })
      return
    }

    // pumpfun_bonded: real post-bond DEX data — classify normally like any token
    // pumpfun_pre: approaching graduation — no real price data, surface as live signal
    if (alpha.source === 'pumpfun_pre') {
      if (volume >= COOLING_MIN_VOLUME && mcap >= COOLING_MIN_MCAP) {
        live.push({
          ...alpha,
          weeklyContext: weekCtx,
          coolingLabel:  `🎓 ${alpha.bondingProgress || '?'}% to graduation`,
        })
      }
      return
    }

    // pumpfun_bonded falls through to normal classification below (has real priceChange24h)

    if (change > LIVE_MIN_CHANGE && volume >= LIVE_MIN_VOLUME) {
      live.push({ ...alpha, weeklyContext: weekCtx })
    } else if (change < 0 && volume >= COOLING_MIN_VOLUME && mcap >= COOLING_MIN_MCAP) {
      cooling.push({
        ...alpha,
        isCooling:    true,
        weeklyContext: weekCtx,
        coolingLabel: 'Watching for reversal',
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
  const [liveAlphas,        setLiveAlphas]        = useState([])
  const [coolingAlphas,     setCoolingAlphas]     = useState([])
  const [positioningAlphas, setPositioningAlphas] = useState([])
  const [legends]                                  = useState(LEGENDS)
  const [loading,           setLoading]           = useState(true)
  const [isRefreshing,      setIsRefreshing]      = useState(false)
  const [error,             setError]             = useState(null)
  const [lastUpdated,       setLastUpdated]       = useState(null)

  const fetchLive = useCallback(async () => {
    // First load → show skeletons. Subsequent → silent refresh, keep existing list visible
    const isFirstLoad = liveAlphas.length === 0
    if (isFirstLoad) setLoading(true)
    else             setIsRefreshing(true)
    setError(null)

    try {
      const [boosted, profiles, pumpfun, newPairs] = await Promise.allSettled([
        fetchBoostedAlphas(),
        fetchProfileAlphas(),
        fetchPumpFunBonded(),
        fetchNewPairs(),
      ])

      const freshRaw = deduplicateAlphas([
        ...(boosted.status   === 'fulfilled' ? boosted.value   : []),
        ...(profiles.status  === 'fulfilled' ? profiles.value  : []),
        ...(pumpfun.status   === 'fulfilled' ? pumpfun.value   : []),
        ...(newPairs.status  === 'fulfilled' ? newPairs.value  : []),
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
      setPositioningAlphas(loadPositioningPlays())
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Alpha feed failed:', err.message)
      setError('Feed unavailable. Check connection.')
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [liveAlphas.length])

  useEffect(() => {
    // Load from storage immediately before first fetch completes
    const { historicalLive, historicalCooling } = loadHistoricalByPriceAction(new Set())
    setLiveAlphas(historicalLive)
    setCoolingAlphas(historicalCooling)
    setPositioningAlphas(loadPositioningPlays())
    fetchLive()
  }, [fetchLive])

  useEffect(() => {
    const interval = setInterval(fetchLive, 60_000)
    return () => clearInterval(interval)
  }, [fetchLive])

  return {
    liveAlphas,
    coolingAlphas,
    positioningAlphas,
    legends,
    loading,
    isRefreshing,
    error,
    lastUpdated,
    refresh: fetchLive,
  }
}

export default useAlphas