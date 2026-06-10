// ─── useSubscription ──────────────────────────────────────────────
// Manages pro subscription state for the current wallet.
//
// - Checks /api/subscriptions/status on mount and wallet change
// - Exposes isPro, expiresAt, loading, and subscribe() payment flow
// - subscribe() sends SOL to treasury, then calls /api/subscriptions/verify
// - Free users get: pattern matching + V10 Telegram + News narratives
// - Pro users get: V8 AI scoring, Vision, V11 Twitter stub, V12
//
// Cache: localStorage betaplays_sub_cache — avoids re-checking on every render.
// TTL: 5 minutes (status won't change between renders)

import { useState, useEffect, useCallback } from 'react'

const BACKEND_URL    = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const CACHE_KEY      = 'betaplays_sub_cache'
const CACHE_TTL_MS   = 5 * 60 * 1000
const SUB_PRICE_SOL  = 0.5
const TREASURY       = '7LbtGZTToXYQ8FRnwBy6TfLMi4nMw2ge523mimwTSJUk'
const LAMPORTS       = 1_000_000_000

const getCache = (wallet) => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed.wallet !== wallet) return null
    if (Date.now() > parsed.expiry) return null
    return parsed
  } catch { return null }
}

const setCache = (wallet, isPro, expiresAt) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      wallet,
      isPro,
      expiresAt,
      expiry: Date.now() + CACHE_TTL_MS,
    }))
  } catch { /* storage full — non-fatal */ }
}

const clearCache = () => {
  try { localStorage.removeItem(CACHE_KEY) } catch { /* */ }
}

export default function useSubscription({ authToken, authWallet, isAuthed }) {
  const [isPro,      setIsPro]      = useState(false)
  const [expiresAt,  setExpiresAt]  = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [subLoading, setSubLoading] = useState(false)
  const [subError,   setSubError]   = useState(null)
  const [subSuccess, setSubSuccess] = useState(false)

  // ── Check subscription status ──────────────────────────────────
  const checkStatus = useCallback(async (force = false) => {
    if (!isAuthed || !authWallet) {
      setIsPro(false)
      setExpiresAt(null)
      return
    }

    // Use cache unless forced
    if (!force) {
      const cached = getCache(authWallet)
      if (cached) {
        setIsPro(cached.isPro)
        setExpiresAt(cached.expiresAt)
        return
      }
    }

    setLoading(true)
    try {
      const res = await fetch(`${BACKEND_URL}/api/subscriptions/status`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      })
      if (!res.ok) throw new Error('Status check failed')
      const data = await res.json()
      setIsPro(data.isPro)
      setExpiresAt(data.expires_at || null)
      setCache(authWallet, data.isPro, data.expires_at || null)
    } catch (err) {
      console.warn('[Subscription] Status check failed:', err.message)
      // Fail open — don't lock out users due to network error
    } finally {
      setLoading(false)
    }
  }, [isAuthed, authWallet, authToken])

  // Check on mount and wallet change
  useEffect(() => {
    clearCache() // clear stale cache on wallet change
    checkStatus()
  }, [authWallet, isAuthed]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Payment flow ───────────────────────────────────────────────
  // sendTransaction: from useWallet() — pass from parent
  // email: optional, collected during flow
  const subscribe = useCallback(async ({ sendTransaction, email }) => {
    if (!isAuthed || !authToken) {
      setSubError('Connect and sign in first')
      return false
    }
    if (!sendTransaction) {
      setSubError('Wallet not ready')
      return false
    }

    setSubLoading(true)
    setSubError(null)
    setSubSuccess(false)

    try {
      // 1. Build SOL transfer transaction
      const { Connection, Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js')
      const RPC_URL    = import.meta.env.VITE_HELIUS_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${import.meta.env.VITE_HELIUS_API_KEY}`
        : 'https://api.mainnet-beta.solana.com'
      const connection = new Connection(RPC_URL, 'confirmed')
      const fromPubkey = new PublicKey(authWallet)
      const toPubkey   = new PublicKey(TREASURY)
      const lamports   = Math.floor(SUB_PRICE_SOL * LAMPORTS_PER_SOL)

      const { blockhash } = await connection.getLatestBlockhash()
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey, toPubkey, lamports })
      )
      tx.recentBlockhash = blockhash
      tx.feePayer        = fromPubkey

      // 2. Send transaction
      const signature = await sendTransaction(tx, connection)
      console.log('[Subscription] Tx sent:', signature)

      // 3. Wait for confirmation (up to 30s)
      await connection.confirmTransaction(signature, 'confirmed')
      console.log('[Subscription] Tx confirmed')

      // 4. Verify on backend
      const verifyRes = await fetch(`${BACKEND_URL}/api/subscriptions/verify`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ tx_signature: signature, email: email || null }),
      })

      const verifyData = await verifyRes.json()
      if (!verifyRes.ok) throw new Error(verifyData.error || 'Verification failed')

      // 5. Update state
      setIsPro(true)
      setExpiresAt(verifyData.expires_at)
      setSubSuccess(true)
      clearCache()
      setCache(authWallet, true, verifyData.expires_at)
      console.log('[Subscription] Pro activated:', verifyData.expires_at)
      return true

    } catch (err) {
      console.error('[Subscription] Payment failed:', err.message)
      setSubError(err.message || 'Payment failed — please try again')
      return false
    } finally {
      setSubLoading(false)
    }
  }, [isAuthed, authToken, authWallet])

  return {
    isPro,
    expiresAt,
    loading,
    subLoading,
    subError,
    subSuccess,
    subscribe,
    checkStatus,
    setSubError,
    setSubSuccess,
  }
}