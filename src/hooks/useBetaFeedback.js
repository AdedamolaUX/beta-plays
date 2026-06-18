// ── Beta Feedback Loop ────────────────────────────────────────────
// Tracks hit/miss signals per beta address in localStorage.
// Hit  = user added to Watchlist OR clicked through to DEXScreener
// Miss = user flagged as "not_beta"
// Deprioritise rule: misses >= 2 AND hits === 0 → sort to bottom
//
// Storage key: bp_beta_feedback_v1
// Shape: { [address]: { hits: number, misses: number, lastUpdated: number } }

const FEEDBACK_KEY = 'bp_beta_feedback_v1'

const load = () => {
  try { return JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '{}') }
  catch { return {} }
}

const save = (data) => {
  try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(data)) }
  catch { /* storage full — silent */ }
}

export const recordHit = (address) => {
  if (!address) return
  const data = load()
  const entry = data[address] || { hits: 0, misses: 0 }
  data[address] = { ...entry, hits: entry.hits + 1, lastUpdated: Date.now() }
  save(data)
}

export const recordMiss = (address) => {
  if (!address) return
  const data = load()
  const entry = data[address] || { hits: 0, misses: 0 }
  data[address] = { ...entry, misses: entry.misses + 1, lastUpdated: Date.now() }
  save(data)
}

export const getFeedback = (address) => {
  if (!address) return { hits: 0, misses: 0 }
  const data = load()
  return data[address] || { hits: 0, misses: 0 }
}

export const isDeprioritised = (address) => {
  const { hits, misses } = getFeedback(address)
  return misses >= 2 && hits === 0
}