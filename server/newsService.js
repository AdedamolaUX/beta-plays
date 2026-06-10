// ─── News Narrative Service ───────────────────────────────────────
// Three source pipeline (all free, real-time):
//   1. RSS feeds     — general narratives (Reuters, BBC, AP)
//   2. CryptoPanic   — crypto-specific narratives (free public endpoint)
//   3. NewsAPI       — supplementary, free tier (~24h delayed, still useful for volume)
//
// Extracts keywords, maps to EVENT_KEYWORD_MAP categories.
// A category is "active" when ≥2 headlines match it within MAX_HEADLINE_AGE_MS.
// Confidence = matched headlines / total recent headlines (capped at 1.0).
//
// Cache: 30 minutes in-memory.
// NewsAPI free tier = 100 req/day → 48 req/day at 30min polling.
// RSS + CryptoPanic = unlimited.

const axios     = require('axios')
const RSSParser = require('rss-parser')

const rssParser = new RSSParser({ timeout: 8000 })

const NEWS_API_KEY        = process.env.NEWS_API_KEY
const CRYPTOPANIC_TOKEN   = process.env.CRYPTOPANIC_API_KEY  // optional — public endpoint works without it
const CACHE_TTL_MS        = 30 * 60 * 1000
const MIN_HEADLINES       = 2
const MAX_HEADLINE_AGE_MS = 12 * 60 * 60 * 1000  // 12h — RSS is real-time so 12h is plenty

// ─── RSS Feed Registry ────────────────────────────────────────────
const RSS_FEEDS = [
  { url: 'https://feeds.reuters.com/reuters/topNews',             name: 'Reuters'   },
  { url: 'https://feeds.bbci.co.uk/news/rss.xml',                name: 'BBC'       },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', name: 'NYT' },
  { url: 'https://feeds.skynews.com/feeds/rss/world.xml',        name: 'SkyNews'   },
]

// ─── Keyword → Category Map ───────────────────────────────────────
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
    'coinbase', 'binance', 'blockchain regulation', 'solana', 'defi',
    'nft', 'web3', 'altcoin', 'memecoin',
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

// ─── Normalise articles to { title, description, publishedAt } ────
const normalise = (title = '', description = '', publishedAt) => ({
  title:       title.slice(0, 200),
  description: description.slice(0, 300),
  publishedAt: publishedAt ? new Date(publishedAt).getTime() : Date.now(),
})

// ─── Source 1: RSS ─────────────────────────────────────────────────
const fetchRSS = async () => {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(feed =>
      rssParser.parseURL(feed.url).then(parsed =>
        (parsed.items || []).map(item =>
          normalise(item.title, item.contentSnippet || item.content, item.pubDate || item.isoDate)
        )
      )
    )
  )
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
}

// ─── Source 2: CryptoPanic ─────────────────────────────────────────
const fetchCryptoPanic = async () => {
  try {
    const params = { public: 'true', kind: 'news', regions: 'en' }
    if (CRYPTOPANIC_TOKEN) params.auth_token = CRYPTOPANIC_TOKEN
    const res = await axios.get('https://cryptopanic.com/api/v1/posts/', { params, timeout: 8000 })
    return (res.data?.results || []).map(item =>
      normalise(item.title, item.body || '', item.published_at)
    )
  } catch (err) {
    console.warn('[NewsService] CryptoPanic fetch failed (non-fatal):', err.message)
    return []
  }
}

// ─── Source 3: NewsAPI (supplementary) ────────────────────────────
const fetchNewsAPI = async () => {
  if (!NEWS_API_KEY) return []
  try {
    const res = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: { language: 'en', pageSize: 40, apiKey: NEWS_API_KEY },
      timeout: 8000,
    })
    return (res.data?.articles || []).map(a =>
      normalise(a.title, a.description, a.publishedAt)
    )
  } catch (err) {
    console.warn('[NewsService] NewsAPI fetch failed (non-fatal):', err.message)
    return []
  }
}

// ─── Parse + Score ─────────────────────────────────────────────────
const parseArticles = (articles) => {
  const now    = Date.now()
  const recent = articles.filter(a => (now - a.publishedAt) <= MAX_HEADLINE_AGE_MS)
  const counts   = {}
  const snippets = {}

  for (const article of recent) {
    const text = `${article.title} ${article.description}`.toLowerCase()
    for (const [category, keywords] of Object.entries(EVENT_KEYWORD_MAP)) {
      if (keywords.some(kw => text.includes(kw))) {
        counts[category]   = (counts[category] || 0) + 1
        if (!snippets[category]) snippets[category] = article.title.slice(0, 120)
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

// ─── Dedup by title (cross-source) ────────────────────────────────
const dedupArticles = (articles) => {
  const seen = new Set()
  return articles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 60)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─── Cache ─────────────────────────────────────────────────────────
let cachedResult = null
let cacheExpiry  = 0
let isFetching   = false

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
    console.log('[NewsService] Fetching headlines (RSS + CryptoPanic + NewsAPI)...')
    const [rssArticles, cryptoArticles, newsApiArticles] = await Promise.all([
      fetchRSS(),
      fetchCryptoPanic(),
      fetchNewsAPI(),
    ])

    const all    = dedupArticles([...rssArticles, ...cryptoArticles, ...newsApiArticles])
    const active = parseArticles(all)

    console.log(`[NewsService] Sources: RSS=${rssArticles.length} CryptoPanic=${cryptoArticles.length} NewsAPI=${newsApiArticles.length} → ${all.length} unique`)
    console.log(`[NewsService] ${active.length} active: [${active.map(a => a.category).join(', ')}]`)

    cachedResult = active
    cacheExpiry  = Date.now() + CACHE_TTL_MS
    return active
  } catch (err) {
    console.warn('[NewsService] Fetch failed (non-fatal):', err.message)
    return cachedResult || []
  } finally {
    isFetching = false
  }
}

// ─── Init ──────────────────────────────────────────────────────────
const init = () => {
  const sources = ['RSS (Reuters/BBC/NYT/SkyNews)', 'CryptoPanic']
  if (NEWS_API_KEY) sources.push('NewsAPI')
  console.log(`[NewsService] Initialised — sources: ${sources.join(', ')} — polling every 30min`)
  getNewsNarratives().catch(() => {})
  setInterval(() => getNewsNarratives().catch(() => {}), CACHE_TTL_MS)
}

module.exports = { getNewsNarratives, init }