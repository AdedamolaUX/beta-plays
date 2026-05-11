// ─── News Narrative Service ───────────────────────────────────────
// Polls NewsAPI every 30 minutes for top headlines.
// Extracts keywords, maps to lore_map categories via EVENT_KEYWORD_MAP.
// Returns active event categories with confidence score + headline snippet.
//
// Design goals:
//   - No hardcoded category pairs — keyword→category mapping only
//   - A category is "active" when ≥3 headlines in the last 2 hours match it
//   - Confidence = matched headlines / total recent headlines (capped at 1.0)
//   - One headline snippet per active category (most recent match)
//   - Graceful degradation — quota hit or outage → returns stale cache or []
//
// Cache: 30 minutes in-memory. NewsAPI free tier = 100 req/day.
// 30min polling = 48 req/day — well within limit.

const axios = require('axios')

const NEWS_API_KEY        = process.env.NEWS_API_KEY
const CACHE_TTL_MS        = 30 * 60 * 1000
const MIN_HEADLINES       = 2                      // lowered from 3 — free tier returns fewer recent headlines
const MAX_HEADLINE_AGE_MS = 6 * 60 * 60 * 1000   // extended from 2h to 6h — free tier headlines are older

const EVENT_KEYWORD_MAP = {
  space: [
    'nasa', 'spacex', 'rocket launch', 'asteroid', 'artemis', 'moon landing',
    'mars mission', 'space station', 'iss', 'starship', 'satellite launch',
    'james webb', 'orbital', 'lunar',
  ],
  elon: [
    'elon musk', 'elon', 'tesla recall', 'spacex', 'grok ai',
    'musk', 'neuralink', 'x.com',
  ],
  trump: [
    'trump', 'maga', 'donald trump', 'white house', 'executive order',
    'tariff', 'mar-a-lago', 'republican', 'gop',
  ],
  political: [
    'election', 'president', 'congress', 'senate', 'prime minister',
    'government shutdown', 'sanctions', 'diplomatic', 'referendum', 'ceasefire',
  ],
  geopolitical: [
    'iran', 'north korea', 'missile strike', 'military conflict', 'war',
    'invasion', 'airstrike', 'nuclear threat', 'nato', 'ukraine',
    'russia', 'taiwan strait', 'middle east tension',
  ],
  ai: [
    'artificial intelligence', 'openai', 'chatgpt', 'gemini ai', 'anthropic',
    'ai model', 'machine learning', 'llm', 'deepseek',
    'generative ai', 'ai regulation', 'ai agent',
  ],
  crypto: [
    'bitcoin', 'ethereum', 'crypto', 'sec crypto', 'etf approval',
    'federal reserve rate', 'fed rate', 'interest rate cut', 'stablecoin',
    'coinbase', 'binance', 'blockchain regulation',
  ],
  gaming: [
    'video game', 'gaming', 'esports', 'nintendo', 'playstation',
    'xbox', 'steam', 'fortnite', 'game release', 'game launch',
  ],
  sports: [
    'nba', 'nfl', 'world cup', 'olympics', 'championship', 'super bowl',
    'fifa', 'ufc', 'boxing match', 'grand slam', 'formula 1', 'f1 race',
  ],
  celebrity: [
    'celebrity', 'kanye', 'kardashian', 'taylor swift', 'drake',
    'grammy', 'oscars', 'met gala', 'viral celebrity',
  ],
  animals: [
    'gorilla', 'endangered species', 'animal rescue', 'wildlife',
    'zoo', 'conservation', 'viral animal',
  ],
}

let cachedResult = null
let cacheExpiry  = 0
let isFetching   = false

const fetchHeadlines = async () => {
  const res = await axios.get('https://newsapi.org/v2/top-headlines', {
    params: { language: 'en', pageSize: 40, apiKey: NEWS_API_KEY },
    timeout: 8000,
  })
  return res.data?.articles || []
}

const parseHeadlines = (articles) => {
  const now    = Date.now()
  const recent = articles.filter(a => (now - new Date(a.publishedAt).getTime()) <= MAX_HEADLINE_AGE_MS)
  const counts   = {}
  const snippets = {}

  for (const article of recent) {
    const text = `${article.title || ''} ${article.description || ''}`.toLowerCase()
    for (const [category, keywords] of Object.entries(EVENT_KEYWORD_MAP)) {
      if (keywords.some(kw => text.includes(kw))) {
        counts[category] = (counts[category] || 0) + 1
        if (!snippets[category]) snippets[category] = (article.title || '').slice(0, 120)
      }
    }
  }

  const total = recent.length || 1
  return Object.entries(counts)
    .filter(([, count]) => count >= MIN_HEADLINES)
    .map(([category, count]) => ({
      category,
      confidence: Math.min(count / total, 1.0),
      matchCount: count,
      headline:   snippets[category] || '',
    }))
    .sort((a, b) => b.confidence - a.confidence)
}

const getNewsNarratives = async () => {
  const now = Date.now()
  if (cachedResult && now < cacheExpiry) return cachedResult
  if (isFetching) {
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (cachedResult && Date.now() < cacheExpiry) return cachedResult
    }
    return cachedResult || []
  }
  isFetching = true
  try {
    console.log('[NewsService] Fetching headlines...')
    const articles = await fetchHeadlines()
    const active   = parseHeadlines(articles)
    cachedResult   = active
    cacheExpiry    = Date.now() + CACHE_TTL_MS
    console.log(`[NewsService] ${active.length} active: [${active.map(a => a.category).join(', ')}]`)
    return active
  } catch (err) {
    console.warn('[NewsService] Fetch failed (non-fatal):', err.message)
    return cachedResult || []
  } finally {
    isFetching = false
  }
}

const init = () => {
  if (!NEWS_API_KEY) {
    console.log('[NewsService] No API key — service disabled')
    return
  }
  getNewsNarratives().catch(() => {})
  setInterval(() => getNewsNarratives().catch(() => {}), CACHE_TTL_MS)
  console.log('[NewsService] Initialised — polling every 30min')
}

module.exports = { getNewsNarratives, init }