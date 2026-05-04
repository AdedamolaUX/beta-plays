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

// ─── Supabase-backed history loader ───────────────────────────────────
// Fetches full token history from Supabase. Falls back to localStorage
// if the API is unavailable (cold start, offline, pre-DB data).
// Returns the same shape as the old localStorage object so all
// downstream filtering logic works unchanged.

let _historyCache     = null   // in-memory for the current session
let _historyCacheTime = 0
const HISTORY_CACHE_TTL_MS = 60_000  // re-fetch from Supabase at most once per minute

const loadNeonHistory = async () => {
  const now = Date.now()
  if (_historyCache && (now - _historyCacheTime) < HISTORY_CACHE_TTL_MS) {
    return _historyCache
  }
  try {
    const res = await fetch(`${BACKEND_URL}/api/history/full?days=7`)
    if (!res.ok) throw new Error('history/full failed')
    const { tokens } = await res.json()
    if (Array.isArray(tokens) && tokens.length > 0) {
      // Convert array to address-keyed object — same shape as localStorage seen_alphas
      const map = {}
      tokens.forEach(t => { map[t.address] = t })
      _historyCache     = map
      _historyCacheTime = now
      return map
    }
  } catch { /* fall through to localStorage */ }

  // Fallback: localStorage
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch { return {} }
}

// ─── Load historical tokens by price action ───────────────────────
// Tokens not in the current fetch cycle are classified by how they
// were performing when last seen. Price action — not API presence —
// decides whether they go to Live or Cooling.
//
// Positive 24h when last seen → Live (still a runner until proven otherwise)
// Negative 24h when last seen → Cooling (retracing, watch for reversal)

const loadHistoricalByPriceAction = async (currentAddresses, preloadedHistory = null) => {
  try {
    const existing = preloadedHistory || await loadNeonHistory()
    const now      = Date.now()

    const historicalLive    = []
    const historicalCooling = []

    Object.values(existing).forEach((a) => {
      const age         = now - (a.lastSeen || now)
      const inFeed      = currentAddresses.has(a.address)
      const change      = parseFloat(a.priceChange24h) || 0
      const volume      = a.volume24h || 0
      const mcap        = a.marketCap || 0

      // Always recompute dexUrl from token address
      if (a.address) {
        a = { ...a, dexUrl: `https://dexscreener.com/solana/${a.address}` }
      }

      if (inFeed) return
      if (age > HISTORY_MAX_AGE_MS) return
      if (volume < COOLING_MIN_VOLUME || mcap < COOLING_MIN_MCAP) return

      const ageHours    = age / 3600000
      const lastRefresh = a.priceRefreshedAt || a.lastSeen
      const refreshAge  = (now - (lastRefresh || now)) / 3600000
      const isStale     = refreshAge > 2
      const cappedChange = Math.min(Math.max(change, -100), 5000)

      const ageLabel = Math.floor(ageHours / 24) > 0
        ? `${Math.floor(ageHours / 24)}d ago`
        : ageHours > 0 ? `${Math.floor(ageHours)}h ago` : 'recently'

      const peak    = a.peakMarketCap || 0
      const dumped  = peak > 50_000 && mcap > 0 && (mcap / peak) < 0.25

      if (dumped) {
        const peakDistance = peak > 0 ? Math.round((mcap / peak) * 100) : null
        historicalCooling.push({
          ...a,
          priceChange24h: cappedChange,
          isCooling:      true,
          isDumped:       true,
          isHistorical:   true,
          cooledAt:       a.priceRefreshedAt || a.lastSeen || now,
          peakDistance,
          coolingLabel:   `Dumped — ${Math.round((1 - mcap/peak) * 100)}% from peak`,
        })
        return
      }

      if (cappedChange > LIVE_MIN_CHANGE && volume >= LIVE_MIN_VOLUME && !isStale) {
        historicalLive.push({
          ...a,
          priceChange24h: cappedChange,
          isHistorical:   true,
          coolingLabel:   null,
        })
      } else if (cappedChange < 0 || isStale) {
        const cooledAt     = a.priceRefreshedAt || a.lastSeen || now
        const cooledAgoH   = Math.round((now - cooledAt) / 3600000)
        const cooledLabel  = cooledAgoH < 1
          ? 'Cooled just now'
          : cooledAgoH < 24
            ? `Cooled ${cooledAgoH}h ago`
            : `Cooled ${Math.floor(cooledAgoH / 24)}d ago`
        const peakDistance = peak > 0 && mcap > 0 ? Math.round((mcap / peak) * 100) : null
        historicalCooling.push({
          ...a,
          priceChange24h: cappedChange,
          isCooling:      true,
          isHistorical:   true,
          cooledAt,
          peakDistance,
          volumeRising:   a.volumeRising || false,
          coolingLabel:   isStale ? `Last seen ${ageLabel}` : cooledLabel,
        })
      }
    })

    return { historicalLive, historicalCooling }
  } catch {
    return { historicalLive: [], historicalCooling: [] }
  }
}

// ─── Load positioning plays ────────────────────────────────────────
// "Positioning Plays" = tokens that:
//   1. Had a meaningful peak (>$50K mcap)
//   2. Have drawn down significantly from that peak (>40%)
//   3. Still have volume alive (someone is still interested)
//   4. Still have liquidity (can actually be traded)
//
// Sorted by: opportunity score = drawdown depth × volume aliveness
// The signal: big peak + big drawdown + still trading = degen magnet

const loadPositioningPlays = async () => {
  try {
    const existing = await loadNeonHistory()
    const now      = Date.now()

    return Object.values(existing)
      .filter(a => {
        const peak      = a.peakMarketCap || a.marketCap || 0  // use marketCap as proxy when peak not yet recorded
        const current   = a.marketCap     || 0
        const volume    = a.volume24h     || 0
        const liquidity = a.liquidity     || 0
        const age       = now - (a.firstSeen || a.lastSeen || now)

        if (peak < 50_000)     return false
        if (current === 0)     return false
        if (volume < 5_000)    return false
        if (liquidity < 3_000) return false
        if (age < 12 * 3600000) return false

        const drawdown = peak > current ? (peak - current) / peak : 0
        return drawdown >= 0.40
      })
      .map(a => {
        const peak        = a.peakMarketCap || a.marketCap || 0
        const current     = a.marketCap     || 0
        const drawdown    = peak > current ? ((peak - current) / peak) : 0
        const ageDays     = (now - (a.firstSeen || a.lastSeen || now)) / 86400000

        const volScore       = Math.min(a.volume24h / 500_000, 1)
        const drawdownScore  = Math.min(drawdown, 0.99)
        const freshnessScore = Math.max(0, 1 - ageDays / 14)
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

          // ── Volume Rising detection (3-reading rolling history) ──
          // Store last 3 volume1h readings with timestamps.
          // volumeRising = 2 of last 3 intervals show an increase AND price is negative.
          // This filters single-transaction spikes — needs consistent accumulation.
          const currentVol1h   = pair.volume?.h1 || 0
          const prevHistory    = existing[token.address]?.volumeHistory || []
          const newReading     = { vol: currentVol1h, ts: now }
          // Keep last 3 readings (newest first)
          const volumeHistory  = [newReading, ...prevHistory].slice(0, 3)

          // Compute rising count across consecutive pairs
          // Need at least 2 readings to compare
          let risingCount = 0
          for (let i = 0; i < volumeHistory.length - 1; i++) {
            if (volumeHistory[i].vol > volumeHistory[i + 1].vol) risingCount++
          }
          // 2+ of last 3 intervals rising AND price is negative = accumulation signal
          const volumeRising = volumeHistory.length >= 2
            && risingCount >= 2
            && safePriceChange < 0

          existing[token.address] = {
            ...existing[token.address],
            priceUsd:         pair.priceUsd || token.priceUsd,
            priceChange24h:   safePriceChange,
            volume24h:        pair.volume?.h24   || token.volume24h,
            volume1h:         currentVol1h,
            volumeHistory,
            volumeRising,
            marketCap:        pair.marketCap || pair.fdv || token.marketCap,
            liquidity:        pair.liquidity?.usd || token.liquidity,
            peakMarketCap:    Math.max(
              existing[token.address]?.peakMarketCap || 0,
              pair.marketCap || pair.fdv || 0
            ),
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
    // token_trending response: { data: { items: [...] } }
    // Each item: { address, symbol, name, v24hChangePercent, v24hUSD, liquidity, logoURI }
    const items = res.data?.data?.items || res.data?.data?.tokens || res.data?.data || []
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
      volumeItems = volRes.data?.data?.items || volRes.data?.data?.tokens || volRes.data?.data || []
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
      // Enrich logo if DEX didn't have it (token_trending provides logoURI)
      if (!alpha.logoUrl && token.logoURI) {
        alpha.logoUrl = token.logoURI
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

// ─── Source 6: Community Takeover (CTO) alphas ───────────────────
// DEXScreener's /community-takeovers/latest/v1 — free, no key.
// CTOs are community-revived dead tokens. High volatility, beta-rich events.
// Badge: 🔄 CTO (pulsing orange)
const fetchCTOAlphas = async () => {
  try {
    const res = await axios.get(`${BACKEND_URL}/api/cto`, { timeout: 8000 })
    const tokens = res.data?.tokens || []
    if (!tokens.length) return []

    // Resolve each CTO token to its live DEX pair for pricing
    const addresses = tokens.map(t => t.address).join(',')
    const pairsRes  = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${addresses}`,
      { timeout: 8000 }
    )
    const pairs = pairsRes.data?.pairs || []

    const results = []
    const seen    = new Set()

    for (const token of tokens) {
      const bestPair = pairs
        .filter(p =>
          p.chainId === 'solana' &&
          p.baseToken?.address === token.address &&
          (p.liquidity?.usd || 0) >= 500
        )
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]

      if (!bestPair || seen.has(token.address)) continue
      seen.add(token.address)

      const alpha      = formatAlpha(bestPair, 'cto')
      alpha.isCTO      = true
      alpha.badgeLabel = '🔄 CTO'
      if (!alpha.logoUrl && token.logoUrl) alpha.logoUrl = token.logoUrl
      if (!alpha.description && token.name) alpha.description = token.name
      results.push(alpha)
    }

    console.log(`[Source6/CTO] ${results.length} CTO alphas`)
    return results
  } catch (err) {
    console.warn('[Source6/CTO] Fetch failed (non-fatal):', err.message)
    return []
  }
}

// ─── Source 7: Recently updated token profiles ────────────────────
// DEXScreener's /token-profiles/recent-updates/v1 — free, no key.
// Catches re-launches, rebrands, CTOs that just got a profile update.
// Different signal from /latest which is brand new profiles.
const fetchRecentProfileAlphas = async () => {
  try {
    const res    = await axios.get(`${BACKEND_URL}/api/profiles/recent`, { timeout: 8000 })
    const tokens = res.data?.tokens || []
    if (!tokens.length) return []

    // Same pattern as fetchProfileAlphas — resolve addresses to pairs
    const solTokens = tokens.filter(t => t.chainId === 'solana').slice(0, 30)
    if (!solTokens.length) return []

    const addresses = solTokens.map(t => t.tokenAddress).join(',')
    const pairsRes  = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${addresses}`,
      { timeout: 8000 }
    )
    const pairs = pairsRes.data?.pairs || []

    const results = []
    const seen    = new Set()

    for (const token of solTokens) {
      const bestPair = pairs
        .filter(p =>
          p.chainId === 'solana' &&
          p.baseToken?.address === token.tokenAddress &&
          (p.liquidity?.usd || 0) >= 500
        )
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0]

      if (!bestPair || seen.has(token.tokenAddress)) continue
      seen.add(token.tokenAddress)

      const alpha = formatAlpha(bestPair, 'profile_update')
      if (!alpha.logoUrl && token.icon) alpha.logoUrl = token.icon
      if (!alpha.description && token.description) alpha.description = token.description
      results.push(alpha)
    }

    console.log(`[Source7/RecentProfiles] ${results.length} recently updated profiles`)
    return results
  } catch (err) {
    console.warn('[Source7/RecentProfiles] Fetch failed (non-fatal):', err.message)
    return []
  }
}


// ─── Source 8: Meta tokens from confirmed trending narratives ─────
// Only pulls from Tier 2 confirmed metas (≥2 tokens up 30%+ in 24h).
// These tokens may not appear in any other source — pre-validated by
// DEXScreener's editorial team as belonging to a real narrative.
const fetchMetaAlphas = async () => {
  try {
    const metasRes = await axios.get(`${BACKEND_URL}/api/metas?type=trending`, { timeout: 10000 })
    const allMetas = metasRes.data?.metas || []
    const confirmed = allMetas.filter(m => m.tier2Confirmed === true)
    if (!confirmed.length) return []

    console.log(`[Source8/Metas] ${confirmed.length} confirmed metas`)
    const results = []
    const seen    = new Set()

    for (const meta of confirmed.slice(0, 5)) {
      try {
        const metaRes = await axios.get(
          `${BACKEND_URL}/api/metas?type=meta&slug=${encodeURIComponent(meta.slug)}`,
          { timeout: 8000 }
        )
        const pairs = (metaRes.data?.pairs || [])
          .filter(p =>
            p.chainId === 'solana' &&
            p.baseToken?.address &&
            !seen.has(p.baseToken.address) &&
            parseFloat(p.priceChange?.h24 || 0) >= 30 &&
            (p.liquidity?.usd || 0) >= 500 &&
            (p.volume?.h24    || 0) >= 1000
          )
          .sort((a, b) => parseFloat(b.priceChange?.h24 || 0) - parseFloat(a.priceChange?.h24 || 0))
          .slice(0, 10)

        for (const p of pairs) {
          seen.add(p.baseToken.address)
          const alpha      = formatAlpha(p, 'meta')
          alpha.metaName   = meta.name
          alpha.metaSlug   = meta.slug
          alpha.isMeta     = true
          alpha.badgeLabel = '🔥 META'
          results.push(alpha)
        }
        console.log(`[Source8/Metas] ${meta.name}: ${pairs.length} tokens up 30%+`)
      } catch { /* non-fatal per meta */ }
    }

    console.log(`[Source8/Metas] Total: ${results.length} meta alpha tokens`)
    return results
  } catch (err) {
    console.warn('[Source8/Metas] Fetch failed:', err.message)
    return []
  }
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
    const [boosted, profiles, pumpfun, newPairs, gainers, cto, recentProfiles, metaTokens] = await Promise.allSettled([
        fetchBoostedAlphas(),
        fetchProfileAlphas(),
        fetchPumpFunBonded(),
        fetchNewPairs(),
        fetchGainersAlphas(),        // Source 5: Birdeye top gainers
        fetchCTOAlphas(),            // Source 6: DEXScreener community takeovers
        fetchRecentProfileAlphas(),  // Source 7: recently updated token profiles
        fetchMetaAlphas(),           // Source 8: tokens from confirmed trending metas
      ])

      const freshRaw = deduplicateAlphas([
        ...(boosted.status        === 'fulfilled' ? boosted.value        : []),
        ...(profiles.status       === 'fulfilled' ? profiles.value       : []),
        ...(pumpfun.status        === 'fulfilled' ? pumpfun.value        : []),
        ...(newPairs.status       === 'fulfilled' ? newPairs.value       : []),
        ...(gainers.status        === 'fulfilled' ? gainers.value        : []),
        ...(cto.status            === 'fulfilled' ? cto.value            : []),
        ...(recentProfiles.status === 'fulfilled' ? recentProfiles.value : []),
        ...(metaTokens.status     === 'fulfilled' ? metaTokens.value     : []),
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

      // ── Record alphas to Supabase (fire-and-forget) ───────────────
      // ── Record alphas to Supabase (batched) ──────────────────────────
      // Single request with all alphas instead of one request per token.
      // This was causing 300+ simultaneous DB writes on boot, saturating
      // Supabase PgBouncer handles concurrency cleanly.
      ;(async () => {
        try {
          fetch(`${BACKEND_URL}/api/record-alphas`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              alphas: freshRaw
                .filter(a => a.address && a.symbol)
                .map(a => ({
                  address:        a.address,
                  symbol:         a.symbol,
                  name:           a.name,
                  logoUrl:        a.logoUrl || a.icon,
                  marketCap:      a.marketCap,
                  volume24h:      a.volume24h,
                  priceChange24h: a.priceChange24h,
                  source:         a.source,
                  price:          a.priceUsd,
                }))
            }),
          }).catch(() => {})
        } catch { /* non-fatal */ }
      })()

      // Refresh prices for historical tokens (not in current feed)
      // Runs in background — doesn't block the UI update below
      // After it completes, re-classify so tabs show fresh prices
      const currentAddresses = new Set(freshRaw.map(a => a.address))
      // Refresh live prices for legends — they were hardcoded, now stay fresh
      refreshLegendPrices(setLegends)

      refreshHistoricalPrices().then(async () => {
        // Re-run historical classification with freshly updated prices
        const { historicalLive: freshHistLive, historicalCooling: freshHistCool } =
          await loadHistoricalByPriceAction(currentAddresses)
        const freshHistLiveAddrs = new Set(freshHistLive.map(a => a.address))
        const freshHistCoolAddrs = new Set(freshHistCool.map(a => a.address))

        // Patch live tokens stuck at bonding price — refreshHistoricalPrices just
        // wrote their real prices to localStorage so now we can read them.
        // freshStored is now read inside setLiveAlphas to avoid stale closure issues.

        setLiveAlphas(prev => {
          // FLICKER FIX: This setter runs async after refreshHistoricalPrices completes.
          // By the time it fires, the main fetch has already set the full live list (80+
          // tokens). If prev has more non-historical tokens than freshHistLive, the main
          // fetch already ran — our job here is ONLY to patch stuck prices and ADD any
          // new historical tokens, never to replace or shrink the list.
          const prevLiveCount = prev.filter(a => !a.isHistorical).length
          const freshStored   = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')

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

          const freshAddrs = new Set(patched.map(a => a.address))

          // Only add historical tokens that aren't already in the list —
          // never drop tokens the main fetch already placed there.
          const addedHistorical = freshHistLive.filter(a => !freshAddrs.has(a.address))

          return [
            ...patched,
            ...addedHistorical,
          ].sort((a, b) => (b.momentumScore || 0) - (a.momentumScore || 0)).slice(0, 100)
        })
        setCoolingAlphas(prev => {
          const freshAddrs = new Set(prev.filter(a => !a.isHistorical).map(a => a.address))
          return [
            ...prev.filter(a => !a.isHistorical),
            ...freshHistCool.filter(a => !freshAddrs.has(a.address)),
          ].sort((a, b) => {
            const aRecent = a.priceRefreshedAt || a.lastSeen || 0
            const bRecent = b.priceRefreshedAt || b.lastSeen || 0
            if (bRecent !== aRecent) return bRecent - aRecent
            return (parseFloat(a.priceChange24h) || 0) - (parseFloat(b.priceChange24h) || 0)
          }).slice(0, 50)
        })
        setPositioningAlphas(await loadPositioningPlays())
        console.log('[PriceRefresh] Tabs updated with fresh historical prices')
      }).catch(() => {})  // Silently ignore — stale data is better than a crash

      // Classify fresh tokens by price action
      const { live: freshLive, cooling: freshCooling } = classifyByPriceAction(freshRaw)

      // Load historical tokens not in current fetch
      // Split by their last-known price action — same rule applies
      const { historicalLive, historicalCooling } = await loadHistoricalByPriceAction(currentAddresses)

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
        .sort((a, b) => {
          // Primary: most recently cooled first — just-cooled tokens are most actionable
          const aRecent = a.priceRefreshedAt || a.lastSeen || 0
          const bRecent = b.priceRefreshedAt || b.lastSeen || 0
          if (bRecent !== aRecent) return bRecent - aRecent
          // Secondary: biggest dump (degens hunting gold in the rough)
          return (parseFloat(a.priceChange24h) || 0) - (parseFloat(b.priceChange24h) || 0)
        })
        .slice(0, 50)

      if (sortedLive.length === 0) {
        setError('No live runners detected. Trenches might be cooked.')
      }

      setLiveAlphas(sortedLive)
      liveAlphasRef.current = sortedLive
      setCoolingAlphas(sortedCooling)
      setPositioningAlphas(await loadPositioningPlays())
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
    // Show localStorage data INSTANTLY — zero latency, no waiting for Supabase.
    // Supabase loads in background and merges when ready.
    // This is the fix for "alpha tab takes long to populate after server restart":
    // the old loadInitial() awaited loadNeonHistory() which could take 10-15s on a cold connection
    // blocking the entire first render.
    const showLocalFirst = async () => {
      try {
        const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
        if (Object.keys(local).length > 0) {
          const { historicalLive, historicalCooling } = await loadHistoricalByPriceAction(new Set(), local)
          if (historicalLive.length > 0 || historicalCooling.length > 0) {
            setLiveAlphas(historicalLive)
            setCoolingAlphas(historicalCooling)
          }
        }
      } catch { /* silent — live fetch will populate */ }
    }
    showLocalFirst()

    // Start live fetch immediately — doesn't wait for local or Neon
    fetchLive()

    // Supabase loads in background after live fetch starts — merges silently
    // Uses a delay so the live fetch gets DB connections first (Supabase pooler handles concurrency)
    setTimeout(async () => {
      try {
        const neon = await loadNeonHistory()
        if (!neon || Object.keys(neon).length === 0) return
        const currentAddrs = new Set(
          (JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).keys?.() || []
        )
        const { historicalLive, historicalCooling } = await loadHistoricalByPriceAction(new Set(), neon)
        if (historicalLive.length > 0) {
          setLiveAlphas(prev => {
            const existing = new Set(prev.map(a => a.address))
            const added = historicalLive.filter(a => !existing.has(a.address))
            if (added.length === 0) return prev
            return [...prev, ...added].sort((a, b) => (b.momentumScore || 0) - (a.momentumScore || 0)).slice(0, 100)
          })
        }
        if (historicalCooling.length > 0) {
          setCoolingAlphas(prev => {
            const existing = new Set(prev.map(a => a.address))
            const added = historicalCooling.filter(a => !existing.has(a.address))
            if (added.length === 0) return prev
            return [...prev, ...added].slice(0, 50)
          })
        }
      } catch { /* silent — Supabase unavailable, localStorage data stays */ }
    }, 5000)  // 5s delay — live fetch gets DB connections priority
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