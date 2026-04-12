import { useState, useEffect, useMemo } from 'react'
import { NARRATIVE_CATEGORIES } from '../data/lore_map'
import { categorizeWithAI } from './useAISznCategorization'
import { classifyLogos, shouldRunVision } from './useImageAnalysis'

// ─── Narrative Season Detector ───────────────────────────────────
// Two-pass detection:
//
//   Pass 1 (instant): keyword matching → Szn cards appear immediately
//   Pass 2 (async):   AI categorizes unmatched tokens → cards enrich
//
// The AI layer does two things keywords can't:
//   a) Catch unexpected vocabulary ($WHISKERS → cats)
//   b) Surface novel narratives ($GORK + $GORKFUND → 🦕 Gork Szn)

const MIN_TOKENS_FOR_SZN = 2

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

// ─── Build a single Szn card from grouped token data ─────────────
const buildSznCard = (key, label, tokens, source = 'keyword') => {
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
    source,      // 'keyword' | 'ai' | 'mixed'
    isSzn:       true,
  }
}

// ─── Hook ─────────────────────────────────────────────────────────
const useNarrativeSzn = (liveAlphas) => {
  const [aiCards,       setAiCards]       = useState([])
  const [aiEnrichments, setAiEnrichments] = useState({}) // catKey → extra tokens

  // ── Pass 1: keyword matching (synchronous, instant) ────────────
  const { keywordCards, unmatched } = useMemo(() => {
    if (!liveAlphas || liveAlphas.length === 0) return { keywordCards: [], unmatched: [] }

    const categoryMap = {}
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

    // ── P3: Proactive dominant narrative ─────────────────────────
    // Compute and persist the dominant narrative IMMEDIATELY after
    // keyword matching — before any async AI or API calls.
    // useBetas MetaSeed reads this on every scan, so even the very
    // first scan of a session gets the correct dominant injection.
    //
    // Counts tokens per category across ALL runners (not just the
    // ones that formed full Szn cards). A single dominant runner
    // with category "political" is enough signal to seed political
    // terms into every beta scan that complements it.
    try {
      const categoryCounts = {}
      Object.entries(categoryMap).forEach(([catKey, { tokens }]) => {
        categoryCounts[catKey] = (categoryCounts[catKey] || 0) + tokens.length
      })
      const dominantEntry = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .find(([, count]) => count >= 2)  // ≥2 runners in same category = real narrative

      const proactive = dominantEntry
        ? { category: dominantEntry[0], count: dominantEntry[1], timestamp: Date.now() }
        : { category: null, count: 0, timestamp: Date.now() }

      localStorage.setItem('betaplays_dominant_narrative', JSON.stringify(proactive))

      if (dominantEntry) {
        console.log(`[SznNarrative] Dominant narrative: "${dominantEntry[0]}" (${dominantEntry[1]} runners) — written proactively`)
      }
    } catch { /* silent — non-fatal */ }

    return { keywordCards: cards, unmatched: unmatchedTokens }
  }, [liveAlphas])

  // ── Pass 2: AI categorization (async, non-blocking) ────────────
  useEffect(() => {
    if (!unmatched || unmatched.length === 0) {
      setAiCards([])
      setAiEnrichments({})
      return
    }

    // Reset stale AI results when alphas change
    setAiCards([])
    setAiEnrichments({})

    categorizeWithAI(
      unmatched,
      NARRATIVE_CATEGORIES,
      (categorized, novelGroups) => {
        // categorized: tokens that fit existing categories
        // novelGroups: brand new narratives

        // Build enrichment map: catKey → extra tokens from AI
        const enrichments = {}
        categorized.forEach(({ token, category }) => {
          if (!enrichments[category]) enrichments[category] = []
          enrichments[category].push(token)
        })
        setAiEnrichments(enrichments)

        // Build novel Szn cards from AI-discovered narratives
        const novel = novelGroups
          .filter(g => g.tokens.length >= MIN_TOKENS_FOR_SZN)
          .map(g => buildSznCard(g.key, g.label, g.tokens, 'ai'))
        setAiCards(novel)
      }
    ).catch(err => console.warn('[SznAI] Categorization failed (non-fatal):', err))

    // ── Pass 3: Vision — logo-based classification ────────────────
    // Runs on tokens still unmatched after text + AI text passes.
    // Fires independently — doesn't block or wait for Pass 2.
    // A token called $NIRE with a glowing cat logo → cats Szn.
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
            console.log(`[Vision] Logo classify added tokens to ${Object.keys(visionEnrichments).length} Szn cards`)
          }
        })
        .catch(err => console.warn('[Vision] Logo classify failed (non-fatal):', err))
    }
  }, [unmatched])

  // ── Merge: combine keyword cards + AI enrichments + novel cards ─
  const sznCards = useMemo(() => {
    // Start with keyword cards, potentially enriched by AI
    const merged = keywordCards.map(card => {
      const extra = aiEnrichments[card.key]
      if (!extra || extra.length === 0) return card

      // Merge AI-found tokens into existing keyword card
      const allTokens = [...card.tokens, ...extra]
      return {
        ...buildSznCard(card.key, card.label, allTokens, 'mixed'),
        // Mark that AI added tokens
        aiEnriched: extra.length,
      }
    })

    // Add novel AI-discovered Szn cards
    const allCards = [...merged, ...aiCards]
      .sort((a, b) => b.sznScore - a.sznScore)

    return allCards
  }, [keywordCards, aiEnrichments, aiCards])

  return sznCards
}

export default useNarrativeSzn