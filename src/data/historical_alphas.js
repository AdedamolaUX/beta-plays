// ─── LEGENDS ────────────────────────────────────────────────────
// Established narrative anchors. These tokens defined their
// categories and still spawn betas when they move.
// Not "past" — they're the foundation the whole meta is built on.
//
// ─── AUTO-PROMOTION CRITERIA ────────────────────────────────────
// A token qualifies for Legend status algorithmically if ALL of:
//   1. Age ≥ 1 year (365 days) — survived multiple market cycles
//   2. Mcap ≥ $50M — sustained size, not a flash pump
//   3. Has spawned betas — narrative proof (BetaPlays measures this)
//   4. Still liquid — volume ≥ $500K/day + liquidity ≥ $500K
//
// Community nominations feed into a review queue.
// Final promotion is manual (admin) or algorithmic — never automatic
// from community votes alone.

export const LEGEND_CRITERIA = {
  minAgeDays:      365,
  minMcap:         50_000_000,
  minVolume24h:    500_000,
  minLiquidity:    500_000,
  minBetasSpawned: 3,
}

const LEGENDS = [
  {
    id:             'legend-wif',
    symbol:         'WIF',
    name:           'dogwifhat',
    address:        'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    priceUsd:       null,
    priceChange24h: null,
    volume24h:      null,
    marketCap:      null,
    liquidity:      null,
    logoUrl:        null,
    pairCreatedAt:  '2023-11-20',
    isHistorical:   false,
    isLegend:       true,
    category:       'dogs',
    universe:       'dogwifhat',
    dexUrl:         'https://dexscreener.com/solana/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    nominationCount: 0,
    nominatedBy:    [],
    promotedBy:     'manual',
    promotedAt:     '2024-01-01',
  },
  {
    id:             'legend-bonk',
    symbol:         'BONK',
    name:           'Bonk',
    address:        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    priceUsd:       null,
    priceChange24h: null,
    volume24h:      null,
    marketCap:      null,
    liquidity:      null,
    logoUrl:        null,
    pairCreatedAt:  '2022-12-25',
    isHistorical:   false,
    isLegend:       true,
    category:       'dogs',
    universe:       'solana-dogs',
    dexUrl:         'https://dexscreener.com/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    nominationCount: 0,
    nominatedBy:    [],
    promotedBy:     'manual',
    promotedAt:     '2024-01-01',
  },
  {
    id:             'legend-popcat',
    symbol:         'POPCAT',
    name:           'Popcat',
    address:        '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    priceUsd:       null,
    priceChange24h: null,
    volume24h:      null,
    marketCap:      null,
    liquidity:      null,
    logoUrl:        null,
    pairCreatedAt:  '2024-01-15',
    isHistorical:   false,
    isLegend:       true,
    category:       'cats',
    universe:       'pop-memes',
    dexUrl:         'https://dexscreener.com/solana/7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    nominationCount: 0,
    nominatedBy:    [],
    promotedBy:     'manual',
    promotedAt:     '2024-06-01',
  },
  {
    id:             'legend-myro',
    symbol:         'MYRO',
    name:           'Myro',
    address:        'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4',
    priceUsd:       null,
    priceChange24h: null,
    volume24h:      null,
    marketCap:      null,
    liquidity:      null,
    logoUrl:        null,
    pairCreatedAt:  '2023-11-28',
    isHistorical:   false,
    isLegend:       true,
    category:       'dogs',
    universe:       'solana-dogs',
    dexUrl:         'https://dexscreener.com/solana/HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4',
    nominationCount: 0,
    nominatedBy:    [],
    promotedBy:     'manual',
    promotedAt:     '2024-01-01',
  },
  {
    id:             'legend-pepe',
    symbol:         'PEPE',
    name:           'Pepe',
    address:        '6GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    priceUsd:       null,
    priceChange24h: null,
    volume24h:      null,
    marketCap:      null,
    liquidity:      null,
    logoUrl:        null,
    pairCreatedAt:  '2023-04-14',
    isHistorical:   false,
    isLegend:       true,
    category:       'frogs',
    universe:       'pepe',
    dexUrl:         'https://dexscreener.com/ethereum/pepe',
    nominationCount: 0,
    nominatedBy:    [],
    promotedBy:     'manual',
    promotedAt:     '2024-01-01',
  },
  {
    id:             'legend-trump',
    symbol:         'TRUMP',
    name:           'Official Trump',
    address:        '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
    priceUsd:       null,
    priceChange24h: null,
    volume24h:      null,
    marketCap:      null,
    liquidity:      null,
    logoUrl:        null,
    pairCreatedAt:  '2025-01-17',
    isHistorical:   false,
    isLegend:       true,
    category:       'political',
    universe:       'trump-family',
    dexUrl:         'https://dexscreener.com/solana/6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
    nominationCount: 0,
    nominatedBy:    [],
    promotedBy:     'manual',
    promotedAt:     '2025-02-01',
  },
  {
    id:             'legend-pnut',
    symbol:         'PNUT',
    name:           'Peanut the Squirrel',
    address:        '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',
    priceUsd:       null,
    priceChange24h: null,
    volume24h:      null,
    marketCap:      null,
    liquidity:      null,
    logoUrl:        null,
    pairCreatedAt:  '2024-10-28',
    isHistorical:   false,
    isLegend:       true,
    category:       'animals',
    universe:       'viral-animals',
    dexUrl:         'https://dexscreener.com/solana/2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',
    nominationCount: 0,
    nominatedBy:    [],
    promotedBy:     'manual',
    promotedAt:     '2024-11-01',
  },
]

export default LEGENDS

// ─── Nomination storage ─────────────────────────────────────────
// Nominations stored in localStorage under 'betaplays_nominations'
// { [address]: { symbol, name, mcap, nominationCount, status: 'pending'|'approved'|'rejected' } }

export const NOMINATIONS_KEY = 'betaplays_nominations'

export const getNominations = () => {
  try { return JSON.parse(localStorage.getItem(NOMINATIONS_KEY) || '{}') }
  catch { return {} }
}

export const submitNomination = (addressOrToken, symbol = '', name = '', note = '') => {
  try {
    const nominations = getNominations()

    // Accept either (token object) or (address, symbol, name, note)
    let address, sym, nm, mcap, vol, liq, logoUrl, dexUrl
    if (typeof addressOrToken === 'object' && addressOrToken !== null) {
      const token = addressOrToken
      address = token.address || token.pairAddress
      sym     = token.symbol
      nm      = token.name || token.symbol
      mcap    = token.marketCap || 0
      vol     = token.volume24h || 0
      liq     = token.liquidity || 0
      logoUrl = token.logoUrl || null
      dexUrl  = token.dexUrl || null
    } else {
      address = addressOrToken
      sym     = symbol
      nm      = name
      mcap    = 0; vol = 0; liq = 0; logoUrl = null; dexUrl = null
    }

    if (!address) return null

    // Already a confirmed Legend
    const alreadyLegend = LEGENDS.some(
      l => l.address === address || l.symbol === sym?.toUpperCase()
    )
    if (alreadyLegend) return { status: 'already_legend' }

    if (nominations[address]) {
      nominations[address].nominationCount = (nominations[address].nominationCount || 1) + 1
      nominations[address].lastNominatedAt = Date.now()
      if (note) nominations[address].note = note
    } else {
      nominations[address] = {
        address, symbol: sym, name: nm, mcap, volume24h: vol,
        liquidity: liq, logoUrl, dexUrl, note,
        nominatedAt: Date.now(), lastNominatedAt: Date.now(),
        nominationCount: 1, status: 'pending',
      }
    }

    localStorage.setItem(NOMINATIONS_KEY, JSON.stringify(nominations))
    return { status: 'submitted', nominationCount: nominations[address].nominationCount }
  } catch { return null }
}

export const getNominationStatus = (address) => {
  const nominations = getNominations()
  return nominations[address] || null
}

// ─── Auto-promotion criteria checker ───────────────────────────
// Returns which criteria a token passes/fails.
// betasSpawned must be checked separately with live scan data.
export const checkLegendCriteria = (token) => {
  const passes  = []
  const failing = []

  const ageDays = token.pairCreatedAt
    ? (Date.now() - new Date(token.pairCreatedAt).getTime()) / 86_400_000
    : 0

  ageDays >= LEGEND_CRITERIA.minAgeDays
    ? passes.push(`Age: ${Math.round(ageDays)}d ✓`)
    : failing.push(`Age: ${Math.round(ageDays)}d (need ${LEGEND_CRITERIA.minAgeDays}d)`)

  const mcap = token.marketCap || 0
  mcap >= LEGEND_CRITERIA.minMcap
    ? passes.push(`Mcap: $${(mcap/1e6).toFixed(1)}M ✓`)
    : failing.push(`Mcap: $${(mcap/1e6).toFixed(1)}M (need $${LEGEND_CRITERIA.minMcap/1e6}M)`)

  const vol = token.volume24h || 0
  vol >= LEGEND_CRITERIA.minVolume24h
    ? passes.push(`Vol: $${(vol/1e3).toFixed(0)}K ✓`)
    : failing.push(`Vol: $${(vol/1e3).toFixed(0)}K (need $${LEGEND_CRITERIA.minVolume24h/1e3}K)`)

  const liq = token.liquidity || 0
  liq >= LEGEND_CRITERIA.minLiquidity
    ? passes.push(`Liq: $${(liq/1e3).toFixed(0)}K ✓`)
    : failing.push(`Liq: $${(liq/1e3).toFixed(0)}K (need $${LEGEND_CRITERIA.minLiquidity/1e3}K)`)

  return {
    qualifies: failing.length === 0,
    passes,
    failing,
    missingBetaCheck: true, // betasSpawned checked separately
  }
}