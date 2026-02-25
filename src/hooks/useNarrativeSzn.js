import { useState, useEffect } from 'react'
import { NARRATIVE_CATEGORIES } from '../data/lore_map'

// ─── Narrative Season Detector ───────────────────────────────────
// Scans the live alpha list and detects which narrative categories
// are dominating. If 2+ tokens belong to the same category,
// we surface a "Szn" card for that narrative.

const MIN_TOKENS_FOR_SZN = 2

// Detect which category a token belongs to based on symbol + name
const detectCategory = (symbol, name) => {
  const haystack = `${symbol} ${name}`.toLowerCase()

  for (const [key, cat] of Object.entries(NARRATIVE_CATEGORIES)) {
    if (cat.keywords.some((kw) => haystack.includes(kw))) {
      return key
    }
  }
  return null
}

const useNarrativeSzn = (liveAlphas) => {
  const [sznCards, setSznCards] = useState([])

  useEffect(() => {
    if (!liveAlphas || liveAlphas.length === 0) {
      setSznCards([])
      return
    }

    // Group tokens by narrative category
    const categoryMap = {}

    liveAlphas.forEach((alpha) => {
      const cat = detectCategory(alpha.symbol, alpha.name || '')
      if (!cat) return

      if (!categoryMap[cat]) {
        categoryMap[cat] = {
          key: cat,
          label: NARRATIVE_CATEGORIES[cat].label,
          tokens: [],
          totalVolume: 0,
          avgChange: 0,
        }
      }

      categoryMap[cat].tokens.push(alpha)
      categoryMap[cat].totalVolume += alpha.volume24h || 0
    })

    // Build Szn cards for categories with enough tokens
    const cards = Object.values(categoryMap)
      .filter((cat) => cat.tokens.length >= MIN_TOKENS_FOR_SZN)
      .map((cat) => {
        const avgChange =
          cat.tokens.reduce((sum, t) => sum + (parseFloat(t.priceChange24h) || 0), 0) /
          cat.tokens.length

        // Sort tokens within the szn by 24h gain
        const sortedTokens = [...cat.tokens].sort(
          (a, b) => (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0)
        )

        return {
          id: `szn-${cat.key}`,
          key: cat.key,
          label: cat.label,
          tokens: sortedTokens,
          totalVolume: cat.totalVolume,
          avgChange,
          tokenCount: cat.tokens.length,
          isSzn: true,
        }
      })
      // Sort szn cards by avg 24h change descending
      .sort((a, b) => b.avgChange - a.avgChange)

    setSznCards(cards)
  }, [liveAlphas])

  return sznCards
}

export { detectCategory }
export default useNarrativeSzn