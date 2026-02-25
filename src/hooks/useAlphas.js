import { useState, useEffect } from 'react'
import axios from 'axios'
import HISTORICAL_ALPHAS from '../data/historical_alphas'

// DEXScreener public API — no key needed
const DEXSCREENER_BASE = 'https://api.dexscreener.com'

// Minimum 24h volume to qualify as a "runner" ($500k)
const MIN_VOLUME_USD = 500000

// Formats a raw DEXScreener pair into our standard alpha shape
const formatPair = (pair) => ({
  id: pair.pairAddress,
  symbol: pair.baseToken?.symbol || '???',
  name: pair.baseToken?.name || 'Unknown',
  address: pair.baseToken?.address || '',
  priceUsd: pair.priceUsd || '0',
  priceChange24h: pair.priceChange?.h24 || 0,
  volume24h: pair.volume?.h24 || 0,
  marketCap: pair.marketCap || pair.fdv || 0,
  liquidity: pair.liquidity?.usd || 0,
  pairAddress: pair.pairAddress || '',
  isHistorical: false,
  logoUrl: pair.info?.imageUrl || null,
})

const useAlphas = () => {
  const [liveAlphas, setLiveAlphas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchLiveAlphas = async () => {
    try {
      setLoading(true)
      setError(null)

      // Fetch top boosted/trending tokens on Solana from DEXScreener
      const response = await axios.get(
        `${DEXSCREENER_BASE}/token-boosts/top/v1`
      )

      const allTokens = response.data || []

      // Filter to Solana only and extract addresses
      const solanaTokens = allTokens
        .filter((t) => t.chainId === 'solana')
        .slice(0, 20) // top 20 boosted

      if (solanaTokens.length === 0) {
        setLiveAlphas([])
        setLoading(false)
        return
      }

      // Fetch pair data for each token address to get price/volume/mcap
      const addresses = solanaTokens
        .map((t) => t.tokenAddress)
        .filter(Boolean)
        .join(',')

      const pairResponse = await axios.get(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${addresses}`
      )

      const pairs = pairResponse.data?.pairs || []

      // Filter: Solana chain, minimum volume, not a stablecoin
      const runners = pairs
        .filter(
          (p) =>
            p.chainId === 'solana' &&
            (p.volume?.h24 || 0) >= MIN_VOLUME_USD &&
            p.baseToken?.symbol !== 'USDC' &&
            p.baseToken?.symbol !== 'USDT' &&
            p.baseToken?.symbol !== 'SOL'
        )
        // Sort by 24h price change descending — biggest movers first
        .sort((a, b) => (b.priceChange?.h24 || 0) - (a.priceChange?.h24 || 0))
        // Deduplicate by base token address
        .filter(
          (pair, index, self) =>
            index ===
            self.findIndex((p) => p.baseToken?.address === pair.baseToken?.address)
        )
        .slice(0, 15)
        .map(formatPair)

      setLiveAlphas(runners)
      setLastUpdated(new Date())
    } catch (err) {
      console.error('DEXScreener fetch failed:', err)
      setError('Failed to fetch live runners. Showing past alphas.')
      setLiveAlphas([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLiveAlphas()
    // Refresh every 60 seconds
    const interval = setInterval(fetchLiveAlphas, 60000)
    return () => clearInterval(interval)
  }, [])

  return {
    liveAlphas,
    historicalAlphas: HISTORICAL_ALPHAS,
    loading,
    error,
    lastUpdated,
    refresh: fetchLiveAlphas,
  }
}

export default useAlphas