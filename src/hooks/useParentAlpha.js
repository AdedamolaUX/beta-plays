import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const DEXSCREENER_BASE = 'https://api.dexscreener.com'

// ─── Reverse Morphology ──────────────────────────────────────────
// Given a runner's symbol, try to find its root/parent token.
// Strategy: strip known prefixes and suffixes, search for the remainder.

const STRIP_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER', 'BASED',
  'REAL', 'OG', 'TURBO', 'CHAD', 'RETRO', 'FAT', 'TINY', 'THE',
]

const STRIP_SUFFIXES = [
  'INU', 'WIF', 'HAT', 'CAT', 'DOG', 'AI', 'GPT', 'DAO',
  'FI', 'X', '2', '3', 'PLUS', 'PRO', 'MOON', 'PUMP', 'KIN',
  'KY', 'LY', 'ISH', 'WIFHAT', 'WIFCAT',
]

export const extractRootCandidates = (symbol) => {
  const s = symbol.toUpperCase()
  const candidates = new Set()

  // Try stripping each prefix
  STRIP_PREFIXES.forEach((prefix) => {
    if (s.startsWith(prefix) && s.length > prefix.length + 2) {
      candidates.add(s.slice(prefix.length))
    }
  })

  // Try stripping each suffix
  STRIP_SUFFIXES.forEach((suffix) => {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      candidates.add(s.slice(0, s.length - suffix.length))
    }
  })

  // Try partial string match — first 4+ characters as root
  if (s.length >= 6) {
    candidates.add(s.slice(0, 4))
    candidates.add(s.slice(0, 5))
  }

  // Remove the symbol itself
  candidates.delete(s)

  return Array.from(candidates)
}

// ─── Format parent alpha ─────────────────────────────────────────
const formatParent = (pair) => ({
  id: pair.pairAddress || pair.baseToken?.address,
  symbol: pair.baseToken?.symbol || '???',
  name: pair.baseToken?.name || 'Unknown',
  address: pair.baseToken?.address || '',
  pairAddress: pair.pairAddress || '',
  priceUsd: pair.priceUsd || '0',
  priceChange24h: pair.priceChange?.h24 || 0,
  volume24h: pair.volume?.h24 || 0,
  marketCap: pair.marketCap || pair.fdv || 0,
  liquidity: pair.liquidity?.usd || 0,
  logoUrl: pair.info?.imageUrl || null,
  dexUrl: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
})

// ─── Main hook ───────────────────────────────────────────────────
const useParentAlpha = (alpha) => {
  const [parent, setParent] = useState(null)
  const [loading, setLoading] = useState(false)

  const findParent = useCallback(async () => {
    if (!alpha) { setParent(null); return }

    setLoading(true)
    setParent(null)

    const candidates = extractRootCandidates(alpha.symbol)
    if (candidates.length === 0) { setLoading(false); return }

    try {
      // Search each candidate in parallel
      const searches = await Promise.allSettled(
        candidates.slice(0, 6).map((candidate) =>
          axios.get(`${DEXSCREENER_BASE}/latest/dex/search?q=${candidate}`)
        )
      )

      let bestMatch = null
      let bestMcap = 0

      searches.forEach((result) => {
        if (result.status !== 'fulfilled') return
        const pairs = result.value.data?.pairs || []

        pairs
          .filter((p) =>
            p.chainId === 'solana' &&
            // Parent must have higher mcap than the derivative
            (p.marketCap || p.fdv || 0) > (alpha.marketCap || 0) &&
            // Parent must have meaningful liquidity
            (p.liquidity?.usd || 0) > 10000 &&
            // Must not be the same token
            p.baseToken?.address !== alpha.address &&
            p.baseToken?.symbol?.toUpperCase() !== alpha.symbol.toUpperCase()
          )
          .forEach((p) => {
            const mcap = p.marketCap || p.fdv || 0
            // Pick the highest mcap match as the most likely parent
            if (mcap > bestMcap) {
              bestMcap = mcap
              bestMatch = p
            }
          })
      })

      setParent(bestMatch ? formatParent(bestMatch) : null)
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