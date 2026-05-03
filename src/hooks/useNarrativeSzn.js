import { useState, useEffect, useMemo, useRef } from 'react'
import { NARRATIVE_CATEGORIES } from '../data/lore_map'
import { categorizeWithAI } from './useAISznCategorization'
import { classifyLogos, shouldRunVision } from './useImageAnalysis'

// ─── Narrative Season Detector ───────────────────────────────────
// Three-pass detection:
//
//   Pass 1 (instant):     keyword matching → Szn cards appear immediately
//   Pass 2 (async):       AI categorizes unmatched tokens → cards enrich
//   Pass 3 (async, free): DEXScreener Metas API → authoritative narrative
//                         groupings enrich/replace AI calls, saves Groq quota
//
// Pass 3 benefits:
//   a) DEXScreener editorial team manually curates meta membership
//   b) Replaces AI categorisation for tokens already in a known meta
//   c) Surfaces novel metas we haven't defined keywords for yet
//   d) Zero API cost — free endpoint, cached 5min server-side
//   e) topGainers from Tier 2 check enrich the Szn card display

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const MIN_TOKENS_FOR_SZN = 2

// ─── DEXScreener slug → lore_map category key ────────────────────
// Maps DEXScreener meta slugs to our exact lore_map category keys.
// Unmapped slugs become novel Szn cards using the meta's own label.
// Keys must exactly match those in lore_map.js NARRATIVE_CATEGORIES.
const SLUG_TO_CATEGORY = {
  // Dogs
  'dog-themed':        'dogs',
  'dogs':              'dogs',
  'dog':               'dogs',
  'doge':              'dogs',
  // Cats
  'cat-themed':        'cats',
  'cats':              'cats',
  'cat':               'cats',
  // Frogs / Pepe
  'frog-pepe':         'frogs',
  'pepe':              'frogs',
  'frogs':             'frogs',
  'frog':              'frogs',
  // Aliens
  'aliens':            'aliens',
  'alien':             'aliens',
  'ufo':               'aliens',
  // Bears
  'bear':              'bears',
  'bears':             'bears',
  'panda':             'bears',
  // Penguins
  'penguin':           'penguins',
  'penguins':          'penguins',
  // Animals (generic)
  'animals':           'animals',
  'animal':            'animals',
  'bird':              'animals',
  'fish':              'animals',
  'snake':             'animals',
  'rabbit':            'animals',
  'hamster':           'animals',
  'wolf':              'animals',
  'fox':               'animals',
  'monkey':            'animals',
  'ape':               'animals',
  'bull':              'animals',
  // AI
  'ai':                'ai',
  'ai-agents':         'ai',
  'artificial-intelligence': 'ai',
  'agents':            'ai',
  'depin':             'ai',
  // Elon
  'elon':              'elon',
  'elon-musk':         'elon',
  'musk':              'elon',
  'grok':              'elon',
  // Trump / Political
  'trump':             'trump',
  'maga':              'trump',
  'political':         'political',
  'election':          'political',
  // Anime
  'anime':             'anime',
  'manga':             'anime',
  'waifu':             'anime',
  // Gaming
  'gaming':            'gaming',
  'games':             'gaming',
  'pokemon':           'gaming',
  // Nature
  'nature':            'nature',
  'forest':            'nature',
  'plant':             'nature',
  // Space
  'space':             'space',
  'moon':              'space',
  'mars':              'space',
  'rocket':            'space',
  // Movies / TV
  'movies':            'movies',
  'film':              'movies',
  'tv':                'movies',
  // Celebrity
  'celebrity':         'celebrity',
  'celebrities':       'celebrity',
  // Sports
  'sports':            'sports',
  'football':          'sports',
  'soccer':            'sports',
  // Food
  'food':              'food',
  'memes':             'memes',
  'humor':             'humor',
  'internet-culture':  'internet_culture',
  'internet':          'internet_culture',
  'crypto':            'crypto',
  'defi':              'crypto',
  // Chinese / Japanese / Korean / Spanish
  'chinese':           'chinese',
  'japan':             'japanese',
  'anime-japanese':    'japanese',
  'korean':            'korean',
  'spanish':           'spanish',
  // Fantasy
  'fantasy':           'pippin',
  'lotr':              'pippin',
  // Holiday
  'holiday':           'holiday',
  'christmas':         'holiday',
  'halloween':         'holiday',
}

// Map slug to our category key — direct match first, then partial
const slugToCategory = (slug) => {
  if (!slug) return null
  const lower = slug.toLowerCase()
  if (SLUG_TO_CATEGORY[lower]) return SLUG_TO_CATEGORY[lower]
  for (const [pattern, catKey] of Object.entries(SLUG_TO_CATEGORY)) {
    if (lower.includes(pattern) || pattern.includes(lower)) return catKey
  }
  return null
}

// ─── Priority-aware keyword detection ────────────────────────────
const SORTED_CATEGORIES = Object.entries(NARRATIVE_CATEGORIES)
  .sort((a, b) => (a[1].priority || 2) - (b[1].priority || 2))

export const detectCategory = (symbol, name = '', description = '') => {
  const haystack = `${symbol} ${name} ${description}`.toLowerCase()
  for (const [key, cat] of SORTED_CATEGORIES) {
    if (cat.keywords.some((kw) => haystack.includes(kw))) return key
  }
  return null
}

// ─── Szn strength score (0–100) ──────────────────────────────────
// 40% volume · 30% momentum · 20% leader gain · 10% depth
const calcSznScore = (tokens, totalVolume) => {
  if (!tokens || tokens.length === 0) return 0
  const changes     = tokens.map(t => parseFloat(t.priceChange24h) || 0)
  const greenCount  = changes.filter(c => c > 0).length
  const momentum    = greenCount / tokens.length
  const leaderGain  = Math.max(...changes)
  const depth       = Math.min(tokens.length / 10, 1)
  const volScore    = Math.min(totalVolume / 10_000_000, 1)
  const leaderScore = Math.min(leaderGain / 1000, 1)
  return Math.round((volScore * 0.40 + momentum * 0.30 + leaderScore * 0.20 + depth * 0.10) * 100)
}

const getHeat = (score) => {
  if (score >= 70) return { label: 'EXPLODING', color: '#FF4466', emoji: '🔥' }
  if (score >= 50) return { label: 'HOT',       color: '#FFB800', emoji: '⚡' }
  if (score >= 30) return { label: 'WARMING',   color: '#00FF88', emoji: '📈' }
  return              { label: 'MILD',      color: '#888888', emoji: '😴' }
}

// ─── Build a single Szn card ──────────────────────────────────────
const buildSznCard = (key, label, tokens, source = 'keyword', extra = {}) => {
  const changes    = tokens.map(t => parseFloat(t.priceChange24h) || 0)
  const avgChange  = changes.reduce((s, c) => s + c, 0) / changes.length
  const greenCount = changes.filter(c => c > 0).length
  const momentum   = Math.round((greenCount / tokens.length) * 100)
  const totalVol   = tokens.reduce((s, t) => s + (t.volume24h || 0), 0)

  const sortedTokens = [...tokens].sort(
    (a, b) => (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
  )

  const sznScore = calcSznScore(tokens, totalVol)
  const heat     = getHeat(sznScore)

  return {
    id:          `szn-${key}`,
    key,
    label,
    tokens:      sortedTokens,
    totalVolume: totalVol,
    avgChange,
    momentum,
    leader:      sortedTokens[0],
    sznScore,
    heat,
    tokenCount:  tokens.length,
    source,
    isSzn:       true,
    ...extra,
  }
}

// ─── Hook ─────────────────────────────────────────────────────────
const useNarrativeSzn = (liveAlphas) => {
  const [aiCards,        setAiCards]        = useState([])
  const [aiEnrichments,  setAiEnrichments]  = useState({})
  const [metaEnrichments, setMetaEnrichments] = useState({})  // catKey → tokens from Metas
  const [novelMetaCards,  setNovelMetaCards]  = useState([])  // new metas not in our categories
  const liveAlphasRef = useRef(liveAlphas)
  liveAlphasRef.current = liveAlphas

  // ── Pass 1: keyword matching (synchronous, instant) ────────────
  const { keywordCards, unmatched } = useMemo(() => {
    if (!liveAlphas || liveAlphas.length === 0) return { keywordCards: [], unmatched: [] }

    const categoryMap     = {}
    const unmatchedTokens = []

    liveAlphas.forEach((alpha) => {
      const catKey = detectCategory(alpha.symbol, alpha.name || '', alpha.description || '')
      if (catKey) {
        if (!categoryMap[catKey]) {
          categoryMap[catKey] = { key: catKey, label: NARRATIVE_CATEGORIES[catKey].label, tokens: [] }
        }
        categoryMap[catKey].tokens.push(alpha)
      } else {
        unmatchedTokens.push(alpha)
      }
    })

    const cards = Object.values(categoryMap)
      .filter(cat => cat.tokens.length >= MIN_TOKENS_FOR_SZN)
      .map(cat => buildSznCard(cat.key, cat.label, cat.tokens, 'keyword'))
      .sort((a, b) => b.sznScore - a.sznScore)

    // Proactive dominant narrative — written before any async calls
    try {
      const categoryCounts = {}
      Object.entries(categoryMap).forEach(([catKey, { tokens }]) => {
        categoryCounts[catKey] = (categoryCounts[catKey] || 0) + tokens.length
      })
      const dominantEntry = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .find(([, count]) => count >= 2)

      const proactive = dominantEntry
        ? { category: dominantEntry[0], count: dominantEntry[1], timestamp: Date.now() }
        : { category: null, count: 0, timestamp: Date.now() }

      localStorage.setItem('betaplays_dominant_narrative', JSON.stringify(proactive))
      if (dominantEntry) {
        console.log(`[SznNarrative] Dominant: "${dominantEntry[0]}" (${dominantEntry[1]} runners)`)
      }
    } catch { /* non-fatal */ }

    return { keywordCards: cards, unmatched: unmatchedTokens }
  }, [liveAlphas])

  // ── Pass 2: AI categorization (async, non-blocking) ────────────
  useEffect(() => {
    if (!unmatched || unmatched.length === 0) {
      setAiCards([])
      setAiEnrichments({})
      return
    }

    setAiCards([])
    setAiEnrichments({})

    categorizeWithAI(
      unmatched,
      NARRATIVE_CATEGORIES,
      (categorized, novelGroups) => {
        const enrichments = {}
        categorized.forEach(({ token, category }) => {
          if (!enrichments[category]) enrichments[category] = []
          enrichments[category].push(token)
        })
        setAiEnrichments(enrichments)

        const novel = novelGroups
          .filter(g => g.tokens.length >= MIN_TOKENS_FOR_SZN)
          .map(g => buildSznCard(g.key, g.label, g.tokens, 'ai'))
        setAiCards(novel)
      }
    ).catch(err => console.warn('[SznAI] Failed (non-fatal):', err))

    // Vision pass — logo-based classification
    const visionCandidates = unmatched.filter(t => shouldRunVision(t, 0))
    if (visionCandidates.length > 0) {
      classifyLogos(visionCandidates)
        .then(results => {
          if (!results || results.length === 0) return
          const visionEnrichments = {}
          results
            .filter(r => r.category && NARRATIVE_CATEGORIES[r.category])
            .forEach(({ token, category, visualDescription }) => {
              if (!visionEnrichments[category]) visionEnrichments[category] = []
              visionEnrichments[category].push({
                ...token,
                visualDescription,
                signalSources: [...(token.signalSources || []), 'vision'],
              })
            })
          if (Object.keys(visionEnrichments).length > 0) {
            setAiEnrichments(prev => {
              const merged = { ...prev }
              Object.entries(visionEnrichments).forEach(([cat, tokens]) => {
                merged[cat] = [...(merged[cat] || []), ...tokens]
              })
              return merged
            })
            console.log(`[Vision] Logo classify added to ${Object.keys(visionEnrichments).length} cards`)
          }
        })
        .catch(err => console.warn('[Vision] Logo classify failed:', err))
    }
  }, [unmatched])

  // ── Pass 3: DEXScreener Metas (async, free, non-blocking) ──────
  // Runs independently of AI pass. Fetches trending confirmed metas
  // (Tier 2: ≥2 tokens up 30%+ in 24h) and maps them to our categories.
  // Enriches existing keyword cards and creates novel meta cards.
  // Does NOT wait for or block Pass 2.
  useEffect(() => {
    if (!liveAlphas || liveAlphas.length === 0) return

    const liveAddresses = new Set(liveAlphas.map(a => a.address))

    setMetaEnrichments({})
    setNovelMetaCards([])

    ;(async () => {
      try {
        const res  = await fetch(`${BACKEND_URL}/api/metas?type=trending`)
        if (!res.ok) return
        const data = await res.json()
        const metas = (data.metas || []).filter(m => m.tier2Confirmed === true)

        if (metas.length === 0) {
          console.log('[SznMetas] No Tier 2 confirmed metas right now')
          return
        }

        console.log(`[SznMetas] ${metas.length} confirmed metas — enriching Szn cards`)

        const enrichments = {}
        const novelCards  = []

        for (const meta of metas) {
          const catKey = slugToCategory(meta.slug)

          // topGainers from the Tier 2 check — these are tokens we KNOW are up 30%+
          // Cross-reference with live alpha list to get full token data
          const topGainers = meta.topGainers || []
          const matchedTokens = liveAlphas.filter(a =>
            topGainers.some(g => g.symbol === a.symbol) ||
            (a.metaSlug && a.metaSlug === meta.slug)  // Source 8 tokens tagged with metaSlug
          )

          // If we have fewer matched tokens than topGainers, fetch the meta token list
          // to get addresses for cross-referencing — but only if we have no match at all
          let tokens = matchedTokens

          if (tokens.length === 0) {
            // No live alpha overlap — skip (meta tokens may not be on our feed yet)
            // Source 8 (fetchMetaAlphas) will add them to alpha feed on next refresh
            console.log(`[SznMetas] ${meta.name}: no overlap with live feed yet`)
            continue
          }

          if (catKey && NARRATIVE_CATEGORIES[catKey]) {
            // Merge into existing category
            if (!enrichments[catKey]) enrichments[catKey] = []
            enrichments[catKey].push(...tokens)
            console.log(`[SznMetas] ${meta.name} → ${catKey} (+${tokens.length} tokens)`)
          } else {
            // Novel meta — build a new Szn card
            if (tokens.length >= MIN_TOKENS_FOR_SZN) {
              const novelKey = `meta-${meta.slug}`
              novelCards.push(buildSznCard(
                novelKey,
                `${meta.name}`,
                tokens,
                'meta',
                {
                  metaSlug:       meta.slug,
                  pumpingCount:   meta.pumpingCount,
                  topGainers:     meta.topGainers,
                  tier2Confirmed: true,
                }
              ))
              console.log(`[SznMetas] Novel meta: ${meta.name} (${tokens.length} tokens)`)
            }
          }
        }

        setMetaEnrichments(enrichments)
        setNovelMetaCards(novelCards)
      } catch (err) {
        console.warn('[SznMetas] Pass 3 failed (non-fatal):', err.message)
      }
    })()
  }, [liveAlphas])

  // ── Merge: keyword + AI enrichments + Metas enrichments + novel cards ──
  const sznCards = useMemo(() => {
    const merged = keywordCards.map(card => {
      const aiExtra   = aiEnrichments[card.key]   || []
      const metaExtra = metaEnrichments[card.key] || []
      const extra     = [...aiExtra, ...metaExtra]

      if (extra.length === 0) return card

      // Deduplicate by address before merging
      const seen      = new Set(card.tokens.map(t => t.address))
      const newTokens = extra.filter(t => !seen.has(t.address))
      if (newTokens.length === 0) return card

      const allTokens = [...card.tokens, ...newTokens]
      const source    = metaExtra.length > 0 && aiExtra.length > 0 ? 'mixed'
                      : metaExtra.length > 0 ? 'meta'
                      : 'mixed'
      return {
        ...buildSznCard(card.key, card.label, allTokens, source),
        aiEnriched:   aiExtra.length,
        metaEnriched: metaExtra.length,
      }
    })

    // Novel AI cards + novel Meta cards — deduplicated by key
    const novelKeys = new Set(merged.map(c => c.key))
    const allNovel  = [...aiCards, ...novelMetaCards].filter(c => !novelKeys.has(c.key))

    return [...merged, ...allNovel].sort((a, b) => b.sznScore - a.sznScore)
  }, [keywordCards, aiEnrichments, aiCards, metaEnrichments, novelMetaCards])

  return sznCards
}

export default useNarrativeSzn