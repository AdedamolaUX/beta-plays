import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { getSearchTerms, getConcepts, generateTickerVariants } from '../data/lore_map'
import scoreWithAI from './useAIBetaScoring'
import { compareLogos, shouldRunVision } from './useImageAnalysis'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const PUMPFUN_BASE     = 'https://frontend-api.pump.fun'
const MIN_LIQUIDITY    = 5000

// ─── Compound ticker decomposition ──────────────────────────────
const DECOMP_SUFFIXES = [
  'SCOPE', 'COIN', 'TOKEN', 'SWAP', 'PLAY', 'GAME', 'WORLD',
  'LAND', 'ZONE', 'CAT', 'DOG', 'HAT', 'WIF', 'INU', 'DAO',
  'MOON', 'PUMP', 'STAR', 'KING', 'LORD', 'APE', 'BOY', 'MAN',
  'GIRL', 'SON', 'ZEN', 'FI', 'PAD', 'NET', 'BIT', 'PAY',
]
const DECOMP_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
  'REAL', 'TURBO', 'CHAD', 'FAT', 'TINY', 'DARK', 'ULTRA',
  'MEAN', 'EVIL', 'BASED', 'LITTLE', 'BIG', 'GOOD',
  'BAD', 'MAD', 'WILD', 'HOLY', 'DEGEN', 'PURE',
]

const decomposeSymbol = (symbol) => {
  const s = symbol.toUpperCase()
  const parts = new Set()

  DECOMP_SUFFIXES.forEach((suffix) => {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      const root = s.slice(0, s.length - suffix.length)
      if (root.length >= 3) { parts.add(root); parts.add(suffix) }
    }
  })

  DECOMP_PREFIXES.forEach((prefix) => {
    if (s.startsWith(prefix) && s.length > prefix.length + 2) {
      const root = s.slice(prefix.length)
      if (root.length >= 3) parts.add(root)
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

// ─── Vector 1: Description keyword extraction ────────────────────
// Fetch the token's DEXScreener profile and extract meaningful
// keywords from its description text. This surfaces betas that
// share narrative universe without sharing ticker similarity.
// e.g. $AlienScope description: "alien surveillance files trump"
//      → search for alien, surveillance, trump → finds $ALIEN, $TRUMP etc

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
  'for', 'of', 'with', 'by', 'from', 'up', 'is', 'are', 'was',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our',
  'you', 'your', 'they', 'their', 'he', 'she', 'his', 'her',
  'not', 'no', 'so', 'if', 'as', 'all', 'any', 'can', 'just',
  'than', 'then', 'when', 'where', 'who', 'how', 'what', 'which',
  'about', 'into', 'through', 'token', 'coin', 'crypto', 'solana',
  'pump', 'moon', 'hold', 'buy', 'sell', 'trading', 'market',
  'price', 'chart', 'wallet', 'contract', 'launch', 'fair',
])

const extractDescriptionKeywords = (description) => {
  if (!description || description.length < 10) return []

  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w =>
      w.length >= 4 &&
      w.length <= 20 &&
      !STOP_WORDS.has(w) &&
      !/^\d+$/.test(w)        // Skip pure numbers
    )

  // Deduplicate and take top 6 most meaningful words
  // Prioritise longer words as they're more specific
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
}

const fetchDescriptionKeywords = async (alpha) => {
  try {
    // If description was already saved at fetch time (PumpFun or profile), use it
    if (alpha.description && alpha.description.length > 10) {
      const keywords = extractDescriptionKeywords(alpha.description)
      console.log(`[Vector1] ${alpha.symbol} cached description → ${keywords.length} keywords`)
      return { keywords, description: alpha.description }
    }

    // Otherwise fetch from DEXScreener
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${alpha.address}`,
      { timeout: 6000 }
    )
    const pairs = res.data?.pairs || []
    if (pairs.length === 0) return { keywords: [], description: '' }

    const pair = pairs[0]
    const description =
      pair.info?.description ||
      pair.baseToken?.description ||
      ''

    const keywords = extractDescriptionKeywords(description)
    console.log(`[Vector1] ${alpha.symbol} description keywords:`, keywords)
    return { keywords, description }
  } catch (err) {
    console.warn('Description fetch failed:', err.message)
    return { keywords: [], description: '' }
  }
}

// ─── Vector 6: LP Pair Scraping ──────────────────────────────────
// The most explicit beta signal: a token paired directly against
// the alpha token (not SOL/USDC). If $HARVEY/$SHIRLEY pool exists,
// that's an undeniable relationship. No ambiguity, no scoring.

const fetchLPPairBetas = async (alpha) => {
  if (!alpha.address) return []

  try {
    // Search for tokens that have a pair with the alpha's address
    const res = await axios.get(
      `${DEXSCREENER_BASE}/latest/dex/search?q=${alpha.address}`,
      { timeout: 8000 }
    )

    const pairs = res.data?.pairs || []

    return pairs
      .filter(p => {
        if (p.chainId !== 'solana') return false
        if ((p.liquidity?.usd || 0) < MIN_LIQUIDITY) return false

        // The key check: is the alpha token one of the pair tokens?
        const quoteAddr  = p.quoteToken?.address || ''
        const baseAddr   = p.baseToken?.address  || ''
        const alphaAddr  = alpha.address

        const isDirectPair =
          quoteAddr === alphaAddr ||
          baseAddr  === alphaAddr

        // Exclude the alpha itself
        const isNotAlpha  = baseAddr !== alphaAddr

        return isDirectPair && isNotAlpha
      })
      .map(p => ({ pair: p, sources: ['lp_pair'] }))
  } catch (err) {
    console.warn('LP pair scraping failed:', err.message)
    return []
  }
}

// ─── Wave Phase (Vector 3) ───────────────────────────────────────
export const getWavePhase = (alpha, beta) => {
  const betaAge = beta?.pairCreatedAt ? Date.now() - beta.pairCreatedAt : null
  if (!betaAge) return { label: 'UNKNOWN', color: 'var(--text-muted)', tier: 0 }
  const betaHours = betaAge / 3600000
  if (betaHours < 6)   return { label: '🌊 WAVE',    color: 'var(--neon-green)',     tier: 3 }
  if (betaHours < 24)  return { label: '📈 2ND LEG', color: 'var(--amber)',          tier: 2 }
  if (betaHours < 168) return { label: '🕐 LATE',    color: 'var(--text-secondary)', tier: 1 }
  return                      { label: '🧊 COLD',    color: 'var(--text-muted)',     tier: 0 }
}

// ─── MCAP Ratio (Vector 4) ───────────────────────────────────────
export const getMcapRatio = (alphaMcap, betaMcap) => {
  if (!alphaMcap || !betaMcap || betaMcap === 0) return null
  return Math.round(alphaMcap / betaMcap)
}

// ─── OG / RIVAL / SPIN classifier ───────────────────────────────
const classifyTokens = (betas) => {
  const groups = {}
  betas.forEach((b) => {
    const sym = b.symbol.toUpperCase()
    if (!groups[sym]) groups[sym] = []
    groups[sym].push(b)
  })
  const classified = []
  Object.values(groups).forEach((group) => {
    if (group.length === 1) { classified.push({ ...group[0], tokenClass: null }); return }
    const sorted = [...group].sort((a, b) => (a.pairCreatedAt || Infinity) - (b.pairCreatedAt || Infinity))
    const og = sorted[0]
    sorted.forEach((token, i) => {
      if (i === 0) { classified.push({ ...token, tokenClass: 'OG' }); return }
      const isRival =
        (token.marketCap || 0) >= (og.marketCap || 1) * 0.8 ||
        (token.volume24h || 0) > (og.volume24h || 1)
      classified.push({ ...token, tokenClass: isRival ? 'RIVAL' : 'SPIN' })
    })
  })
  return classified
}

// ─── Signal scoring ──────────────────────────────────────────────
export const getSignal = (beta) => {
  const s = beta.signalSources || []
  // LP pair is the strongest possible signal — direct pairing
  if (s.includes('lp_pair'))                                     return { label: 'CABAL',    tier: 6 }
  // AI + any other signal = CABAL tier
  if (s.includes('ai_match')   && s.includes('keyword'))         return { label: 'CABAL',    tier: 5 }
  if (s.includes('ai_match')   && s.includes('morphology'))      return { label: 'CABAL',    tier: 5 }
  if (s.includes('pumpfun')    && s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('morphology') && s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('description')&& s.includes('keyword'))         return { label: 'CABAL',    tier: 4 }
  if (s.includes('pumpfun'))                                     return { label: 'TRENDING', tier: 3 }
  if (s.includes('ai_match'))                                    return { label: 'AI',       tier: 3 }
  if (s.includes('description'))                                 return { label: 'STRONG',   tier: 2 }
  if (s.includes('morphology'))                                  return { label: 'STRONG',   tier: 2 }
  if (s.includes('keyword'))                                     return { label: 'STRONG',   tier: 2 }
  if (s.includes('lore'))                                        return { label: 'LORE',     tier: 1 }
  return                                                                { label: 'WEAK',     tier: 0 }
}

// ─── Format pair → beta ──────────────────────────────────────────
const formatBeta = (pair, sources = []) => {
  const ageMs    = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null
  const ageDays  = ageMs ? Math.floor(ageMs / 86400000)                  : null
  const ageHours = ageMs ? Math.floor((ageMs % 86400000) / 3600000)      : null
  const ageLabel = ageDays > 0 ? `${ageDays}d` : ageHours > 0 ? `${ageHours}h` : ageMs !== null ? '<1h' : '—'
  return {
    id:             pair.pairAddress || pair.baseToken?.address,
    symbol:         pair.baseToken?.symbol || '???',
    name:           pair.baseToken?.name   || 'Unknown',
    address:        pair.baseToken?.address || '',
    pairAddress:    pair.pairAddress || '',
    priceUsd:       pair.priceUsd || '0',
    priceChange24h: pair.priceChange?.h24 || 0,
    volume24h:      pair.volume?.h24    || 0,
    marketCap:      pair.marketCap || pair.fdv || 0,
    liquidity:      pair.liquidity?.usd || 0,
    logoUrl:        pair.info?.imageUrl || null,
    pairCreatedAt:  pair.pairCreatedAt  || null,
    // ── Description: saved so Vector 8 has context ─────────────
    description:    pair.info?.description || pair.baseToken?.description || pair._description || '',
    ageLabel, ageMs,
    signalSources:  sources,
    tokenClass:     null,
    dexUrl:         pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
  }
}

// ─── Signal 1: Keyword + compound decomposition ──────────────────
const fetchKeywordBetas = async (alphaSymbol) => {
  const terms      = getSearchTerms(alphaSymbol)
  const decomposed = decomposeSymbol(alphaSymbol)
  const allTerms   = [...new Set([...terms, ...decomposed])].slice(0, 8)
  const results    = []
  for (const term of allTerms) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${term}`)
      ;(res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
        )
        .forEach(p => results.push({ pair: p, sources: ['keyword'] }))
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 1b: Description-driven search (Vector 1 complete) ────
const fetchDescriptionBetas = async (alpha, descKeywords) => {
  if (!descKeywords || descKeywords.length === 0) return []
  const results = []
  for (const keyword of descKeywords.slice(0, 4)) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${keyword}`)
      ;(res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          p.baseToken?.address !== alpha.address &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
        )
        .forEach(p => results.push({ pair: p, sources: ['description'] }))
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 2: Lore matching ─────────────────────────────────────
const fetchLoreBetas = async (alphaSymbol) => {
  const concepts = getConcepts(alphaSymbol)
  const results  = []
  for (const concept of concepts.slice(0, 3)) {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${concept}`)
      ;(res.data?.pairs || [])
        .filter(p =>
          p.chainId === 'solana' &&
          (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
          !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
        )
        .forEach(p => results.push({ pair: p, sources: ['lore'] }))
    } catch { /* silent */ }
  }
  return results
}

// ─── Signal 3: Morphology engine ────────────────────────────────
const fetchMorphologyBetas = async (alphaSymbol) => {
  const variants = generateTickerVariants(alphaSymbol)
  const results  = []
  const batches  = []
  for (let i = 0; i < Math.min(variants.length, 25); i += 5) batches.push(variants.slice(i, i + 5))
  for (const batch of batches) {
    await Promise.allSettled(batch.map(async (variant) => {
      try {
        const res = await axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${variant}`)
        ;(res.data?.pairs || [])
          .filter(p =>
            p.chainId === 'solana' &&
            (p.liquidity?.usd || 0) >= MIN_LIQUIDITY &&
            p.baseToken?.symbol?.toUpperCase() === variant.toUpperCase() &&
            !['SOL','USDC','USDT'].includes(p.baseToken?.symbol)
          )
          .forEach(p => results.push({ pair: p, sources: ['morphology'] }))
      } catch { /* silent */ }
    }))
  }
  return results
}

// ─── Signal 4: PumpFun trending ──────────────────────────────────
const fetchPumpFunBetas = async (alphaSymbol, descKeywords = []) => {
  const concepts   = getConcepts(alphaSymbol)
  const decomposed = decomposeSymbol(alphaSymbol).map(d => d.toLowerCase())
  const allTerms   = [...new Set([...concepts, ...decomposed, ...descKeywords])]
  const results    = []
  try {
    const res = await axios.get(
      `${PUMPFUN_BASE}/coins?sort=last_trade_timestamp&order=DESC&limit=50&includeNsfw=false`,
      { timeout: 8000 }
    )
    ;(res.data || [])
      .filter(coin => {
        const hay = `${coin.name} ${coin.symbol} ${coin.description}`.toLowerCase()
        return allTerms.some(t => hay.includes(t))
      })
      .slice(0, 10)
      .forEach(coin => results.push({
        pair: {
          pairAddress:  coin.mint,
          baseToken:    { symbol: coin.symbol, name: coin.name, address: coin.mint },
          priceUsd:     coin.usd_market_cap ? String(coin.usd_market_cap / (coin.total_supply || 1e9)) : '0',
          priceChange:  { h24: 0 },
          volume:       { h24: coin.volume || 0 },
          marketCap:    coin.usd_market_cap || 0,
          liquidity:    { usd: coin.virtual_sol_reserves ? coin.virtual_sol_reserves * 150 : 0 },
          info:         { imageUrl: coin.image_uri || null, description: coin.description || '' },
          url:          `https://pump.fun/${coin.mint}`,
          pairCreatedAt: coin.created_timestamp,
        },
        sources: ['pumpfun'],
      }))
  } catch (err) {
    console.warn('PumpFun fetch failed:', err.message)
  }
  return results
}

// ─── Merge + dedupe ──────────────────────────────────────────────
const mergeAndScore = (rawResults, alphaSymbol, alphaMcap) => {
  const seen = new Map()
  rawResults.forEach(({ pair, sources }) => {
    const key = pair.baseToken?.address || pair.pairAddress
    const sym = (pair.baseToken?.symbol || '').toUpperCase()
    if (!key || sym === alphaSymbol.toUpperCase()) return
    if (seen.has(key)) {
      seen.get(key).signalSources = [...new Set([...seen.get(key).signalSources, ...sources])]
    } else {
      seen.set(key, formatBeta(pair, sources))
    }
  })

  const deduped = Array.from(seen.values())
    .filter(b => !['SOL','USDC','USDT'].includes(b.symbol))

  return classifyTokens(deduped)
    .map(b => ({ ...b, mcapRatio: getMcapRatio(alphaMcap, b.marketCap) }))
    .sort((a, b) => {
      // LP pair betas always float to top regardless of % change
      const aIsLP = a.signalSources?.includes('lp_pair') ? 1 : 0
      const bIsLP = b.signalSources?.includes('lp_pair') ? 1 : 0
      if (bIsLP !== aIsLP) return bIsLP - aIsLP
      return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
    })
    .slice(0, 30)
}

// ─── Main hook ───────────────────────────────────────────────────
const useBetas = (alpha) => {
  const [betas,   setBetas]   = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const fetchBetas = useCallback(async () => {
    if (!alpha) { setBetas([]); return }
    setLoading(true)
    setError(null)
    setBetas([])

    try {
      // Fetch description keywords first — feeds into multiple signals
      // Also returns raw description for Vector 8 AI scoring
      const { keywords: descKeywords, description: alphaDescription } =
        await fetchDescriptionKeywords(alpha)

      // Enrich alpha with description if we got a fresh one
      const enrichedAlpha = alphaDescription
        ? { ...alpha, description: alphaDescription }
        : alpha

      // Run all signals in parallel
      const [keywordRes, descRes, loreRes, morphRes, pumpRes, lpRes] =
        await Promise.allSettled([
          fetchKeywordBetas(enrichedAlpha.symbol),
          fetchDescriptionBetas(enrichedAlpha, descKeywords),
          fetchLoreBetas(enrichedAlpha.symbol),
          fetchMorphologyBetas(enrichedAlpha.symbol),
          fetchPumpFunBetas(enrichedAlpha.symbol, descKeywords),
          fetchLPPairBetas(enrichedAlpha),
        ])

      const allResults = [
        ...(keywordRes.status === 'fulfilled' ? keywordRes.value : []),
        ...(descRes.status    === 'fulfilled' ? descRes.value    : []),
        ...(loreRes.status    === 'fulfilled' ? loreRes.value    : []),
        ...(morphRes.status   === 'fulfilled' ? morphRes.value   : []),
        ...(pumpRes.status    === 'fulfilled' ? pumpRes.value    : []),
        ...(lpRes.status      === 'fulfilled' ? lpRes.value      : []),
      ]

      // Merge signals 1-5 into deduplicated list
      const merged = mergeAndScore(allResults, enrichedAlpha.symbol, enrichedAlpha.marketCap)

      // ── Signal 6: Vector 8 AI scoring ───────────────────────────
      // enrichedAlpha.description is now populated — Claude gets full
      // narrative context, not just symbol + name. Candidates also carry
      // .description where available (PumpFun devs often name their alpha
      // directly in the description, e.g. "the dog version of $PIPPIN").
      setBetas(merged)

      try {
        const aiScored = await scoreWithAI(enrichedAlpha, merged)
        if (aiScored.length > 0) {
          // Merge AI scores back into the existing beta list
          const aiAddresses = new Map(aiScored.map(b => [b.address, b]))
          const withAI = merged.map(b =>
            aiAddresses.has(b.address)
              ? { ...b, ...aiAddresses.get(b.address) }
              : b
          )
          // Add any new betas found only by AI (not in merged)
          const mergedAddresses = new Set(merged.map(b => b.address))
          const aiOnly = aiScored.filter(b => !mergedAddresses.has(b.address))

          const finalList = [...withAI, ...aiOnly]
            .sort((a, b) => {
              const aIsLP = a.signalSources?.includes('lp_pair') ? 1 : 0
              const bIsLP = b.signalSources?.includes('lp_pair') ? 1 : 0
              if (bIsLP !== aIsLP) return bIsLP - aIsLP
              return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
            })
            .slice(0, 30)

          setBetas(finalList)
        }
      } catch (aiErr) {
        console.warn('[Vector8] AI scoring failed:', aiErr.message)
      }

      // ── Signal 7: Vision — visual logo comparison ────────────────
      // Only runs if alpha has a logo AND text/AI signals were weak.
      // Compares alpha logo against candidate logos via Claude Vision.
      // Catches visual derivatives text analysis is blind to:
      //   - Same character recolored
      //   - Alpha mascot wearing something new
      //   - Direct logo copy with minor edits
      try {
        // Get the latest betas state to check text confidence
        const currentBetas = await new Promise(resolve => {
          setBetas(prev => { resolve(prev); return prev })
        })
        const weakTextCandidates = currentBetas.filter(b =>
          shouldRunVision(b, (b.signalSources?.length || 0) * 0.25)
        )

        if (enrichedAlpha.logoUrl && weakTextCandidates.length > 0) {
          console.log(`[Vision] Comparing ${weakTextCandidates.length} candidate logos for $${enrichedAlpha.symbol}`)
          const visualMatches = await compareLogos(enrichedAlpha, weakTextCandidates)

          if (visualMatches.length > 0) {
            const visualAddresses = new Map(visualMatches.map(b => [b.address, b]))
            setBetas(prev => {
              const enriched = prev.map(b =>
                visualAddresses.has(b.address)
                  ? { ...b, ...visualAddresses.get(b.address) }
                  : b
              )
              // Any visual-only matches not already in list
              const existingAddresses = new Set(prev.map(b => b.address))
              const visualOnly = visualMatches.filter(b => !existingAddresses.has(b.address))
              return [...enriched, ...visualOnly]
                .sort((a, b) => {
                  const aLP = a.signalSources?.includes('lp_pair') ? 1 : 0
                  const bLP = b.signalSources?.includes('lp_pair') ? 1 : 0
                  if (bLP !== aLP) return bLP - aLP
                  return (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
                })
                .slice(0, 35)
            })
            console.log(`[Vision] Added ${visualMatches.length} visual matches for $${enrichedAlpha.symbol}`)
          }
        }
      } catch (visionErr) {
        console.warn('[Vision] Logo comparison failed (non-fatal):', visionErr.message)
      }

      if (merged.length === 0) setError('No beta plays detected yet. Trenches might be cooked.')
    } catch (err) {
      console.error('Beta detection failed:', err)
      setError('Detection engine error. Try refreshing.')
    } finally {
      setLoading(false)
    }
  }, [alpha?.id])

  useEffect(() => { fetchBetas() }, [fetchBetas])

  return { betas, loading, error, refresh: fetchBetas }
}

export default useBetas