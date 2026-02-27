// ─── BetaPlays Backend ────────────────────────────────────────────
// Two endpoints:
//   POST /api/score-betas  — Vector 8 AI scoring via Anthropic
//   GET  /api/birdeye      — Birdeye data proxy (keeps key server-side)
//   GET  /health           — uptime check
//
// Keys live ONLY here in server/.env — never in the frontend.
// Deploy to Render/Railway; set env vars in their dashboard.

const express   = require('express')
const cors      = require('cors')
const Anthropic = require('@anthropic-ai/sdk')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const app    = express()
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.use(cors())
app.use(express.json())

// Rate limiting — 30 req/min per IP across all /api routes
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, slow down degen' },
})
app.use('/api/', limiter)

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }))

// ─── Vector 8: AI beta scoring ────────────────────────────────────
app.post('/api/score-betas', async (req, res) => {
  try {
    const { prompt } = req.body
    if (!prompt) return res.status(400).json({ error: 'prompt required' })

    const message = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    })

    const text  = message.content.map(b => b.text || '').join('')
    const clean = text.replace(/```json|```/g, '').trim()
    res.json(JSON.parse(clean))
  } catch (err) {
    console.error('Score error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Birdeye proxy ────────────────────────────────────────────────
// Routes Birdeye API calls through the backend so the key stays
// server-side. Frontend calls /api/birdeye?endpoint=...&address=...
//
// Supported endpoints:
//   token_overview  → /defi/token_overview
//   holders         → /v1/token/holder
//
// Usage from frontend:
//   fetch('http://localhost:3001/api/birdeye?endpoint=token_overview&address=ABC...')
app.get('/api/birdeye', async (req, res) => {
  const { endpoint, address } = req.query
  if (!address) return res.status(400).json({ error: 'address required' })

  const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY
  if (!BIRDEYE_KEY) return res.status(503).json({ error: 'Birdeye not configured' })

  const ENDPOINT_MAP = {
    token_overview: `https://public-api.birdeye.so/defi/token_overview?address=${address}`,
    holders:        `https://public-api.birdeye.so/v1/token/holder?address=${address}&offset=0&limit=10`,
  }

  const url = ENDPOINT_MAP[endpoint]
  if (!url) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  try {
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': BIRDEYE_KEY,
        'x-chain':   'solana',
      },
    })
    if (!response.ok) throw new Error(`Birdeye ${response.status}`)
    const data = await response.json()
    res.json(data)
  } catch (err) {
    console.error('Birdeye proxy error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`BetaPlays backend on port ${PORT}`))