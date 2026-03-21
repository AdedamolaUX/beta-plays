import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import LEGENDS, { LEGEND_CRITERIA, checkLegendCriteria } from '../data/historical_alphas'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const BACKEND_URL      = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// ─── Thresholds ──────────────────────────────────────────────────
const LIVE_MIN_CHANGE    =  0
const LIVE_MIN_VOLUME    = 10_000
const COOLING_MIN_VOLUME =  1_000  // Lowered — small tokens that dump still deserve a cooling entry
const COOLING_MIN_MCAP   =  1_000  // Lowered — catches $1.8K mcap tokens like $KARATECHUCK
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
      const isFreshBonded = alpha.source === 'pumpfun_bonded'

      // Guard: if we already have a verified DEXScreener price (priceRefreshedAt set,
      // mcap > 80K) and incoming data looks like a bonding-curve snapshot (mcap ≤ 80K,
      // priceChange24h = 0), keep the good data. PumpFun's API actively corrupts prices
      // on every feed cycle for graduated tokens whose pool lookup returned no mcap.
      const incomingLooksStale = (alpha.marketCap || 0) <= 50_000 && safePriceChange === 0
      const haveGoodPrice = prev?.priceRefreshedAt && (prev.marketCap || 0) > 50_000
      if (incomingLooksStale && haveGoodPrice) {
        // Only update lastSeen — keep all price fields from the verified refresh
        existing[alpha.address] = {
          ...existing[alpha.address],
          lastSeen: now,
        }
        return
      }

      existing[alpha.address] = {
        ...alpha,
        priceChange24h:  safePriceChange,
        firstSeen:       prev?.firstSeen || Date.now(),
        lastSeen:        Date.now(),
        // bonded data always wins on mcap — never let old pre-grad price persist
        marketCap:       isFreshBonded ? (alpha.marketCap || 0) : (alpha.marketCap || prev?.marketCap || 0),
        peakMarketCap:   Math.max(prevPeak, alpha.marketCap || 0),
        mcapAtFirstSeen: (isFreshBonded && prev?.source === 'pumpfun_pre')
          ? alpha.marketCap || 0   // Reset first-seen mcap when we get real post-bond data
          : (prev?.mcapAtFirstSeen || alpha.marketCap || 0),

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

      // Always recompute dexUrl from token address — pair addresses go stale
      // when tokens migrate from Pump.fun → PumpSwap. Token address is permanent.
      if (a.address) {
        a = { ...a, dexUrl: `https://dexscreener.com/solana/${a.address}` }
      }

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
      // Use priceRefreshedAt when available — refreshHistoricalPrices updates
      // prices without touching lastSeen (correct behaviour). A token refreshed
      // 5 minutes ago is NOT stale even if last seen in feed 3 hours ago.
      const lastRefresh = a.priceRefreshedAt || a.lastSeen
      const refreshAge  = (now - lastRefresh) / 3600000
      const isStale     = refreshAge > 2
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
      .slice(0, 50)

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
  // Use base token address for DEX link — this ensures migrated tokens
  // (e.g. pump.fun → PumpSwap) always land on the current active pair,
  // not the stale pre-migration pair which shows inflated % from the pump.
  dexUrl: pair.baseToken?.address
    ? `https://dexscreener.com/solana/${pair.baseToken.address}`
    : (pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`),
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
      `${BACKEND_URL}/api/pumpfun?path=coins&sort=last_trade_timestamp&order=DESC&limit=100&includeNsfw=false`,
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

      // Collect any tokens whose pool lookup returned nothing — we'll retry by mint
      const missedCoins = []

      pairFetches.forEach(result => {
        if (result.status !== 'fulfilled') return
        const { coin, pairs } = result.value

        // Find the best Solana pair by volume
        const best = pairs
          .filter(p => p.chainId === 'solana')
          .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]

        if (!best) {
          // Pool address lookup failed — queue retry by token mint address
          missedCoins.push(coin)
          return
        }

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
          dexUrl:          best.baseToken?.address
            ? `https://dexscreener.com/solana/${best.baseToken.address}`
            : (best.url || `https://dexscreener.com/solana/${best.pairAddress}`),
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

    // ── Retry missed bonded tokens by mint address ──────────────
    // When the pool address lookup fails (DEXScreener doesn't index it yet),
    // try fetching by the token's own mint address instead — more reliable.
    if (missedCoins.length > 0) {
      const retryFetches = await Promise.allSettled(
        missedCoins.slice(0, 10).map(coin =>
          axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${coin.mint}`, { timeout: 6000 })
            .then(r => ({ coin, pairs: r.data?.pairs || [] }))
        )
      )
      retryFetches.forEach(result => {
        if (result.status !== 'fulfilled') return
        const { coin, pairs } = result.value
        const best = pairs
          .filter(p => p.chainId === 'solana')
          .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]
        if (!best) return
        const postBondMcap = best.marketCap || best.fdv || 0
        bondedResults.push({
          id:              best.pairAddress || coin.mint,
          symbol:          best.baseToken?.symbol || coin.symbol || '???',
          name:            best.baseToken?.name   || coin.name   || 'Unknown',
          address:         best.baseToken?.address || coin.mint  || '',
          pairAddress:     best.pairAddress || '',
          priceUsd:        best.priceUsd || '0',
          priceChange24h:  parseFloat(best.priceChange?.h24 || 0),
          volume24h:       best.volume?.h24    || 0,
          marketCap:       postBondMcap,
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
          dexUrl:          best.baseToken?.address
            ? `https://dexscreener.com/solana/${best.baseToken.address}`
            : (best.url || `https://dexscreener.com/solana/${best.pairAddress}`),
        })
      })
      console.log(`[PumpFun] Retry by mint: ${bondedResults.length - (bondedResults.length - retryFetches.filter(r => r.status === 'fulfilled').length)} recovered`)
    }

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
    // DEXScreener new pairs endpoint — genuinely new trading pairs on Solana
    // Different from token-profiles which fetchProfileAlphas already covers
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/pairs/solana/new`,
      { timeout: 8000 }
    )
    const pairs = (res.data?.pairs || [])
      .filter(p =>
        p.chainId === 'solana' &&
        (p.volume?.h24 || 0) >= 5_000 &&
        (p.liquidity?.usd || 0) >= 1_000 &&
        (p.priceChange?.h24 || 0) > 20  // Must be moving up
      )
      .slice(0, 20)

    if (pairs.length === 0) return []

    const results = pairs.map(p => formatAlpha(p, 'dex_new'))
    console.log(`[NewPairs] ${results.length} new Solana pairs`)
    return results

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

// ─── Batch price refresh for historical tokens ───────────────────
// DEXScreener accepts up to 30 addresses per call (comma-separated).
// We use this to refresh prices for tokens that dropped out of the
// live feed — so Cooling/Positioning never show stale snapshots.
//
// Called after every main feed refresh (60s cycle).
// Updates localStorage in-place so classification re-runs with
// fresh mcap, priceChange24h, volume, and liquidity.

const refreshHistoricalPrices = async () => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const now      = Date.now()

    // Refresh two categories:
    // 1. Historical tokens (not seen in 2+ min) — standard refresh
    // 2. ANY token stuck at bonding-curve mcap (≤50K), regardless of priceChange24h.
    //    Previously gated on priceChange24h===0 but tokens like $Sugarswaps arrive
    //    with 691% change while still showing the $35K graduation snapshot.
    //    Any non-pre-grad token at ≤$50K needs a live price, full stop.
    const toRefresh = Object.values(existing).filter(a => {
      if (!a.address) return false
      const age = now - (a.lastSeen || 0)
      const isHistorical = age > 2 * 60 * 1000 && age < HISTORY_MAX_AGE_MS
      const isStuckAtBonding = (a.marketCap || 0) <= 50_000 &&
        a.source !== 'pumpfun_pre'  // pre-grad tokens legitimately have no real price
      return isHistorical || isStuckAtBonding
    })

    if (toRefresh.length === 0) return

    // Batch into groups of 30 (DEXScreener limit)
    const BATCH = 30
    for (let i = 0; i < toRefresh.length; i += BATCH) {
      const batch   = toRefresh.slice(i, i + BATCH)
      const addrs   = batch.map(a => a.address).join(',')

      try {
        const res   = await axios.get(
          `${DEXSCREENER_BASE}/latest/dex/tokens/${addrs}`,
          { timeout: 10000 }
        )
        const pairs = res.data?.pairs || []

        // Build a map: tokenAddress → best pair (highest volume on Solana)
        const bestPair = {}
        pairs
          .filter(p => p.chainId === 'solana')
          .forEach(p => {
            const addr = p.baseToken?.address
            if (!addr) return
            const prev = bestPair[addr]
            if (!prev || (p.volume?.h24 || 0) > (prev.volume?.h24 || 0)) {
              bestPair[addr] = p
            }
          })

        // Update localStorage with fresh price data
        batch.forEach(token => {
          const pair = bestPair[token.address]

          // ── Dead token detection ───────────────────────────────
          // If DEX returns no pairs for this address, the token has been
          // delisted (rugged, liquidity fully removed, or abandoned).
          // Mark it dead so the UI removes it from the live feed.
          // We also catch tokens that technically have a pair but with
          // effectively zero activity — these are ghost tokens with
          // fake or frozen mcap (e.g. $MAX with $118M mcap, 2 txns total).
          // If DEX returns no pair for this token, just skip — don't update price.
          // Token will naturally age out via the 30-day TTL.
          if (!pair) return

          const safePriceChange = Math.min(
            Math.max(parseFloat(pair.priceChange?.h24 || 0), -100),
            5000
          )

          existing[token.address] = {
            ...existing[token.address],
            priceUsd:       pair.priceUsd || token.priceUsd,
            priceChange24h: safePriceChange,
            volume24h:      pair.volume?.h24    || token.volume24h,
            marketCap:      pair.marketCap || pair.fdv || token.marketCap,
            liquidity:      pair.liquidity?.usd  || token.liquidity,
            // Update peakMarketCap if current is higher
            peakMarketCap:  Math.max(
              existing[token.address]?.peakMarketCap || 0,
              pair.marketCap || pair.fdv || 0
            ),
            // lastSeen intentionally NOT updated — that tracks when we saw it in the feed
            // We use a separate field to track when price was last refreshed
            priceRefreshedAt: now,
          }
        })

        console.log(`[PriceRefresh] Updated ${Object.keys(bestPair).length}/${batch.length} historical tokens`)
      } catch (batchErr) {
        console.warn(`[PriceRefresh] Batch failed:`, batchErr.message)
      }

      // Small delay between batches to avoid hammering DEXScreener
      if (i + BATCH < toRefresh.length) {
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
  } catch (err) {
    console.warn('[PriceRefresh] Failed:', err.message)
  }
}

// ─── Source 5: Birdeye top gainers ───────────────────────────────
// Finds organic runners NOT in DEXScreener's boost/profile feeds.
// Uses Birdeye's trending endpoint sorted by 24h % change.
// This catches tokens like $MOE (+8500%) that never paid for a boost.
const fetchGainersAlphas = async () => {
  try {
    const res = await axios.get(
      `${BACKEND_URL}/api/birdeye?endpoint=trending`,
      { timeout: 10000 }
    )
    // tokenlist response: { data: { tokens: [...] } }
    // token_trending response: { data: { items: [...] } }
    // Handle both formats
    const items = res.data?.data?.tokens || res.data?.data?.items || res.data?.data || []
    if (!items.length) {
      console.warn('[Source5/Birdeye] Empty response — check API key and endpoint')
      return []
    }

    console.log(`[Source5/Birdeye] Raw items from API: ${items.length}`)

    // Also fetch top volume tokens — catches runners with huge vol but moderate % change
    let volumeItems = []
    try {
      const volRes = await axios.get(
        `${BACKEND_URL}/api/birdeye?endpoint=top_volume`,
        { timeout: 10000 }
      )
      volumeItems = volRes.data?.data?.tokens || volRes.data?.data?.items || volRes.data?.data || []
      console.log(`[Source5/Birdeye] Top volume items: ${volumeItems.length}`)
    } catch { /* silent */ }

    // Merge and deduplicate by address
    const seen = new Set()
    const allItems = [...items, ...volumeItems].filter(t => {
      if (!t.address || seen.has(t.address)) return false
      seen.add(t.address)
      return true
    })

    // Filter: must have meaningful 24h change OR high volume
    const solanaItems = allItems
      .filter(t =>
        (t.v24hChangePercent || 0) > 5 ||
        (t.v24hUSD || 0) > 50_000
      )
      .slice(0, 50)

    console.log(`[Source5/Birdeye] After merge+filter: ${solanaItems.length} candidates`)

    const pairResults = await Promise.allSettled(
      solanaItems.map(t =>
        axios.get(`${DEXSCREENER_BASE}/latest/dex/tokens/${t.address}`, { timeout: 5000 })
          .then(r => ({ token: t, pairs: r.data?.pairs || [] }))
      )
    )

    const results = []
    pairResults.forEach(result => {
      if (result.status !== 'fulfilled') return
      const { token, pairs } = result.value

      const best = pairs
        .filter(p =>
          p.chainId === 'solana' &&
          (p.volume?.h24 || 0) >= 5_000 &&
          (p.liquidity?.usd || 0) >= 1_000
        )
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]

      if (!best) return

      const alpha = formatAlpha(best, 'birdeye_trending')
      // Enrich with Birdeye data if DEX description is empty
      if (!alpha.description && token.name) {
        alpha.description = token.extensions?.description || ''
      }
      results.push(alpha)
    })

    console.log(`[Source5/Birdeye] Found ${results.length} gainers`)
    return results
  } catch (err) {
    console.warn('[Source5/Birdeye] Trending fetch failed (non-fatal):', err.message)
    return []
  }
}

// ─── Main hook ───────────────────────────────────────────────────
// ─── Legend price refresh ────────────────────────────────────────
// Legends had hardcoded stale prices. This fetches live data for each
// legend from DEXScreener and updates state — same pattern as historical tokens.
const refreshLegendPrices = async (setLegends) => {
  try {
    const updated = await Promise.all(
      LEGENDS.map(async (legend) => {
        try {
          // Use token endpoint — works with mint/token addresses across chains
          const res = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${legend.address}`,
            { timeout: 5000 }
          )
          // Pick highest-liquidity pair as canonical price source
          const pairs = res.data?.pairs || []
          if (!pairs.length) return legend
          const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
          return {
            ...legend,
            priceUsd:       best.priceUsd         || legend.priceUsd,
            priceChange24h: best.priceChange?.h24 || 0,
            volume24h:      best.volume?.h24      || legend.volume24h,
            marketCap:      best.marketCap        || legend.marketCap,
            liquidity:      best.liquidity?.usd   || legend.liquidity,
            logoUrl:        best.info?.imageUrl   || legend.logoUrl,
          }
        } catch { return legend }
      })
    )
    setLegends(updated)
  } catch {}
}

// ─── Algorithm auto-promotion check ──────────────────────────────
// Checks if any token in the live/cooling feed qualifies for Legend status.
// Qualifying tokens are flagged as candidateLegend — you still approve manually.
// Criteria: age ≥ 1yr, mcap ≥ $50M, volume + liquidity still alive.
// Beta spawn count is tracked via localStorage betaSpawnCounts key.
export const checkLegendCandidates = (alphas) => {
  const now = Date.now()
  const ONE_YEAR = 365 * 24 * 60 * 60 * 1000
  const existingAddresses = new Set(LEGENDS.map(l => l.address))

  return alphas.filter(alpha => {
    if (existingAddresses.has(alpha.address)) return false  // already a legend
    const age        = alpha.pairCreatedAt ? now - alpha.pairCreatedAt : 0
    const mcap       = alpha.marketCap     || 0
    const vol        = alpha.volume24h     || 0
    const liq        = alpha.liquidity     || 0

    // Check beta spawn count from localStorage
    let betaCount = 0
    try {
      const spawnData = JSON.parse(localStorage.getItem('betaplays_beta_spawn_counts') || '{}')
      betaCount = spawnData[alpha.address] || 0
    } catch {}

    // Use peak mcap — legend status based on historical significance, not current price
    const peakMcap = alpha.peakMarketCap || mcap
    return (
      age       >= ONE_YEAR                         &&
      peakMcap  >= LEGEND_CRITERIA.minPeakMcap      &&
      betaCount >= LEGEND_CRITERIA.minBetasSpawned
    )
  }).map(a => ({ ...a, candidateLegend: true }))
}

const useAlphas = () => {
  const [liveAlphas,        setLiveAlphas]        = useState([])
  const [coolingAlphas,     setCoolingAlphas]     = useState([])
  const [positioningAlphas, setPositioningAlphas] = useState([])
  const [legends, setLegends]                       = useState(LEGENDS)
  const [loading,           setLoading]           = useState(true)
  const [isRefreshing,      setIsRefreshing]      = useState(false)
  const [error,             setError]             = useState(null)
  const [lastUpdated,       setLastUpdated]       = useState(null)

  const liveAlphasRef = useRef([])

  const fetchLive = useCallback(async () => {
    // First load → show skeletons. Subsequent → silent refresh, keep existing list visible
    const isFirstLoad = liveAlphasRef.current.length === 0
    if (isFirstLoad) setLoading(true)
    else             setIsRefreshing(true)
    setError(null)

    try {
      const [boosted, profiles, pumpfun, newPairs, gainers] = await Promise.allSettled([
        fetchBoostedAlphas(),
        fetchProfileAlphas(),
        fetchPumpFunBonded(),
        fetchNewPairs(),
        fetchGainersAlphas(),  // Source 5: Birdeye top gainers — organic non-boosted runners
      ])

      const freshRaw = deduplicateAlphas([
        ...(boosted.status   === 'fulfilled' ? boosted.value   : []),
        ...(profiles.status  === 'fulfilled' ? profiles.value  : []),
        ...(pumpfun.status   === 'fulfilled' ? pumpfun.value   : []),
        ...(newPairs.status  === 'fulfilled' ? newPairs.value  : []),
        ...(gainers.status   === 'fulfilled' ? gainers.value   : []),
      ])

      // ── Immediate bonding-price fix for freshly migrated tokens ──
      // Tokens like $Reggae arrive in freshRaw at exactly $35K (the graduation
      // threshold) with 0% change. refreshHistoricalPrices can't help them
      // because they're not in localStorage yet. patchedLive can't help because
      // priceRefreshedAt isn't stamped yet. We fix them HERE, before saveToHistory,
      // so they enter the system with the correct post-migration price from the start.
      // Any non-pre-grad token sitting at bonding mcap (≤$80K) needs a live
      // DEXScreener price regardless of its reported priceChange24h.
      // Previously we gated on priceChange24h===0, which excluded tokens like
      // $Sugarswaps that showed 691% from PumpFun's API while still stuck at
      // the $35K graduation snapshot.
      const freshBonded = freshRaw.filter(a =>
        (a.marketCap || 0) <= 50_000 &&
        a.source !== 'pumpfun_pre'
      )
      if (freshBonded.length > 0) {
        try {
          const addrs = freshBonded.map(a => a.address).join(',')
          const res   = await axios.get(
            `${DEXSCREENER_BASE}/latest/dex/tokens/${addrs}`,
            { timeout: 10000 }
          )
          const bestPair = {}
          ;(res.data?.pairs || [])
            .filter(p => p.chainId === 'solana')
            .forEach(p => {
              const addr = p.baseToken?.address
              if (!addr) return
              const prev = bestPair[addr]
              if (!prev || (p.volume?.h24 || 0) > (prev.volume?.h24 || 0)) bestPair[addr] = p
            })
          freshBonded.forEach(token => {
            const pair = bestPair[token.address]
            if (!pair) return
            const idx = freshRaw.findIndex(a => a.address === token.address)
            if (idx === -1) return
            const realMcap   = pair.marketCap || pair.fdv || token.marketCap
            const realChange = Math.min(Math.max(parseFloat(pair.priceChange?.h24 || 0), -100), 5000)
            freshRaw[idx] = {
              ...freshRaw[idx],
              priceUsd:        pair.priceUsd || token.priceUsd,
              priceChange24h:  realChange,
              volume24h:       pair.volume?.h24    || token.volume24h,
              marketCap:       realMcap,
              liquidity:       pair.liquidity?.usd  || token.liquidity,
              priceRefreshedAt: Date.now(),
            }
            console.log(`[FreshRefresh] $${token.symbol}: $${token.marketCap?.toLocaleString()} → $${realMcap?.toLocaleString()} | 24h: ${realChange}%`)
          })
        } catch (err) {
          console.warn('[FreshRefresh] Failed (non-fatal):', err.message)
        }
      }

      // Save everything to localStorage before classifying
      saveToHistory(freshRaw)

      // Refresh prices for historical tokens (not in current feed)
      // Runs in background — doesn't block the UI update below
      // After it completes, re-classify so tabs show fresh prices
      const currentAddresses = new Set(freshRaw.map(a => a.address))
      // Refresh live prices for legends — they were hardcoded, now stay fresh
      refreshLegendPrices(setLegends)

      refreshHistoricalPrices().then(() => {
        // Re-run historical classification with freshly updated prices
        const { historicalLive: freshHistLive, historicalCooling: freshHistCool } =
          loadHistoricalByPriceAction(currentAddresses)
        const freshHistLiveAddrs = new Set(freshHistLive.map(a => a.address))
        const freshHistCoolAddrs = new Set(freshHistCool.map(a => a.address))

        // Patch live tokens stuck at bonding price — refreshHistoricalPrices just
        // wrote their real prices to localStorage so now we can read them.
        // This is the fix for $WIZCLI/$lmeow stuck at $35K in the sidebar:
        // they're LIVE (not historical) so loadHistoricalByPriceAction skips them,
        // but refreshHistoricalPrices now targets them via isStuckAtBonding flag.
        const freshStored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')

        setLiveAlphas(prev => {
          const patched = prev.map(a => {
            const isStuck = (a.marketCap || 0) <= 50_000 && parseFloat(a.priceChange24h || 0) === 0
            const stored  = freshStored[a.address]
            const hasGood = stored?.priceRefreshedAt && (stored.marketCap || 0) > 50_000
            if (isStuck && hasGood) {
              console.log(`[AlphaRefresh] ✅ $${a.symbol}: $${(a.marketCap||0).toLocaleString()} → $${(stored.marketCap||0).toLocaleString()} | 24h: ${stored.priceChange24h}%`)
              return { ...a, ...stored, momentumScore: getMomentumScore({ ...a, ...stored }) }
            }
            return a
          })
          const freshAddrs = new Set(patched.filter(a => !a.isHistorical).map(a => a.address))
          return [
            ...patched.filter(a => !a.isHistorical),
            ...freshHistLive.filter(a => !freshAddrs.has(a.address)),
          ].sort((a, b) => (b.momentumScore || 0) - (a.momentumScore || 0)).slice(0, 100)
        })
        setCoolingAlphas(prev => {
          const freshAddrs = new Set(prev.filter(a => !a.isHistorical).map(a => a.address))
          return [
            ...prev.filter(a => !a.isHistorical),
            ...freshHistCool.filter(a => !freshAddrs.has(a.address)),
          ].sort((a, b) => (parseFloat(a.priceChange24h) || 0) - (parseFloat(b.priceChange24h) || 0)).slice(0, 50)
        })
        setPositioningAlphas(loadPositioningPlays())
        console.log('[PriceRefresh] Tabs updated with fresh historical prices')
      }).catch(() => {})  // Silently ignore — stale data is better than a crash

      // Classify fresh tokens by price action
      const { live: freshLive, cooling: freshCooling } = classifyByPriceAction(freshRaw)

      // Load historical tokens not in current fetch
      // Split by their last-known price action — same rule applies
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
      // Before sorting, patch any live runner stuck at bonding-curve price.
      // These tokens are in the live feed but fetchPumpFunBonded returned
      // null mcap from DEXScreener — read their refreshed price from localStorage.
      const storedAlphas = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      const patchedLive = allLive.map(a => {
        const stored = storedAlphas[a.address]
        const isStuck = (a.marketCap || 0) <= 50_000 && parseFloat(a.priceChange24h || 0) === 0
        const hasGoodStored = stored?.priceRefreshedAt && (stored.marketCap || 0) > 50_000
        if (isStuck && hasGoodStored) {
          console.log(`[AlphaRefresh] Patching $${a.symbol}: $${a.marketCap?.toLocaleString()} → $${stored.marketCap?.toLocaleString()}`)
          return { ...a, ...stored, momentumScore: undefined }
        }
        return a
      })

      const sortedLive = patchedLive

        .map(a => ({ ...a, momentumScore: getMomentumScore(a) }))
        .sort((a, b) => b.momentumScore - a.momentumScore)
        .slice(0, 100)

      const sortedCooling = allCooling
        .sort((a, b) => (parseFloat(a.priceChange24h) || 0) - (parseFloat(b.priceChange24h) || 0))
        .slice(0, 50)

      if (sortedLive.length === 0) {
        setError('No live runners detected. Trenches might be cooked.')
      }

      setLiveAlphas(sortedLive)
      liveAlphasRef.current = sortedLive
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
  }, [])  // No state dependencies — uses ref for first-load check to prevent infinite loop

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