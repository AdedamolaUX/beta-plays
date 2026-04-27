import betaplaysLogo from './assets/betaplays-logo.png'
import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import useAlphas from './hooks/useAlphas'
import LEGENDS, { submitNomination, getNominations, NOMINATIONS_KEY } from './data/historical_alphas'
import useBetas, { getSignal, getWavePhase, getMcapRatio } from './hooks/useBetas'
import useParentAlpha from './hooks/useParentAlpha'
import useNarrativeSzn from './hooks/useNarrativeSzn'
import useBirdeye from './hooks/useBirdeye'
import './index.css'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// ─── Helpers ────────────────────────────────────────────────────

const formatNum = (num) => {
  if (!num || num === 0) return '—'
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`
  if (num >= 1_000_000)     return `$${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000)         return `$${(num / 1_000).toFixed(1)}K`
  return `$${num.toFixed(2)}`
}

const formatPrice = (price) => {
  if (!price) return '—'
  const n = parseFloat(price)
  if (isNaN(n) || n === 0) return '—'
  if (n >= 1)      return `$${n.toFixed(2)}`
  if (n >= 0.01)   return `$${n.toFixed(2)}`   // $0.02, $0.57
  // For small prices: find first significant digit, show just that one digit
  // e.g. 0.000260 → $0.0002,  0.000705 → $0.0007,  0.00314 → $0.003
  const str = n.toFixed(20)
  const match = str.match(/^0\.(0*)([1-9])/)
  if (match) return `$0.${match[1]}${match[2]}`
  return `$${n.toExponential(1)}`
}

const shortAddress = (addr) =>
  addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : ''

// ─── Copy CA Button ───────────────────────────────────────────────
// Renders the shortened address + a clipboard icon.
// Click the icon: full CA copied, brief "✓" flash shown.
const CopyAddress = ({ address, style = {} }) => {
  const [copied, setCopied] = useState(false)
  const [hovered, setHovered] = useState(false)
  if (!address) return null
  const handleCopy = (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      const el = document.createElement('textarea')
      el.value = address
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', ...style }}>
      <span
        onClick={handleCopy}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
          color: copied ? 'var(--neon-green)' : hovered ? 'var(--cyan)' : 'var(--text-muted)',
          background: copied
            ? 'rgba(0,255,136,0.08)'
            : hovered ? 'rgba(0,212,255,0.08)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${copied
            ? 'rgba(0,255,136,0.3)'
            : hovered ? 'rgba(0,212,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: 4, padding: '2px 6px',
          cursor: 'pointer', userSelect: 'none',
          transition: 'all 0.15s ease',
          letterSpacing: '0.03em',
        }}
      >
        {copied ? '✓' : '⎘'} {copied ? 'Copied!' : shortAddress(address)}
      </span>
      {hovered && !copied && (
        <span style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--surface-2, #0d1117)',
          border: '1px solid rgba(0,212,255,0.35)',
          borderRadius: 4, padding: '5px 10px', zIndex: 1000,
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.05em', textTransform: 'uppercase',
          color: 'var(--cyan)', whiteSpace: 'nowrap',
          boxShadow: '0 0 12px rgba(0,212,255,0.15), 0 4px 16px rgba(0,0,0,0.7)',
          pointerEvents: 'none',
        }}>
          Copy CA
        </span>
      )}
    </span>
  )
}


// ─── Shared Styled Tooltip ────────────────────────────────────────
// Wraps any element. On hover shows a styled popup matching the app
// font/theme. Replaces all native browser title= attributes.
// Usage: <Tooltip text="Open on DEXScreener"><span>DEX ↗</span></Tooltip>
const TOOLTIP_STYLE = {
  position: 'fixed',
  background: '#0d1117',
  border: '1px solid rgba(0,212,255,0.35)',
  borderRadius: 4, padding: '5px 10px', zIndex: 9999,
  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.05em', textTransform: 'uppercase',
  color: 'var(--cyan)', whiteSpace: 'nowrap',
  boxShadow: '0 0 12px rgba(0,212,255,0.15), 0 4px 16px rgba(0,0,0,0.7)',
  pointerEvents: 'none',
  transform: 'translate(-50%, -100%)',
}

const Tooltip = ({ text, children }) => {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  if (!text) return children

  const show = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect()
      setPos({ left: r.left + r.width / 2, top: r.top - 6 })
    }
  }
  const hide = () => setPos(null)

  return (
    <span
      ref={ref}
      style={{ display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {pos && createPortal(
        <span style={{ ...TOOLTIP_STYLE, left: pos.left, top: pos.top }}>{text}</span>,
        document.body
      )}
    </span>
  )
}

// ─── X / Twitter Search Button ───────────────────────────────────
// Opens a Twitter/X search for the token symbol in a new tab.
// Placed next to the DEX button on alpha cards, beta rows, and drawer.
const XSearchButton = ({ symbol, onClick, style = {} }) => {
  if (!symbol) return null
  const query = encodeURIComponent(`$${symbol}`)
  const url   = `https://twitter.com/search?q=${query}&f=live`
  return (
    <Tooltip text="Search on X / Twitter">
      <span
        onClick={e => { e.stopPropagation(); if (onClick) onClick(e); window.open(url, '_blank') }}
        style={{
          fontFamily: 'var(--font-mono)', fontSize: 8,
          color: 'var(--text-muted)', cursor: 'pointer',
          padding: '1px 4px', borderRadius: 3,
          border: '1px solid rgba(255,255,255,0.08)',
          transition: 'color 0.15s', userSelect: 'none',
          ...style,
        }}
        onMouseEnter={e => { e.currentTarget.style.color = '#1d9bf0'; e.currentTarget.style.borderColor = 'rgba(29,155,240,0.4)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
      >𝕏</span>
    </Tooltip>
  )
}

// ─── Derivative Detection ────────────────────────────────────────

const KNOWN_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER', 'BASED',
  'REAL', 'TURBO', 'CHAD', 'FAT', 'TINY', 'LITTLE', 'BIG',
  'MEAN', 'EVIL', 'DARK', 'WILD', 'MAD', 'DEGEN',
]
const KNOWN_SUFFIXES = [
  'KIN', 'INU', 'WIF', 'HAT', 'CAT', 'DOG', 'AI',
  'DAO', 'MOON', 'PUMP', 'WIFHAT', 'WIFCAT',
]
const isDerivative = (symbol) => {
  const s = symbol.toUpperCase()
  const hasPrefix = KNOWN_PREFIXES.some((p)   => s.startsWith(p) && s.length > p.length   + 1)
  const hasSuffix = KNOWN_SUFFIXES.some((sfx) => s.endsWith(sfx) && s.length > sfx.length + 1)
  return hasPrefix || hasSuffix
}

// ─── Check if parent is in Cooling (localStorage) ───────────────
const isParentCooling = (parentAddress) => {
  try {
    const stored = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')
    const entry  = stored[parentAddress]
    if (!entry) return false
    const age = Date.now() - entry.lastSeen
    return age > 0 && age <= 30 * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

// ─── Search filter ───────────────────────────────────────────────
const matchesSearch = (alpha, query) => {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    (alpha.symbol || '').toLowerCase().includes(q) ||
    (alpha.name   || '').toLowerCase().includes(q) ||
    (alpha.address|| '').toLowerCase().includes(q)
  )
}

// ─── Data Source Status ──────────────────────────────────────────
// Shows which of the 5 alpha feed sources are currently live.
// Reads from the liveAlphas + coolingAlphas arrays — zero extra API calls.
const DataSourceStatus = ({ liveAlphas = [], coolingAlphas = [] }) => {
  const all = [...liveAlphas, ...coolingAlphas]
  const sources = [
    { key: 'boost',          label: 'Boosted',   short: 'BST' },
    { key: 'profile',        label: 'Profiles',  short: 'PRF' },
    { key: 'pumpfun_bonded', label: 'PumpFun',   short: 'PMP' },
    { key: 'new_pair',       label: 'New Pairs', short: 'NEW' },
    { key: 'birdeye',        label: 'Birdeye',   short: 'BRD' },
  ]
  const activeSources = new Set(all.map(a => a.source).filter(Boolean))
  const deadSources = sources.filter(s => !activeSources.has(s.key)).map(s => s.label)
  const liveCount = sources.length - deadSources.length
  const tipText = liveCount === 5
    ? '5/5 data sources live — all good'
    : liveCount + '/5 sources live — offline: ' + deadSources.join(', ')

  return (
    <Tooltip text={tipText}>
      <div style={{ display: "flex", alignItems: "center", gap: 3, cursor: "default" }}>
        {sources.map(({ key, short }) => {
          const live = activeSources.has(key)
          return (
            <span key={key} style={{
              fontFamily: "var(--font-mono)", fontSize: 7, fontWeight: 700,
              padding: "1px 4px", borderRadius: 3,
              background: live ? "rgba(0,255,136,0.1)" : "rgba(255,68,102,0.1)",
              border: "1px solid " + (live ? "rgba(0,255,136,0.3)" : "rgba(255,68,102,0.3)"),
              color: live ? "var(--neon-green)" : "var(--red)",
              letterSpacing: 0.3,
            }}>
              {short}
            </span>
          )
        })}
      </div>
    </Tooltip>
  )
}

// ─── Latency Indicator ───────────────────────────────────────────
const BACKEND_URL_LATENCY = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const LatencyDot = () => {
  const [ms,     setMs]     = useState(null)
  const [status, setStatus] = useState('idle')

  const ping = async () => {
    const start = Date.now()
    try {
      await fetch(`${BACKEND_URL_LATENCY}/api/telegram-betas`, { method: 'GET', signal: AbortSignal.timeout(5000) })
      const elapsed = Date.now() - start
      setMs(elapsed)
      setStatus(elapsed < 300 ? 'good' : elapsed < 800 ? 'warn' : 'bad')
    } catch {
      setMs(null)
      setStatus('offline')
    }
  }

  useEffect(() => {
    ping()
    const id = setInterval(ping, 30000)
    return () => clearInterval(id)
  }, [])

  const colorMap = { good: 'var(--neon-green)', warn: 'var(--amber)', bad: 'var(--red)', offline: 'var(--text-muted)', idle: 'var(--text-muted)' }
  const color = colorMap[status]
  const tipText = status === 'offline' ? 'Server offline' : status === 'idle' ? 'Checking connection...' : `${ms}ms — ${status === 'good' ? 'Good' : status === 'warn' ? 'Slow' : 'Very slow'}`

  return (
    <Tooltip text={tipText}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: color,
          boxShadow: status === 'good' ? `0 0 6px ${color}` : 'none',
          display: 'inline-block',
        }} />
        <span style={{ fontFamily: 'var(--font-number)', fontSize: 9, color, letterSpacing: 0 }}>
          {ms !== null ? `${ms}ms` : '···'}
        </span>
      </div>
    </Tooltip>
  )
}

// ─── Narrative + Runner Ticker ────────────────────────────────────
// Scrolling marquee strip showing live runners and active narratives.
// Runners: symbol + 24h% change. Narratives: emoji + label + total vol.
// Auto-scrolls, pauses on hover.
const NarrativeTicker = ({ liveAlphas = [], sznCards = [] }) => {
  if (!liveAlphas.length && !sznCards.length) return null

  // Build ticker items — runners first, then narratives
  const runnerItems = liveAlphas.slice(0, 20).map(a => {
    const chg = parseFloat(a.priceChange24h) || 0
    const isPos = chg >= 0
    return (
      <span key={`r-${a.address}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 32 }}>
        {a.logoUrl && <img src={a.logoUrl} alt="" style={{ width: 13, height: 13, borderRadius: '50%', objectFit: 'cover' }} />}
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.03em', color: 'var(--text-primary)' }}>
          ${a.symbol}
        </span>
        <span style={{ fontSize: 10, color: isPos ? 'var(--neon-green)' : 'var(--red)', fontWeight: 700 }}>
          {isPos ? '+' : ''}{chg.toFixed(1)}%
        </span>
      </span>
    )
  })

  const narrativeItems = sznCards.slice(0, 8).map(szn => (
    <span key={`n-${szn.key}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 32 }}>
      <span style={{ fontSize: 11 }}>{szn.heat?.emoji || '📈'}</span>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.03em', color: 'var(--cyan)' }}>
        {szn.label}
      </span>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
        ${(szn.totalVolume / 1_000_000).toFixed(1)}M vol
      </span>
    </span>
  ))

  // Separator between runners and narratives sections
  const separator = (
    <span style={{ marginRight: 32, color: 'rgba(0,212,255,0.25)', fontSize: 10, letterSpacing: 4 }}>···</span>
  )

  const items = [...runnerItems, separator, ...narrativeItems]
  // Duplicate for seamless loop
  const allItems = [...items, ...items]

  return (
    <div
      className="narrative-ticker"
      style={{
        width: '100%',
        background: 'rgba(0,0,0,0.5)',
        borderBottom: '1px solid rgba(0,212,255,0.12)',
        borderTop: '1px solid rgba(0,212,255,0.06)',
        overflow: 'hidden',
        height: 30,
        display: 'flex',
        alignItems: 'center',
        cursor: 'default',
        fontFamily: "'Syne', var(--font-display), sans-serif",
      }}
    >
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        animation: 'tickerScroll 70s linear infinite',
        paddingLeft: '2rem',
      }}>
        {allItems}
      </div>
      <style>{`
        @keyframes tickerScroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  )
}

// ─── Navbar ─────────────────────────────────────────────────────

const Navbar = ({ onListBeta, newRunners, liveAlphas, coolingAlphas }) => (
  <nav className="navbar">
  <div className="navbar-brand">
    <img
      src={betaplaysLogo}
      alt="BetaPlays"
      style={{ height: 44, width: 44, objectFit: 'contain' }}
    />
    <span className="brand-name">Beta<span>Plays</span></span>
  </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div className={`navbar-status${newRunners ? ' navbar-status--flash' : ''}`}>
        <span className={`status-dot${newRunners ? ' status-dot--flash' : ''}`}></span>
        <span style={{ fontFamily: 'var(--font-number)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em' }}>
          LIVE · SOLANA
        </span>
      </div>
      <DataSourceStatus liveAlphas={liveAlphas} coolingAlphas={coolingAlphas} />
      <LatencyDot />
    </div>
    <div className="navbar-actions">
      <button className="btn btn-amber btn-sm" onClick={onListBeta}>
        ⚡ List Your Beta
      </button>
    </div>
  </nav>
)

// ─── Narrative Szn Card ──────────────────────────────────────────

const SznCard = ({ szn, isSelected, onClick }) => {
  const isPositive  = szn.avgChange >= 0
  const heat        = szn.heat || { label: 'MILD', color: '#888888', emoji: '😴' }
  const sznScore    = szn.sznScore || 0
  const momentum    = szn.momentum || 0
  const leader      = szn.leader
  const topThree    = szn.tokens.slice(0, 3)

  return (
    <div
      className={`card szn-card ${isSelected ? 'active' : ''}`}
      onClick={onClick}
      style={{
        background:  isSelected ? 'rgba(0,212,255,0.08)' : 'rgba(0,212,255,0.03)',
        borderColor: isSelected ? 'var(--cyan)' : `${heat.color}33`,
        transition: 'all 0.15s ease',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 17 }}>{szn.label.split(' ')[0]}</span>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13, color: 'var(--cyan)' }}>
                {szn.label.split(' ').slice(1).join(' ')} Szn
              </div>
              {szn.source === 'ai' && (
                <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 4px' }}>🤖 AI</span>
              )}
              {szn.source === 'mixed' && (
                <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 4px' }}>🤖 +{szn.aiEnriched}</span>
              )}
            </div>
            <div style={{ fontFamily: 'var(--font-number)', fontSize: 8, color: 'var(--text-muted)' }}>
              {szn.tokenCount} tokens · {formatNum(szn.totalVolume)} vol
            </div>
          </div>
        </div>
        {/* Heat badge + score */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
            color: heat.color, letterSpacing: 0.5,
          }}>{heat.emoji} {heat.label}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
            score {sznScore}/100
          </span>
        </div>
      </div>

      {/* Momentum bar */}
      <div style={{ marginBottom: 7 }}>
        <div style={{ marginBottom: 3 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
            momentum
          </span>
        </div>
        <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${momentum}%`,
            background: momentum >= 60 ? 'var(--neon-green)' : momentum >= 40 ? 'var(--amber)' : 'var(--red)',
            borderRadius: 2, transition: 'width 0.3s ease',
          }} />
        </div>
      </div>

      {/* Leader + avg change */}
      {leader && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'rgba(255,255,255,0.03)', borderRadius: 5, padding: '3px 7px',
          marginBottom: 6,
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
            leader
          </span>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, color: 'var(--text-primary)' }}>
            ${leader.symbol}
          </span>
          <span style={{ fontFamily: 'var(--font-number)', fontSize: 9, fontWeight: 700, color: 'var(--neon-green)' }}>
            +{(parseFloat(leader.priceChange24h) || 0).toFixed(0)}%
          </span>
        </div>
      )}

      {/* Top 3 token chips */}
      <div style={{ display: 'flex', gap: 4 }}>
        {topThree.map((t) => {
          const c = parseFloat(t.priceChange24h) || 0
          return (
            <div key={t.id || t.symbol} style={{
              flex: 1, background: 'rgba(255,255,255,0.04)',
              borderRadius: 5, padding: '3px 5px',
              fontFamily: 'var(--font-mono)', fontSize: 8, overflow: 'hidden',
            }}>
              <div style={{ color: 'var(--text-secondary)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                ${t.symbol}
              </div>
              <div style={{ color: c >= 0 ? 'var(--neon-green)' : 'var(--red)', fontSize: 7 }}>
                {c >= 0 ? '+' : ''}{c.toFixed(0)}%
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Alpha Token Card ────────────────────────────────────────────

// ─── Positioning Card ─────────────────────────────────────────────
// Specialised card for the Positioning Plays tab.
// Shows peak, current drawdown, opportunity score prominently —
// the signal a degen needs to decide if it's worth the entry.
const PositioningCard = ({ alpha, isSelected, onClick, isWatched, onToggleWatch }) => {
  const change      = parseFloat(alpha.priceChange24h) || 0
  const drawdown    = alpha.drawdownPct || 0
  const score       = alpha.opportunityScore || 0
  const peak        = alpha.peakMarketCap || 0
  const current     = alpha.marketCap || 0
  const scoreColor  = score >= 70 ? 'var(--neon-green)' : score >= 45 ? 'var(--amber)' : 'var(--text-muted)'

  return (
    <div
      className={`card alpha-card ${isSelected ? 'active' : ''}`}
      onClick={onClick}
      style={{ borderColor: isSelected ? 'var(--cyan)' : `${scoreColor}33` }}
    >
      {/* Header */}
      <div className="alpha-card-top">
        <div className="token-info">
          <div className="token-icon">
            {alpha.logoUrl ? <img src={alpha.logoUrl} alt={alpha.symbol} /> : alpha.symbol.slice(0, 3)}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="token-name">${alpha.symbol}</div>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 700,
                color: scoreColor, border: `1px solid ${scoreColor}44`,
                borderRadius: 3, padding: '1px 4px',
              }}>
                {score}/100
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <CopyAddress address={alpha.address} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
                {alpha.ageDays}d ago
              </span>
            </div>
          </div>
        </div>
        {/* Actions: star + DEX link */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Tooltip text={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}>
          <button
            onClick={e => { e.stopPropagation(); onToggleWatch?.(alpha) }}
            style={{
              background: isWatched ? 'rgba(255,184,0,0.12)' : 'rgba(255,255,255,0.06)',
              border: `1px solid ${isWatched ? 'rgba(255,184,0,0.4)' : 'rgba(255,255,255,0.12)'}`,
              borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
              fontSize: 11, lineHeight: 1.6, color: isWatched ? 'var(--amber)' : 'var(--text-secondary)',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,184,0,0.15)'; e.currentTarget.style.borderColor = 'rgba(255,184,0,0.5)' }}
            onMouseLeave={e => { e.currentTarget.style.background = isWatched ? 'rgba(255,184,0,0.12)' : 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = isWatched ? 'rgba(255,184,0,0.4)' : 'rgba(255,255,255,0.12)' }}
          >{isWatched ? '⭐' : '☆'}</button>
          </Tooltip>
          <Tooltip text="Open on DEXScreener">
          <span
            onClick={e => { e.stopPropagation(); window.open(alpha.dexUrl || `https://dexscreener.com/solana/${alpha.address}`, '_blank') }}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.08)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--cyan)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
          >DEX ↗</span>
          </Tooltip>
          <XSearchButton symbol={alpha.symbol} onClick={e => e.stopPropagation()} />
        </div>
      </div>

      {/* Drawdown bar — the key signal */}
      <div style={{ margin: '6px 0 4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
            drawdown from peak
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, color: 'var(--red)' }}>
            -{drawdown}%
          </span>
        </div>
        <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${Math.min(drawdown, 100)}%`,
            background: drawdown >= 80 ? 'var(--red)' : drawdown >= 60 ? 'var(--amber)' : 'var(--neon-green)',
            borderRadius: 2,
          }} />
        </div>
      </div>

      {/* Metrics row */}
      <div className="alpha-card-metrics">
        <div className="metric">
          <span className="metric-label">Peak</span>
          <span className="metric-value" style={{ color: 'var(--text-muted)' }}>{formatNum(peak)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Now</span>
          <span className="metric-value">{formatNum(current)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Vol 24h</span>
          <span className="metric-value">{formatNum(alpha.volume24h)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">24h %</span>
          <span className="metric-value" style={{ color: change >= 0 ? 'var(--neon-green)' : 'var(--red)' }}>
            {change >= 0 ? '+' : ''}{change.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  )
}

const AlphaCard = ({ alpha, isSelected, onClick, isWatched, onToggleWatch }) => {
  const change     = parseFloat(alpha.priceChange24h) || 0
  const isPositive = change >= 0
  const derivative = isDerivative(alpha.symbol)

  // Read parent symbol from localStorage map — written by useParentAlpha.
  // Uses useState+useEffect (not useMemo) so the card re-renders when the
  // map is populated after initial render — fixes "DERIV" showing without parent name.
  const [parentSymbol, setParentSymbol] = useState(() => {
    if (!derivative || !alpha.address) return null
    try {
      const map = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
      return map[alpha.address]?.symbol || null
    } catch { return null }
  })
  useEffect(() => {
    if (!derivative || !alpha.address) return
    const read = () => {
      try {
        const map = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
        setParentSymbol(map[alpha.address]?.symbol || null)
      } catch {}
    }
    read()
    // Re-read whenever localStorage changes (useParentAlpha writes the map)
    window.addEventListener('storage', read)
    return () => window.removeEventListener('storage', read)
  }, [derivative, alpha.address])

  const [showNomMenu, setShowNomMenu] = useState(false)
  const [menuPos,     setMenuPos]     = useState({ x: 0, y: 0 })

  return (
    <div
      className={`card alpha-card ${isSelected ? 'active' : ''}`}
      onClick={onClick}
      onContextMenu={e => { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); setShowNomMenu(m => !m) }}
      style={{ position: 'relative' }}
    >
      {showNomMenu && createPortal(
        <>
          {/* Portal backdrop — escapes any parent overflow/transform/stacking context */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 998 }}
            onClick={() => setShowNomMenu(false)}
          />
          <div style={{
            position: 'fixed',
            top: menuPos.y, left: menuPos.x,
            zIndex: 999,
            background: 'var(--surface-1)', border: '1px solid rgba(255,184,0,0.25)',
            borderRadius: 6, padding: '10px 12px', minWidth: 170,
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
          }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 1 }}>
                OPTIONS
              </div>
              <button
                onClick={() => setShowNomMenu(false)}
                style={{
                  background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 3, padding: '1px 6px', cursor: 'pointer',
                  fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)',
                  lineHeight: 1.4,
                }}
              >✕</button>
            </div>
            <NominateButton address={alpha.address} symbol={alpha.symbol} name={alpha.name} compact />
          </div>
        </>,
        document.body
      )}
      <div className="alpha-card-top">
        <div className="token-info">
          <div className="token-icon">
            {alpha.logoUrl
              ? <img src={alpha.logoUrl} alt={alpha.symbol} />
              : alpha.symbol.slice(0, 3)}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <div className="token-name">${alpha.symbol}</div>
              {derivative && (
                <span className="badge badge-new" style={{ fontSize: 7, padding: '1px 5px' }}>
                  DERIV{parentSymbol ? ` of $${parentSymbol}` : ''}
                </span>
              )}
              {alpha.isLegend && (
                <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 5px' }}>🏆 LEGEND</span>
              )}
              {alpha.isCooling && !alpha.isDumped && (
                <span className="badge badge-weak" style={{ fontSize: 7, padding: '1px 5px' }}>❄️</span>
              )}
              {alpha.isDumped && (
                <span className="badge badge-weak" style={{ fontSize: 7, padding: '1px 5px', background: 'rgba(255,68,102,0.15)', borderColor: 'rgba(255,68,102,0.4)', color: 'var(--red)' }}>💀 DUMPED</span>
              )}
              {alpha.source === 'pumpfun_bonded' && (
                <span className="badge badge-new" style={{ fontSize: 7, padding: '1px 5px' }}>🎓 BONDED</span>
              )}
              {alpha.source === 'pumpfun_pre' && (
                <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 5px', background: 'rgba(255,184,0,0.12)', borderColor: 'rgba(255,184,0,0.3)', color: 'var(--amber)' }}>
                  🔥 {alpha.bondingProgress}% bonding
                </span>
              )}
              {alpha.source === 'birdeye_trending' && (
                <span className="badge badge-organic" style={{ fontSize: 7, padding: '1px 5px' }}>🦅 ORGANIC</span>
              )}
              {alpha.source === 'dex_new' && (
                <span className="badge badge-new-pair" style={{ fontSize: 7, padding: '1px 5px' }}>✨ NEW</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <CopyAddress address={alpha.address} />
              {alpha.coolingLabel && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: alpha.isDumped ? 'var(--red)' : 'var(--cyan)' }}>
                  {alpha.coolingLabel}
                </span>
              )}
              {alpha.volumeRising && (
                <span style={{ fontFamily: 'var(--font-number)', fontSize: 8, color: 'rgb(0,255,150)' }}>
                  📈 vol↑
                </span>
              )}
              {alpha.peakDistance != null && !alpha.isDumped && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
                  {alpha.peakDistance}% of peak
                </span>
              )}
              {alpha.weeklyContext && !alpha.isDumped && alpha.weeklyContext.ageDays >= 2 && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
                  {alpha.weeklyContext.changeSinceFirst >= 0 ? '+' : ''}{alpha.weeklyContext.changeSinceFirst}% in {alpha.weeklyContext.ageDays}d
                </span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div className={`token-change ${isPositive ? 'positive' : 'negative'}`}>
            {isPositive ? '+' : ''}{change.toFixed(1)}%
          </div>
          {/* Actions: star + DEX link */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Tooltip text={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}>
            <button
              onClick={e => { e.stopPropagation(); onToggleWatch?.(alpha) }}
              style={{
                background: isWatched ? 'rgba(255,184,0,0.12)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${isWatched ? 'rgba(255,184,0,0.4)' : 'rgba(255,255,255,0.12)'}`,
                borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                fontSize: 11, lineHeight: 1.6, color: isWatched ? 'var(--amber)' : 'var(--text-secondary)',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,184,0,0.15)'; e.currentTarget.style.borderColor = 'rgba(255,184,0,0.5)' }}
              onMouseLeave={e => { e.currentTarget.style.background = isWatched ? 'rgba(255,184,0,0.12)' : 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = isWatched ? 'rgba(255,184,0,0.4)' : 'rgba(255,255,255,0.12)' }}
            >{isWatched ? '⭐' : '☆'}</button>
            </Tooltip>
            <Tooltip text="Open on DEXScreener">
            <span
              onClick={e => {
                e.stopPropagation()
                const url = alpha.dexUrl || `https://dexscreener.com/solana/${alpha.address}`
                window.open(url, '_blank')
              }}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 8,
                color: 'var(--text-muted)', cursor: 'pointer',
                padding: '1px 4px', borderRadius: 3,
                border: '1px solid rgba(255,255,255,0.08)',
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--cyan)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
            >
              DEX ↗
            </span>
            </Tooltip>
            <XSearchButton symbol={alpha.symbol} onClick={e => e.stopPropagation()} />
          </div>
        </div>
      </div>
      <div className="alpha-card-metrics">
        <div className="metric">
          <span className="metric-label">Price</span>
          <span className="metric-value">{formatPrice(alpha.priceUsd)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">MCAP</span>
          <span className="metric-value">{formatNum(alpha.marketCap)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Vol 24h</span>
          <span className="metric-value">{formatNum(alpha.volume24h)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Liq</span>
          <span className="metric-value">{formatNum(alpha.liquidity)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Alpha Board ─────────────────────────────────────────────────

// ─── Admin Nomination Panel ───────────────────────────────────────
// Hidden. Access via Ctrl+Shift+A — only you know this exists.
// Shows pending nominations with stats for approve/reject decisions.
const ADMIN_PASSWORD = 'betaplays_og_2025'

const AdminNominationPanel = ({ onClose }) => {
  const [authed, setAuthed]           = useState(() => sessionStorage.getItem('bp_admin') === '1')
  const [pwInput, setPwInput]         = useState('')
  const [pwError, setPwError]         = useState(false)
  const [nominations, setNominations] = useState(() => {
    try { return Object.values(JSON.parse(localStorage.getItem('betaplays_nominations') || '{}')) }
    catch { return [] }
  })

  const handleAuth = () => {
    if (pwInput === ADMIN_PASSWORD) {
      sessionStorage.setItem('bp_admin', '1')
      setAuthed(true)
    } else {
      setPwError(true)
      setPwInput('')
      setTimeout(() => setPwError(false), 2000)
    }
  }

  const updateStatus = (address, status) => {
    try {
      const all = JSON.parse(localStorage.getItem('betaplays_nominations') || '{}')
      if (all[address]) {
        all[address].status = status
        all[address].reviewedAt = Date.now()
        localStorage.setItem('betaplays_nominations', JSON.stringify(all))
        setNominations(Object.values(all))
      }
    } catch {}
  }

  const pending  = nominations.filter(n => n.status === 'pending')
  const approved = nominations.filter(n => n.status === 'approved')
  const rejected = nominations.filter(n => n.status === 'rejected')

  const NomCard = ({ nom }) => {
    const ageDays = nom.nominatedAt ? Math.round((Date.now() - nom.nominatedAt) / 86_400_000) : 0
    const statusColor = { approved: 'var(--neon-green)', rejected: 'var(--red)', pending: 'var(--amber)' }[nom.status]
    return (
      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontFamily: 'var(--font-number)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
              ${nom.symbol}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginLeft: 6 }}>
              {nom.name}
            </span>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: statusColor, textTransform: 'uppercase' }}>
            {nom.status}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {[['Mcap', formatNum(nom.mcap)], ['Vol 24h', formatNum(nom.volume24h)],
            ['Nominations', nom.nominationCount], ['Submitted', `${ageDays}d ago`]
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)' }}>{k}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-primary)' }}>{v}</div>
            </div>
          ))}
        </div>
        {nom.note && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            "{nom.note}"
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {nom.dexUrl && (
            <a href={nom.dexUrl} target="_blank" rel="noreferrer"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--cyan)', textDecoration: 'none' }}>
              DEX ↗
            </a>
          )}
          {nom.status === 'pending' && (
            <>
              <button onClick={() => updateStatus(nom.address, 'approved')} style={{
                background: 'rgba(0,255,136,0.1)', border: '1px solid rgba(0,255,136,0.3)',
                borderRadius: 4, padding: '2px 10px', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--neon-green)',
              }}>✓ Approve</button>
              <button onClick={() => updateStatus(nom.address, 'rejected')} style={{
                background: 'rgba(255,68,102,0.1)', border: '1px solid rgba(255,68,102,0.3)',
                borderRadius: 4, padding: '2px 10px', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--red)',
              }}>✕ Reject</button>
            </>
          )}
          {nom.status !== 'pending' && (
            <button onClick={() => updateStatus(nom.address, 'pending')} style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)',
            }}>↩ Reopen</button>
          )}
        </div>
      </div>
    )
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 2000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface-1)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 20, width: 500, maxHeight: '80vh',
        overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-number)', fontSize: 14, color: 'var(--amber)', fontWeight: 600, letterSpacing: '-0.3px' }}>
              ⭐ OG NOMINATION REVIEW
            </div>
            {authed && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                {pending.length} pending · {approved.length} approved · {rejected.length} rejected
              </div>
            )}
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4, padding: '2px 8px',
            color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
            fontFamily: 'var(--font-mono)',
          }}>✕</button>
        </div>

        {/* Password gate */}
        {!authed ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
              Admin access required
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                value={pwInput}
                onChange={e => setPwInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAuth()}
                placeholder="Password"
                autoFocus
                style={{
                  flex: 1, background: 'var(--surface-2)',
                  border: `1px solid ${pwError ? 'var(--red)' : 'var(--border)'}`,
                  borderRadius: 4, padding: '5px 10px', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)', fontSize: 10, outline: 'none',
                  transition: 'border-color 0.2s',
                }}
              />
              <button onClick={handleAuth} style={{
                background: 'rgba(255,184,0,0.1)', border: '1px solid rgba(255,184,0,0.3)',
                borderRadius: 4, padding: '5px 12px', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--amber)',
              }}>Enter</button>
            </div>
            {pwError && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)' }}>
                Incorrect password
              </div>
            )}
          </div>
        ) : nominations.length === 0 ? (
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0',
          }}>
            No nominations yet. They'll appear here when users nominate tokens.
          </div>
        ) : (
          [...pending, ...approved, ...rejected].map(nom => (
            <NomCard key={nom.address} nom={nom} />
          ))
        )}
      </div>
    </div>,
    document.body
  )
}

const AlphaBoard = ({ selectedAlpha, onSelect, onNewRunners, onLiveAlphas, onSznCards, onCoolingAlphas, onCustomSearch, customAlphaLoading, onRegisterClearSearch, alphaListRef }) => {
  const [activeTab,        setActiveTab]        = useState('live')
  const [searchQuery,      setSearchQuery]      = useState('')
  useEffect(() => {
    if (onRegisterClearSearch) onRegisterClearSearch(() => setSearchQuery(''))
  }, [])
  const [showAdminPanel,   setShowAdminPanel]   = useState(false)
  const [coolingTimeframe, setCoolingTimeframe] = useState('24h')
  const [volumeRising,     setVolumeRising]     = useState(false)
  const [watchlist,        setWatchlist]        = useState(() => getWatchlistRaw())

  // ── Watchlist price refresh ───────────────────────────────────
  // Prices are stale the moment a token is added. Refresh every 90s
  // by hitting DEX directly — batched in groups of 30 (DEX limit).
  useEffect(() => {
    const refreshWatchlistPrices = async () => {
      const current = getWatchlistRaw()
      if (current.length === 0) return
      try {
        // Batch into groups of 30
        for (let i = 0; i < current.length; i += 30) {
          const batch = current.slice(i, i + 30)
          const addrs = batch.map(a => a.address).filter(Boolean).join(',')
          if (!addrs) continue
          const res  = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${addrs}`
          )
          const data = await res.json()
          const pairs = (data?.pairs || []).filter(p => p.chainId === 'solana')
          // Build best pair map (highest volume per token address)
          const bestPair = {}
          pairs.forEach(p => {
            const addr = p.baseToken?.address
            if (!addr) return
            if (!bestPair[addr] || (p.volume?.h24 || 0) > (bestPair[addr].volume?.h24 || 0)) {
              bestPair[addr] = p
            }
          })
          // Patch watchlist entries with fresh prices
          batch.forEach(token => {
            const pair = bestPair[token.address]
            if (!pair) return
            const idx = current.findIndex(a => a.address === token.address)
            if (idx === -1) return
            current[idx] = {
              ...current[idx],
              priceUsd:      pair.priceUsd      || current[idx].priceUsd,
              priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
              volume24h:     pair.volume?.h24   || current[idx].volume24h,
              marketCap:     pair.marketCap || pair.fdv || current[idx].marketCap,
              liquidity:     pair.liquidity?.usd || current[idx].liquidity,
            }
          })
        }
        saveWatchlistRaw(current)
        setWatchlist([...current])
      } catch { /* silent — stale prices are better than a crash */ }
    }

    // Run immediately on mount, then every 90 seconds
    refreshWatchlistPrices()
    const interval = setInterval(refreshWatchlistPrices, 90_000)
    return () => clearInterval(interval)
  }, [])

  const { liveAlphas, coolingAlphas, positioningAlphas, legends, loading, isRefreshing, error, lastUpdated, refresh } = useAlphas()
  const sznCards = useNarrativeSzn(liveAlphas)

  // ── Watchlist helpers ──────────────────────────────────────────
  const watchedAddresses = useMemo(() => new Set(watchlist.map(a => a.address)), [watchlist])

  const handleToggleWatch = useCallback((alpha) => {
    setWatchlist(prev => {
      const isWatched = prev.some(a => a.address === alpha.address)
      const next = isWatched
        ? prev.filter(a => a.address !== alpha.address)
        : [{ ...alpha, watchedAt: Date.now() }, ...prev]
      saveWatchlistRaw(next)
      return next
    })
  }, [])

  // ── Cooling timeframe filter ───────────────────────────────────
  const TIMEFRAME_MS = { '24h': 86400000, '3d': 3 * 86400000, '7d': 7 * 86400000 }
  const filteredCooling = useMemo(() => {
    const now = Date.now()
    return coolingAlphas.filter(a => {
      if (a.lastSeen && (now - a.lastSeen) >= TIMEFRAME_MS[coolingTimeframe]) return false
      if (volumeRising && !a.volumeRising) return false
      return true
    })
  }, [coolingAlphas, coolingTimeframe, volumeRising])

  // Restore selected alpha from sessionStorage when alphas first load
  const restoredRef       = useRef(false)
  const prevAddrsRef      = useRef(null)   // addresses from last render — detects new runners
  const userIsScrolling   = useRef(false)  // true while user is actively browsing the list
  const scrollIdleTimer   = useRef(null)   // resets userIsScrolling after idle period
  // Ctrl+Shift+A → open admin nomination review panel
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        e.preventDefault()
        setShowAdminPanel(p => !p)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Scroll intent detection ───────────────────────────────────
  // When user scrolls the runner list, mark them as actively browsing.
  // After 3s of no scrolling, reset — next refresh will snap back
  // to their selected alpha. This prevents interrupting mid-browse
  // while still anchoring the view when they're reading betas.
  useEffect(() => {
    const list = alphaListRef.current
    if (!list) return
    const onScroll = () => {
      userIsScrolling.current = true
      clearTimeout(scrollIdleTimer.current)
      scrollIdleTimer.current = setTimeout(() => {
        userIsScrolling.current = false
      }, 3000)
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      list.removeEventListener('scroll', onScroll)
      clearTimeout(scrollIdleTimer.current)
    }
  }, [])

  useEffect(() => {
    if (restoredRef.current || selectedAlpha || liveAlphas.length === 0) return
    const savedAddress = sessionStorage.getItem('betaplays_selected')
    if (!savedAddress) return
    const allTokens = [...liveAlphas, ...coolingAlphas, ...legends]
    const match = allTokens.find(a => a.address === savedAddress)
    if (match) {
      onSelect(match)
      restoredRef.current = true
      // Scroll the matching card into view after a short paint delay
      setTimeout(() => {
        const el = alphaListRef.current?.querySelector(`[data-address="${savedAddress}"]`)
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 200)
    }
  }, [liveAlphas])

  // ── Post-refresh: keep selected alpha in view ───────────────────
  // After every refresh cycle, if the user has a selected alpha,
  // scroll its card back into view. This is the primary fix for the
  // "selected token disappears after refresh" problem. We don't try
  // to save/restore pixel scroll position — the list reorders and
  // pixel positions become meaningless. The card itself is the anchor.
  useEffect(() => {
    if (isRefreshing || liveAlphas.length === 0) return

    // Detect new runners vs previous render — fire LIVE badge flash
    const prevAddrs = prevAddrsRef.current
    if (prevAddrs && prevAddrs.size > 0) {
      const hasNew = liveAlphas.some(a => !prevAddrs.has(a.address))
      if (hasNew && onNewRunners) onNewRunners()
    }
    prevAddrsRef.current = new Set(liveAlphas.map(a => a.address))

    // Feed liveAlphas up to App so BetaPanel can use for momentum-weighted parent detection
    if (onLiveAlphas) onLiveAlphas(liveAlphas)
    if (onSznCards)      onSznCards(sznCards)
    if (onCoolingAlphas) onCoolingAlphas(coolingAlphas)

    // Only snap back to selected alpha if user is NOT actively scrolling.
    if (selectedAlpha?.address && !userIsScrolling.current) {
      setTimeout(() => {
        const el = alphaListRef.current?.querySelector(
          `[data-address="${selectedAlpha.address}"]`
        )
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, 100)
    }
  }, [liveAlphas, isRefreshing, selectedAlpha])

  // ── Report alphas to backend for Telegram Vector 10 ─────────────
  // Every time liveAlphas updates, tell the backend what alphas are
  // on screen so telegramService knows what to match against during
  // its 15-min poll cycle. Also includes:
  // - coolingAlphas — still relevant, derivatives may still be running
  // - parent alphas from betaplays_parent_map — so when $CLAWCARD is
  //   selected and $CLAW is its parent, $CLAW gets Telegram signal too
  //   even if it's no longer on the live feed.
  // Fire-and-forget — never blocks the UI.
  useEffect(() => {
    if (!liveAlphas.length) return

    const allAlphas = [...liveAlphas, ...coolingAlphas].map(a => ({
      symbol:  a.symbol,
      name:    a.name,
      address: a.address,
    }))

    // Add parent alphas from the parent map (deduped by address)
    try {
      const parentMap  = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
      const seenAddrs  = new Set(allAlphas.map(a => a.address))
      const seenAlphas = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')

      Object.values(parentMap).forEach(parent => {
        if (!parent?.address || seenAddrs.has(parent.address)) return
        // Look up full token data from seen_alphas if available
        const full = seenAlphas[parent.address]
        allAlphas.push({
          symbol:  parent.symbol  || full?.symbol  || '',
          name:    full?.name     || parent.symbol || '',
          address: parent.address,
        })
        seenAddrs.add(parent.address)
      })
    } catch { /* localStorage parse error — non-critical */ }

    fetch(`${BACKEND_URL}/api/report-alphas`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ alphas: allAlphas }),
    }).catch(() => {})  // silent fail — non-critical
  }, [liveAlphas, coolingAlphas])

  const rawList =
    activeTab === 'live'        ? liveAlphas         :
    activeTab === 'narratives'  ? []                 :
    activeTab === 'cooling'     ? filteredCooling     :
    activeTab === 'positioning' ? positioningAlphas   :
    activeTab === 'watch'       ? watchlist           :
    activeTab === 'history'     ? []                 :
    legends

  // Apply search filter across all tabs — guard against malformed entries
  const displayList = useMemo(() => {
    const valid = rawList.filter(a => a && a.symbol && a.address)
    return searchQuery ? valid.filter(a => matchesSearch(a, searchQuery)) : valid
  }, [rawList, searchQuery])

  // Also filter szn cards
  // Deduplicate tokens across szn cards — a token should only appear
  // in the highest-scoring szn card it belongs to, not multiple.
  const dedupedSznCards = useMemo(() => {
    const seen = new Set()
    return sznCards.map(szn => ({
      ...szn,
      tokens: szn.tokens.filter(t => {
        if (!t.address || seen.has(t.address)) return false
        seen.add(t.address)
        return true
      })
    })).filter(szn => szn.tokens.length >= 2)
  }, [sznCards])

  const filteredSzn = useMemo(() =>
    searchQuery
      ? dedupedSznCards.filter(s =>
          s.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.tokens.some(t => matchesSearch(t, searchQuery))
        )
      : dedupedSznCards,
    [dedupedSznCards, searchQuery]
  )

  const isEmpty = !loading && displayList.length === 0

  // ── History tab — runners seen in last 7 days from localStorage ──
  const historyAlphas = useMemo(() => {
    try {
      const seen = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      const liveSet = new Set(liveAlphas.map(a => a.address))
      return Object.values(seen)
        .filter(a => a && typeof a === 'object' && a.symbol && a.address &&
          !liveSet.has(a.address) &&
          ((a.lastSeen && a.lastSeen > cutoff) || (a.timestamp && a.timestamp > cutoff)))
        .sort((a, b) => (b.lastSeen || b.timestamp || 0) - (a.lastSeen || a.timestamp || 0))
        .slice(0, 50)
    } catch { return [] }
  }, [liveAlphas])

  const tabs = [
    { key: 'live',        label: '🔥 Live',       count: liveAlphas.length        },
    { key: 'narratives',  label: '🌊 ACTIVE NARRATIVES', count: sznCards.length },
    { key: 'cooling',     label: '❄️ Cooling',    count: null                     },
    { key: 'positioning', label: '🎯 Position',   count: null                     },
    { key: 'watch',       label: '⭐ Watchlist',   count: watchlist.length         },
    { key: 'history',     label: '🕓 History',    count: historyAlphas.length     },
    { key: 'legends',     label: '🏆 OGs',        count: legends.length },
  ]

  return (
    <aside className="alpha-board">
      {showAdminPanel && <AdminNominationPanel onClose={() => setShowAdminPanel(false)} />}
      <div className="alpha-board-header">
        <span className="alpha-board-title">🎯 Runners</span>
      </div>

      {/* Search box */}
      <div style={{ flexShrink: 0, marginBottom: 6 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: '5px 10px',
          transition: 'border-color 0.15s',
        }}>
          <span style={{ fontSize: 11, color: customAlphaLoading ? 'var(--cyan)' : 'var(--text-muted)' }}>
            {customAlphaLoading ? '⟳' : '🔍'}
          </span>
          <input
            type="text"
            placeholder="Search runners or any token..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              // Clear custom alpha when user starts typing again
              // so the pinned card doesn't linger
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery.trim()) {
                // Only trigger DEX if no local results exist
                if (displayList.length === 0 && !customAlphaLoading && onCustomSearch) {
                  onCustomSearch(searchQuery.trim())
                  // Don't clear searchQuery yet — keep showing what was searched
                }
              }
              if (e.key === 'Escape') setSearchQuery('')
            }}
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
              color: 'var(--text-primary)', width: '100%', letterSpacing: '0.02em',
            }}
          />
          {customAlphaLoading && (
            <span style={{ fontSize: 9, color: 'var(--cyan)', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
              Searching DEX...
            </span>
          )}
          {searchQuery && !customAlphaLoading && (
            <button
              onClick={() => { setSearchQuery(''); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 12, padding: 0, lineHeight: 1,
              }}
            >✕</button>
          )}
        </div>
      </div>

      {/* Tabs — scrollable single row */}
      <div style={{
        display: 'flex', gap: 2,
        background: 'var(--surface-2)', padding: 3,
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
        flexShrink: 0, overflowX: 'auto',
      }}>
        {tabs.map(({ key, label, count, noUppercase }) => (
          <button
            key={key}
            className={`tab-btn ${activeTab === key ? 'active' : ''} ${noUppercase ? 'mixed-case' : ''}`}
            onClick={() => { setActiveTab(key); setSearchQuery('') }}
            style={{ flex: '0 0 auto', textAlign: 'center' }}
          >
            {label}
            {count > 0 && (
              <span style={{
                marginLeft: 3, fontSize: 8,
                color: activeTab === key ? 'var(--neon-green)' : 'var(--text-muted)',
                fontWeight: 700,
              }}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Cooling timeframe sub-tabs */}
      {activeTab === 'cooling' && !searchQuery && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
          <div style={{
            display: 'flex', gap: 2, flex: 1,
            background: 'var(--surface-2)', padding: 3,
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
          }}>
            {[['24h', '24h'], ['3d', '3 days'], ['7d', '7 days']].map(([key, label]) => (
              <button
                key={key}
                className={`tab-btn ${coolingTimeframe === key ? 'active' : ''}`}
                onClick={() => setCoolingTimeframe(key)}
                style={{ flex: 1, textAlign: 'center' }}
              >
                {label}
                <span style={{
                  marginLeft: 3, fontSize: 7,
                  color: coolingTimeframe === key ? 'var(--cyan)' : 'var(--text-muted)',
                }}>
                  {coolingAlphas.filter(a =>
                    !a.lastSeen || (Date.now() - a.lastSeen) < TIMEFRAME_MS[key]
                  ).length}
                </span>
              </button>
            ))}
          </div>
          {/* Volume Rising toggle */}
          <button
            onClick={() => setVolumeRising(prev => !prev)}
            style={{
              flexShrink: 0,
              padding: '3px 8px',
              fontSize: 9,
              fontFamily: 'var(--font-number)',
              background: volumeRising ? 'rgba(0,255,150,0.15)' : 'var(--surface-2)',
              border: `1px solid ${volumeRising ? 'rgba(0,255,150,0.5)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)',
              color: volumeRising ? 'rgb(0,255,150)' : 'var(--text-muted)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            📈 Vol Rising
          </button>
        </div>
      )}

      {/* Tab descriptions */}
      {!searchQuery && (
        <div style={{ flexShrink: 0, paddingBottom: 4 }}>
          {activeTab === 'live' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Tokens with positive price action right now.
            </p>
          )}
          {activeTab === 'cooling' && (
            <p style={{ fontFamily: 'var(--font-number)', fontSize: 9, color: 'var(--cyan)', lineHeight: 1.5 }}>
              {volumeRising
                ? `📈 ${filteredCooling.length} tokens with rising volume despite negative price — accumulation signal. Gold in the rough.`
                : `Tokens retracing or consolidating — ${filteredCooling.length} in the last ${coolingTimeframe}. Sorted by recency. Gold in the rough.`
              }
            </p>
          )}
          {activeTab === 'positioning' && (
            <p style={{ fontFamily: 'var(--font-number)', fontSize: 9, color: 'var(--amber)', lineHeight: 1.5 }}>
              Big peak. Big drawdown. Volume still alive. These are the second-leg setups degens hunt.
              {positioningAlphas.length === 0 && ' Populates as tokens peak and retrace — check back after the next wave.'}
            </p>
          )}
          {activeTab === 'history' && (
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)',
              padding: '3px 4px', letterSpacing: 0.5,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>🕓 {historyAlphas.length} runners · last 7 days · device only</span>
              <span style={{ opacity: 0.6 }}>prices may be stale</span>
            </div>
          )}
          {activeTab === 'watch' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)', lineHeight: 1.5 }}>
              Your starred tokens. ☆ star any runner, cooling token, or positioning play to save it here.
            </p>
          )}
          {activeTab === 'legends' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)', lineHeight: 1.5, margin: 0 }}>
                Established narrative anchors. Still spawn betas when they move.
              </p>
              <NominateSearchBar />
            </div>
          )}
        </div>
      )}

      {/* Search result count */}
      {searchQuery && (
        <div style={{ flexShrink: 0, paddingBottom: 4 }}>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {displayList.length} result{displayList.length !== 1 ? 's' : ''} for "{searchQuery}"
          </p>
        </div>
      )}

      {lastUpdated && activeTab === 'live' && !searchQuery && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span className="mono text-muted" style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 5 }}>
            {isRefreshing
              ? <span style={{ color: 'var(--cyan)', animation: 'pulse 1.2s ease-in-out infinite' }}>↻ Updating...</span>
              : `Updated ${lastUpdated.toLocaleTimeString()}`
            }
          </span>
          <button className="btn btn-ghost btn-sm" onClick={refresh} style={{ padding: '2px 8px', fontSize: 9 }}>
            ↺ Refresh
          </button>
        </div>
      )}

      {error && activeTab === 'live' && (
        <div style={{
          background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.3)',
          borderRadius: 6, padding: '8px 12px', fontSize: 11,
          color: 'var(--red)', fontFamily: 'var(--font-mono)', flexShrink: 0,
        }}>{error}</div>
      )}

      <div className="alpha-list" ref={alphaListRef}>
        {/* Custom search result — pinned at top, shows as real AlphaCard */}
        {selectedAlpha?.isCustomSearch && !displayList.some(a => a.address === selectedAlpha.address) && (
          <div style={{ flexShrink: 0 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)',
              letterSpacing: 1, padding: '3px 4px', opacity: 0.8,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>🔍 FROM DEX SEARCH</span>
              <span
                onClick={() => onSelect(null)}
                style={{ cursor: 'pointer', opacity: 0.6 }}
              >✕ clear</span>
            </div>
            <AlphaCard
              alpha={selectedAlpha}
              isSelected={true}
              onClick={() => onSelect(selectedAlpha)}
              isWatched={watchedAddresses.has(selectedAlpha.address)}
              onToggleWatch={handleToggleWatch}
            />
          </div>
        )}

        {loading && activeTab === 'live' && !searchQuery && (
          <>
            <div className="skeleton loading-row" />
            <div className="skeleton loading-row" />
            <div className="skeleton loading-row" />
          </>
        )}

        {/* Empty states */}
        {!loading && isEmpty && !searchQuery && activeTab === 'live' && (
          <div className="empty-state">
            <div className="empty-state-icon">📡</div>
            <div className="empty-state-title">No runners right now.</div>
            <div className="empty-state-sub">Trenches might be cooked.</div>
            <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('cooling')} style={{ marginTop: 12 }}>
              Check Cooling Runners
            </button>
          </div>
        )}

        {!loading && isEmpty && !searchQuery && activeTab === 'cooling' && (
          <div className="empty-state">
            <div className="empty-state-icon">❄️</div>
            <div className="empty-state-title">Nothing cooling in the last {coolingTimeframe}.</div>
            <div className="empty-state-sub">
              {coolingTimeframe !== '7d'
                ? `Try the 7d window — tokens that ran last week may still be setting up.`
                : 'Everything is either pumping or dead. Check back after the market moves.'
              }
            </div>
            {coolingTimeframe !== '7d' && (
              <button className="btn btn-ghost btn-sm" onClick={() => setCoolingTimeframe('7d')} style={{ marginTop: 12 }}>
                Expand to 7 days
              </button>
            )}
          </div>
        )}

        {!loading && isEmpty && !searchQuery && activeTab === 'watch' && (
          <div className="empty-state">
            <div className="empty-state-icon">⭐</div>
            <div className="empty-state-title">No tokens starred yet.</div>
            <div className="empty-state-sub">Tap ☆ on any runner, cooling token, or positioning play to add it here.</div>
          </div>
        )}
        {!loading && historyAlphas.length === 0 && !searchQuery && activeTab === 'history' && (
          <div className="empty-state">
            <div className="empty-state-icon">🕓</div>
            <div className="empty-state-title">No history yet.</div>
            <div className="empty-state-sub">Runners from the last 7 days appear here once they leave the live feed.</div>
          </div>
        )}

        {!loading && isEmpty && searchQuery && activeTab !== 'history' && (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <div className="empty-state-title">"{searchQuery}" not in feed</div>
            <div className="empty-state-sub">
              {customAlphaLoading
                ? '⟳ Searching DEX for this token...'
                : <>Press <strong>Enter</strong> to search all Solana tokens on DEX.</>}
            </div>
            {!customAlphaLoading && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onCustomSearch?.(searchQuery)}
                style={{ marginTop: 10 }}
              >
                Search DEX ↗
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setSearchQuery('')} style={{ marginTop: 6, opacity: 0.6 }}>
              Clear
            </button>
          </div>
        )}

        {/* Szn cards — Narratives tab */}
        {activeTab === 'narratives' && (
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filteredSzn.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🌊</div>
                <div className="empty-state-title">No active narratives yet.</div>
                <div className="empty-state-sub">Narratives form when 2+ runners share a theme. Refresh the feed.</div>
              </div>
            ) : filteredSzn.map((szn) => (
              <SznCard
                key={szn.id}
                szn={szn}
                isSelected={selectedAlpha?.id === szn.id}
                onClick={() => onSelect(szn)}
              />
            ))}
          </div>
        )}

        {!loading && displayList.map((alpha) => {
          if (!alpha?.address || !alpha?.symbol) return null
          const watched = watchedAddresses.has(alpha.address)
          if (activeTab === 'positioning' || alpha.isPositioning) {
            return (
              <div key={alpha.id || alpha.address} data-address={alpha.address}>
                <PositioningCard
                  alpha={alpha}
                  isSelected={selectedAlpha?.id === alpha.id}
                  onClick={() => onSelect(alpha)}
                  isWatched={watched}
                  onToggleWatch={handleToggleWatch}
                />
              </div>
            )
          }
          return (
            <div key={alpha.id || alpha.address} data-address={alpha.address}>
              <AlphaCard
                alpha={alpha}
                isSelected={selectedAlpha?.id === alpha.id}
                onClick={() => onSelect(alpha)}
                isWatched={watched}
                onToggleWatch={handleToggleWatch}
              />
            </div>
          )
        })}

        {/* History tab — renders inside alpha-list so it scrolls correctly */}
        {activeTab === 'history' && historyAlphas.map(a => {
          const enriched = {
            id:             a.address,
            address:        a.address,
            symbol:         a.symbol         || '?',
            name:           a.name           || a.symbol || '?',
            logoUrl:        a.logoUrl         || null,
            dexUrl:         a.dexUrl          || `https://dexscreener.com/solana/${a.address}`,
            priceUsd:       a.priceUsd        || 0,
            priceChange24h: a.priceChange24h  || 0,
            volume24h:      a.volume24h        || 0,
            marketCap:      a.marketCap        || a.mcap || 0,
            liquidity:      a.liquidity        || 0,
            ageDays:        a.ageDays          || '?',
            source:         a.source           || 'history',
            isHistorical:   true,
            ...a,
          }
          const watched = watchedAddresses.has(enriched.address)
          return (
            <div key={enriched.address} data-address={enriched.address}>
              <AlphaCard
                alpha={enriched}
                isSelected={selectedAlpha?.address === enriched.address}
                onClick={() => onSelect(enriched)}
                isWatched={watched}
                onToggleWatch={handleToggleWatch}
              />
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// ─── Signal Badge ────────────────────────────────────────────────

// ─── Relationship type badge config ──────────────────────────────
const RELATIONSHIP_CONFIG = {
  TWIN:      { emoji: '🪞', label: 'TWIN',      color: 'var(--cyan)',       bg: 'rgba(0,212,255,0.12)',   border: 'rgba(0,212,255,0.35)'  },
  COUNTER:   { emoji: '⚡', label: 'COUNTER',   color: 'var(--amber)',      bg: 'rgba(255,184,0,0.12)',   border: 'rgba(255,184,0,0.35)'  },
  ECHO:      { emoji: '🌊', label: 'ECHO',      color: '#b48eff',           bg: 'rgba(180,142,255,0.12)', border: 'rgba(180,142,255,0.35)' },
  UNIVERSE:  { emoji: '🌌', label: 'UNIVERSE',  color: '#5cf0b0',           bg: 'rgba(92,240,176,0.10)',  border: 'rgba(92,240,176,0.3)'  },
  SECTOR:    { emoji: '🏭', label: 'SECTOR',    color: 'var(--neon-green)', bg: 'rgba(0,255,136,0.08)',   border: 'rgba(0,255,136,0.3)'   },
  EVIL_TWIN: { emoji: '😈', label: 'EVIL TWIN', color: 'var(--red)',        bg: 'rgba(255,68,102,0.12)',  border: 'rgba(255,68,102,0.35)' },
  SPIN:      { emoji: '🌀', label: 'SPIN',      color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)' },
}

// ─── Badge chip with click-to-reveal tooltip ─────────────────────
const BadgeChip = ({ emoji, label, className, style: extraStyle = {} }) => {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  const show = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect()
      setPos({ left: r.left + r.width / 2, top: r.top - 6 })
    }
  }
  const hide = () => setPos(null)

  return (
    <span ref={ref} style={{ display: 'inline-block' }} onMouseEnter={show} onMouseLeave={hide}>
      <span
        className={`badge ${className}`}
        onClick={e => e.stopPropagation()}
        style={{ fontSize: 10, padding: '2px 7px', cursor: 'default', userSelect: 'none', lineHeight: 1.4, display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.03em', ...extraStyle }}
      >
        {emoji}
      </span>
      {pos && createPortal(
        <span style={{ ...TOOLTIP_STYLE, left: pos.left, top: pos.top }}>{label}</span>,
        document.body
      )}
    </span>
  )
}

const SignalBadge = ({ beta }) => {
  const signal = getSignal(beta)
  const relType = beta.relationshipType && RELATIONSHIP_CONFIG[beta.relationshipType]
    ? RELATIONSHIP_CONFIG[beta.relationshipType]
    : null

  const classMap = {
    CABAL:    'badge-multi',
    MULTI:    'badge-multi',
    TRENDING: 'badge-strong',
    KEYWORD:  'badge-strong',
    VISUAL:   'badge-visual',
    LORE:     'badge-weak',
    WEAK:     'badge-weak',
    LP_PAIR:  'badge-cabal',
    AI:       'badge-verified',
    TELEGRAM: 'badge-telegram',
    TWITTER:  'badge-twitter',
  }

  // Emoji-only in badge, full description in tooltip
  const signalEmoji = {
    CABAL:    '⚡', MULTI:    '⚡', TRENDING: '🔥', LP_PAIR:  '🔗',
    AI:       '🤖', KEYWORD:  '🔍', VISUAL:   '👁', TELEGRAM: '📡',
    TWITTER:  '🐦', STRONG:   '💪', OG:       '👑', WEAK:     '〰️',
  }
  const signalLabel = {
    CABAL:    'Multi-Signal — found by 2 or more detection methods simultaneously. Highest confidence.',
    MULTI:    'Multi-Signal — found by 2 or more detection methods simultaneously. Highest confidence.',
    TRENDING: 'Trending — currently gaining traction on PumpFun or DEX.',
    LP_PAIR:  'LP Pair — directly paired with the alpha in a liquidity pool. Hard on-chain link.',
    AI:       'AI Match — our AI confirmed a thematic or conceptual relationship to the alpha.',
    KEYWORD:  'Keyword Match — shares key terms, themes, or ticker patterns with the alpha.',
    VISUAL:   "Visual Match — logo visually mirrors or references the alpha's logo.",
    TELEGRAM: 'Telegram Signal — spotted in degen channels being discussed alongside the alpha.',
    TWITTER:  'Twitter Signal — mentioned on CT in context with the alpha.',
    STRONG:   'Strong — high-confidence match from multiple text-based signals.',
    OG:       'OG — this is the original token of its concept. The narrative starter.',
    WEAK:     'Weak — low-confidence match. Worth watching but treat with caution.',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      {beta.tokenClass && (
        <BadgeChip
          emoji={
            beta.tokenClass === 'OG'    ? '👑' :
            beta.tokenClass === 'RIVAL' ? '⚔️' : '🌀'
          }
          label={
            beta.tokenClass === 'OG'    ? 'OG — this token started the narrative. The original of its concept.' :
            beta.tokenClass === 'RIVAL' ? 'Rival — directly competing with the alpha for the same throne. Highly correlated.' :
                                          'Spin — riding the same narrative wave as the alpha. Looser connection than a Rival.'
          }
          className={beta.tokenClass === 'OG' ? 'badge-verified' : beta.tokenClass === 'RIVAL' ? 'badge-cabal' : 'badge-weak'}
        />
      )}
      {relType && (
        <BadgeChip
          emoji={relType.emoji}
          label={{
            TWIN:      'Twin — near-identical concept to the alpha. Moves in lockstep.',
            COUNTER:   'Counter — opposite or contrarian play to the alpha. May move inversely.',
            ECHO:      'Echo — delayed version of the alpha narrative. Usually follows with a lag.',
            UNIVERSE:  'Universe — exists in the same broader narrative world as the alpha.',
            SECTOR:    'Sector — same market category or niche as the alpha.',
            EVIL_TWIN: "Evil Twin — dark or villainous counterpart to the alpha's concept.",
            SPIN:      "Spin — a derivative take on the alpha's narrative. Looser connection.",
          }[beta.relationshipType] || relType.label}
          className=""
          style={{ background: relType.bg, color: relType.color, border: `1px solid ${relType.border}` }}
        />
      )}
      {/* MULTI badge intentionally removed — appears on almost all betas, adds noise */}
      {signal.label !== 'MULTI' && signal.label !== 'CABAL' && (
        <BadgeChip
          emoji={signalEmoji[signal.label] || signal.label}
          label={signalLabel[signal.label] || signal.label}
          className={classMap[signal.label] || 'badge-weak'}
        />
      )}
    </div>
  )
}

// ─── Wave Badge ──────────────────────────────────────────────────

const WaveBadge = ({ phase }) => {
  if (!phase || phase.label === 'UNKNOWN') return null
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
      color: phase.color, letterSpacing: 0.5, whiteSpace: 'nowrap',
    }}>
      {phase.label}
    </span>
  )
}

// ─── MCAP Ratio Badge ────────────────────────────────────────────

const McapRatioBadge = ({ ratio }) => {
  if (!ratio || ratio < 2) return null
  const color = ratio >= 100 ? 'var(--neon-green)' : ratio >= 20 ? 'var(--amber)' : 'var(--text-secondary)'
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 400, color, opacity: 0.65 }}>
      {ratio >= 1000 ? `${(ratio / 1000).toFixed(1)}Kx` : `${ratio}x`} room
    </span>
  )
}

// ─── Nominate for Legend button ──────────────────────────────────
const NominateButton = ({ address, symbol, name, compact = false }) => {
  const [submitted, setSubmitted]   = useState(false)
  const [count, setCount]           = useState(() => getNominations()[address]?.nominationCount || 0)
  const [showForm, setShowForm]     = useState(false)
  const [note, setNote]             = useState('')

  const handleSubmit = () => {
    const result = submitNomination(address, symbol, name, note)
    setCount(result.nominationCount)
    setSubmitted(true)
    setShowForm(false)
    setNote('')
  }

  if (compact) {
    // Compact — one click submits immediately, no note required
    return submitted ? (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)', padding: '3px 0' }}>
        ⭐ Nominated! Under review.
      </div>
    ) : (
      <button
        onClick={(e) => {
          e.stopPropagation()
          const result = submitNomination(address, symbol, name, '')
          if (result) { setCount(result.nominationCount); setSubmitted(true) }
        }}
        style={{
          background: 'rgba(255,179,0,0.08)', border: '1px solid rgba(255,179,0,0.3)',
          borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
          fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)',
          width: '100%', textAlign: 'left',
        }}
      >
        ⭐ Nominate for OG {count > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 8 }}>({count})</span>}
      </button>
    )
  }

  // Full version — used in OGs tab nomination flow
  return (
    <div>
      {submitted ? (
        <div style={{
          background: 'rgba(255,179,0,0.08)', border: '1px solid rgba(255,179,0,0.3)',
          borderRadius: 6, padding: '10px 14px',
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--amber)',
        }}>
          ⭐ Nominated! {count > 1 && `${count} nominations so far`}<br/>
          <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>
            Under review. You'll see it here if approved.
          </span>
        </div>
      ) : showForm ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Why should this be an OG? (optional)"
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '6px 10px', color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)', fontSize: 10, resize: 'none', height: 60,
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSubmit} style={{
              background: 'rgba(255,179,0,0.15)', border: '1px solid rgba(255,179,0,0.4)',
              borderRadius: 4, padding: '4px 12px', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--amber)',
            }}>Submit Nomination</button>
            <button onClick={() => setShowForm(false)} style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)',
            }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} style={{
          background: 'rgba(255,179,0,0.08)', border: '1px solid rgba(255,179,0,0.3)',
          borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--amber)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          ⭐ Nominate as OG {count > 0 && <span style={{ color: 'var(--text-muted)' }}>({count})</span>}
        </button>
      )}
    </div>
  )
}

// ─── NominateSearchBar ───────────────────────────────────────────
// Lives in OGs tab — search any token by symbol/address and nominate it
const NominateSearchBar = () => {
  const [query,   setQuery]   = useState('')
  const [result,  setResult]  = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const handleSearch = async () => {
    if (!query.trim()) return
    setLoading(true); setResult(null); setError(null)
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query.trim())}`
      )
      const data = await res.json()
      const pairs = (data.pairs || []).filter(p => p.chainId === 'solana')
      if (!pairs.length) { setError('No Solana token found. Try the token address.'); setLoading(false); return }
      const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
      const resultAddr = best.baseToken?.address
      const resultSym  = best.baseToken?.symbol?.toUpperCase()
      // Check if already a confirmed OG
      const alreadyOG  = LEGENDS.some(l =>
        l.address === resultAddr || l.symbol === resultSym
      )
      setResult({
        address:   resultAddr,
        symbol:    best.baseToken?.symbol,
        name:      best.baseToken?.name,
        marketCap: best.marketCap || 0,
        volume24h: best.volume?.h24 || 0,
        liquidity: best.liquidity?.usd || 0,
        logoUrl:   best.info?.imageUrl || null,
        dexUrl:    best.url || `https://dexscreener.com/solana/${resultAddr}`,
        pairCreatedAt: best.pairCreatedAt ? new Date(best.pairCreatedAt).toISOString().split('T')[0] : null,
        isAlreadyOG: alreadyOG,
      })
    } catch { setError('Search failed. Try again.') }
    setLoading(false)
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: 1 }}>
        ⭐ NOMINATE A TOKEN FOR OG STATUS
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Symbol or token address..."
          style={{
            flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 5, padding: '5px 10px', color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)', fontSize: 10, outline: 'none',
          }}
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          style={{
            background: 'rgba(255,184,0,0.1)', border: '1px solid rgba(255,184,0,0.3)',
            borderRadius: 5, padding: '5px 12px', cursor: 'pointer',
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--amber)',
            opacity: loading ? 0.5 : 1,
          }}
        >{loading ? '...' : 'Search'}</button>
      </div>

      {error && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red)', marginTop: 6 }}>{error}</div>
      )}

      {result && (
        <div style={{
          marginTop: 8, background: 'var(--surface-2)',
          border: `1px solid ${result.isAlreadyOG ? 'rgba(255,184,0,0.3)' : 'var(--border)'}`,
          borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {result.logoUrl && (
              <img src={result.logoUrl} alt={result.symbol}
                style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
            )}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: 'var(--font-number)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
                  ${result.symbol}
                </span>
                {result.isAlreadyOG && (
                  <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 5px' }}>🏆 OG</span>
                )}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{result.name}</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--font-number)', fontSize: 8, color: 'var(--text-muted)' }}>MCAP</div>
                <div style={{ fontFamily: 'var(--font-number)', fontSize: 10, color: 'var(--text-primary)' }}>{formatNum(result.marketCap)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--font-number)', fontSize: 8, color: 'var(--text-muted)' }}>LIQ</div>
                <div style={{ fontFamily: 'var(--font-number)', fontSize: 10, color: 'var(--text-primary)' }}>{formatNum(result.liquidity)}</div>
              </div>
            </div>
          </div>
          {result.isAlreadyOG ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)' }}>
              ✓ Already an OG — this token is on the confirmed legends list.
            </div>
          ) : (
            <NominateButton
              address={result.address}
              symbol={result.symbol}
              name={result.name}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Beta Row ────────────────────────────────────────────────────

const BetaRow = ({ beta, alpha, isPinned, trenchOnly, onOpenDrawer }) => {
  const change     = parseFloat(beta.priceChange24h) || 0
  const isPositive = change >= 0
  const wave       = getWavePhase(alpha, beta)
  const isTrench   = (beta.marketCap || 0) < 30_000
  const isLPPair      = beta.signalSources?.includes('lp_pair')
  const isTelegramSig = beta.signalSources?.includes('telegram_signal')
  const isTwitterSig  = beta.signalSources?.includes('twitter_signal')
  const isTied        = beta.signalSources?.includes('telegram_tied')

  if (trenchOnly && !isTrench) return null

  return (
    <div
      className={`beta-row ${isPinned ? 'pinned' : ''}`}
      onClick={() => onOpenDrawer ? onOpenDrawer(beta) : (beta.dexUrl && window.open(beta.dexUrl, '_blank'))}
      style={isLPPair ? { borderColor: 'var(--cyan)', background: 'rgba(0,212,255,0.04)' } : {}}
    >
      <div className="token-info">
        <div className="token-icon" style={{ width: 28, height: 28, fontSize: 9 }}>
          {beta.logoUrl ? <img src={beta.logoUrl} alt={beta.symbol} /> : beta.symbol.slice(0, 3)}
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
              ${beta.symbol}
            </span>
            {isLPPair       && <span className="badge badge-cabal"    style={{ fontSize: 7, padding: '1px 4px' }}>🔗 PAIRED</span>}
            {isTelegramSig  && <span className="badge" style={{ fontSize: 7, padding: '1px 4px', background: 'rgba(0,212,180,0.15)', borderColor: 'rgba(0,212,180,0.4)', color: 'rgb(0,212,180)', animation: 'pulse 2s infinite' }}>📡 TELEGRAM</span>}
            {isTwitterSig   && <span className="badge" style={{ fontSize: 7, padding: '1px 4px', background: 'rgba(29,161,242,0.15)', borderColor: 'rgba(29,161,242,0.4)', color: 'rgb(29,161,242)', animation: 'pulse 2s infinite' }}>🐦 TWITTER</span>}
            {isTied         && <span className="badge badge-strong"   style={{ fontSize: 7, padding: '1px 4px' }}>⚡ TIED</span>}
            {isTrench       && <Tooltip text="Trenches — market cap under $30K. Very high risk, very high reward."><span className="badge badge-new" style={{ fontSize: 9, padding: '1px 5px', cursor: 'default' }}>⛏️</span></Tooltip>}
            <FlagWarningBadge address={beta.address} />
            {isPinned       && <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 4px' }}>DEV VERIFIED</span>}
            {beta.isSibling && <span className="badge badge-cabal"    style={{ fontSize: 7, padding: '1px 4px', opacity: 0.85 }}>👥 SIBLING</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
            <CopyAddress address={beta.address} />
            {beta.isHistorical && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '0 3px' }}>📦 stored</span>}
            <WaveBadge phase={wave} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{formatNum(beta.marketCap)}</span>
        <McapRatioBadge ratio={beta.mcapRatio} />
      </div>

      <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatNum(beta.volume24h)}</span>

      {/* Liquidity — coloured by risk level */}
      <span className="mono" style={{
        fontSize: 12,
        color: (beta.liquidity || 0) >= 50_000 ? 'var(--neon-green)'
             : (beta.liquidity || 0) >= 10_000 ? 'var(--amber)'
             : 'var(--red)',
      }}>{formatNum(beta.liquidity)}</span>

      <span className={`token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 12 }}>
        {isPositive ? '+' : ''}{change.toFixed(1)}%
      </span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{beta.ageLabel}</span>
      <SignalBadge beta={beta} />
    </div>
  )
}

// ─── Parent Alpha Card ───────────────────────────────────────────

const ParentAlphaCard = ({ parent }) => {
  const change     = parseFloat(parent.priceChange24h) || 0
  const isPositive = change >= 0
  const isCooling  = isParentCooling(parent.address)

  return (
    <div
      onClick={() => parent.dexUrl && window.open(parent.dexUrl, '_blank')}
      style={{
        background: 'rgba(0,212,255,0.04)', border: '1px solid rgba(0,212,255,0.3)',
        borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
        marginBottom: 8, transition: 'all 0.15s ease', flexShrink: 0,
      }}
    >
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
        color: 'var(--cyan)', letterSpacing: 1.5, textTransform: 'uppercase',
        marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
        🧬 Parent Alpha — Root of this narrative
        {isCooling && (
          <span className="badge badge-weak" style={{ fontSize: 7, padding: '1px 6px' }}>
            ❄️ COOLING — Second leg may be incoming
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="token-info">
          <div className="token-icon" style={{ width: 40, height: 40, border: '1px solid rgba(0,212,255,0.4)' }}>
            {parent.logoUrl ? <img src={parent.logoUrl} alt={parent.symbol} /> : parent.symbol.slice(0, 3)}
          </div>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16, color: 'var(--text-primary)' }}>
              ${parent.symbol}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
              <CopyAddress address={parent.address} />
              <Tooltip text="Open on DEXScreener">
                <span
                  onClick={e => { e.stopPropagation(); window.open(parent.dexUrl || `https://dexscreener.com/solana/${parent.address}`, '_blank') }}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.08)', transition: 'color 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--cyan)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                >DEX ↗</span>
              </Tooltip>
              <XSearchButton symbol={parent.symbol} onClick={e => e.stopPropagation()} />
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <div className="metric">
            <span className="metric-label">MCAP</span>
            <span className="metric-value">{formatNum(parent.marketCap)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">Vol 24h</span>
            <span className="metric-value">{formatNum(parent.volume24h)}</span>
          </div>
          <div className={`token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 15 }}>
            {isPositive ? '+' : ''}{change.toFixed(1)}%
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
        ⚠️ If parent dumps, this runner likely follows. Watch both.
      </div>
    </div>
  )
}

// ─── Szn Panel ───────────────────────────────────────────────────

const SznPanel = ({ szn, onListBeta, onOpenDrawer }) => {
  const [sortBy,     setSortBy]     = useState('change')
  const [mcapFilter, setMcapFilter] = useState('all')

  const filterMap = {
    all:   () => true,
    large: (t) => (t.marketCap || 0) >= 10_000_000,
    mid:   (t) => (t.marketCap || 0) >= 1_000_000 && (t.marketCap || 0) < 10_000_000,
    micro: (t) => (t.marketCap || 0) < 1_000_000,
  }
  const sortMap = {
    change: (a, b) => (parseFloat(b.priceChange24h) || 0) - (parseFloat(a.priceChange24h) || 0),
    volume: (a, b) => (b.volume24h || 0) - (a.volume24h || 0),
    mcap:   (a, b) => (b.marketCap || 0) - (a.marketCap || 0),
  }
  const displayed = [...szn.tokens].filter(filterMap[mcapFilter]).sort(sortMap[sortBy])

  return (
    <section className="beta-panel">
      <div className="beta-panel-header">
        <div className="beta-panel-title-group">
          <h1 className="beta-panel-title">{szn.label} Szn</h1>
          <p className="beta-panel-subtitle">
            <span style={{ color: 'var(--cyan)' }}>{szn.tokenCount} tokens</span>{' '}running the narrative · avg{' '}
            <span style={{ color: szn.avgChange >= 0 ? 'var(--neon-green)' : 'var(--red)' }}>
              {szn.avgChange >= 0 ? '+' : ''}{szn.avgChange.toFixed(1)}%
            </span>{' '}24h
          </p>
        </div>
        <button className="btn btn-amber btn-sm" onClick={onListBeta}>⚡ List Beta</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
          {[['change','24h %'],['volume','Volume'],['mcap','MCAP']].map(([key, label]) => (
            <button key={key} className={`tab-btn ${sortBy === key ? 'active' : ''}`} onClick={() => setSortBy(key)}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
          {[['all','All'],['large','>$10M'],['mid','$1M-10M'],['micro','<$1M']].map(([key, label]) => (
            <button key={key} className={`tab-btn ${mcapFilter === key ? 'active' : ''}`} onClick={() => setMcapFilter(key)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="beta-table">
        <div className="beta-table-header">
          <span>Token</span><span>MCAP</span><span>24h Vol</span><span>24h %</span><span>Age</span><span>Signal</span>
        </div>
        {displayed.length === 0 && (
          <div className="empty-state" style={{ marginTop: 24 }}>
            <div className="empty-state-icon">🔍</div>
            <div className="empty-state-title">No tokens match this filter.</div>
          </div>
        )}
        {displayed.map((token, i) => {
          const change     = parseFloat(token.priceChange24h) || 0
          const isPositive = change >= 0
          return (
            <div key={token.id || i} className="beta-row"
              onClick={() => onOpenDrawer && onOpenDrawer(token)}
              style={{ cursor: 'pointer' }}
            >
              <div className="token-info">
                <div className="token-icon" style={{ width: 28, height: 28, fontSize: 9 }}>
                  {token.logoUrl ? <img src={token.logoUrl} alt={token.symbol} /> : token.symbol.slice(0, 3)}
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                    ${token.symbol}
                  </div>
                  <div className="token-address">{shortAddress(token.address)}</div>
                </div>
              </div>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{formatNum(token.marketCap)}</span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatNum(token.volume24h)}</span>
              <span className={`token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 12 }}>
                {isPositive ? '+' : ''}{change.toFixed(1)}%
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
              <span className="badge badge-strong" style={{ fontSize: 8, padding: '2px 6px' }}>🌊 SZN</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── Beta Panel ──────────────────────────────────────────────────

const BetaPanel = ({ alpha, liveAlphas, onListBeta, onOpenDrawer, onScrollToAlpha, onCustomSearch, customAlphaLoading, customAlphaError }) => {
  const { parent, loading: parentLoading }               = useParentAlpha(alpha, liveAlphas)
  const { betas, loading: betasLoading, error, scanPhase, refresh } = useBetas(alpha, parent)
  const { birdeye }                                       = useBirdeye(alpha?.address)
  const [trenchOnly,   setTrenchOnly]   = useState(false)
  const [mcapFilter,   setMcapFilter]   = useState('all')
  const [sortBy,       setSortBy]       = useState('change')
  const [sortDir,      setSortDir]      = useState('desc')

  const mcapFilterFn = {
    all:   () => true,
    large: (b) => (b.marketCap || 0) >= 10_000_000,
    mid:   (b) => (b.marketCap || 0) >= 1_000_000  && (b.marketCap || 0) < 10_000_000,
    small: (b) => (b.marketCap || 0) >= 100_000    && (b.marketCap || 0) < 1_000_000,
    micro: (b) => (b.marketCap || 0) < 30_000,
  }

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortBy(col); setSortDir('desc') }
  }

  const filteredBetas = useMemo(() => {
    const filtered = betas.filter(mcapFilterFn[mcapFilter])
    return [...filtered].sort((a, b) => {
      // LP pairs always float to top regardless of sort
      const aLP = a.signalSources?.includes('lp_pair') ? 1 : 0
      const bLP = b.signalSources?.includes('lp_pair') ? 1 : 0
      if (bLP !== aLP) return bLP - aLP
      let aVal, bVal
      if (sortBy === 'mcap')        { aVal = a.marketCap  || 0; bVal = b.marketCap  || 0 }
      else if (sortBy === 'volume') { aVal = a.volume24h  || 0; bVal = b.volume24h  || 0 }
      else if (sortBy === 'liq')    { aVal = a.liquidity  || 0; bVal = b.liquidity  || 0 }
      else if (sortBy === 'age')    { aVal = a.ageMs      || 0; bVal = b.ageMs      || 0 }
      else                          { aVal = parseFloat(a.priceChange24h) || 0; bVal = parseFloat(b.priceChange24h) || 0 }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal
    })
  }, [betas, mcapFilter, sortBy, sortDir])

  const trenchCount   = betas.filter(b => (b.marketCap || 0) < 30_000).length

  const SortIcon = ({ col }) => {
    if (sortBy !== col) return <span style={{ opacity: 0.3, fontSize: 8 }}>↕</span>
    return <span style={{ color: 'var(--cyan)', fontSize: 8 }}>{sortDir === 'desc' ? '↓' : '↑'}</span>
  }

  return (
    <section className="beta-panel">
      <div className="beta-panel-header">
        <div className="beta-panel-title-group">
          <h1
            className="beta-panel-title"
            onClick={alpha && onScrollToAlpha ? onScrollToAlpha : undefined}
            style={alpha && onScrollToAlpha ? { cursor: 'pointer', userSelect: 'none' } : {}}
          >
            {alpha ? `Beta Plays for $${alpha.symbol}` : 'Select a Runner'}
          </h1>
          {!alpha && (
            <p className="beta-panel-subtitle">Pick a runner from the left panel to surface its beta plays</p>
          )}
        </div>
        {alpha && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={refresh}>↺ Rescan</button>
            <button className="btn btn-amber btn-sm" onClick={onListBeta}>⚡ List Beta</button>
          </div>
        )}
      </div>

      {/* ── Birdeye intel strip — shown prominently above the beta table ── */}
      {alpha && birdeye?.hasData && (birdeye.holderCount != null || birdeye.buyRatio != null || birdeye.change7d != null) && (
        <div style={{
          display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 12px',
          background: 'rgba(0,229,255,0.04)', border: '1px solid rgba(0,229,255,0.12)',
          borderRadius: 8, margin: '0 0 4px',
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', alignSelf: 'center', marginRight: 2 }}>
            🔭 INTEL
          </span>

          {birdeye.change7d != null && (
            <div style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '3px 8px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>7d </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: birdeye.change7d >= 0 ? 'var(--neon-green)' : 'var(--red)' }}>
                {birdeye.change7d >= 0 ? '+' : ''}{birdeye.change7d.toFixed(1)}%
              </span>
            </div>
          )}
          {birdeye.change30d != null && (
            <div style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '3px 8px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>30d </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: birdeye.change30d >= 0 ? 'var(--neon-green)' : 'var(--red)' }}>
                {birdeye.change30d >= 0 ? '+' : ''}{birdeye.change30d.toFixed(1)}%
              </span>
            </div>
          )}
          {birdeye.holderCount != null && (
            <div style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '3px 8px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>holders </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: 'var(--cyan)' }}>
                {birdeye.holderCount.toLocaleString()}
              </span>
            </div>
          )}
          {birdeye.concentration && (
            <div style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '3px 8px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>top10 owns </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: birdeye.concentration.riskColor }}>
                {birdeye.concentration.top10Pct}%
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: birdeye.concentration.riskColor, marginLeft: 3, opacity: 0.8 }}>
                {birdeye.concentration.risk}
              </span>
            </div>
          )}
          {birdeye.buyRatio != null && (
            <div style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '3px 8px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>buys </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
                color: birdeye.buyRatio >= 0.6 ? 'var(--neon-green)' : birdeye.buyRatio <= 0.4 ? 'var(--red)' : 'var(--amber)' }}>
                {Math.round(birdeye.buyRatio * 100)}%
              </span>
            </div>
          )}
          {birdeye.uniqueMakers != null && (
            <div style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '3px 8px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>makers </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: 'var(--text-primary)' }}>
                {birdeye.uniqueMakers.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      )}      {!alpha ? (
        <div className="empty-state">
          <div className="empty-state-icon">👈</div>
          <div className="empty-state-title">No runner selected</div>
          <div className="empty-state-sub">Pick a runner from the left panel, or search any token in the search bar above.</div>
        </div>
      ) : (
        <>
          {parentLoading && <div className="skeleton" style={{ height: 100, borderRadius: 10, marginBottom: 8 }} />}
          {!parentLoading && parent && <ParentAlphaCard parent={parent} />}

          {/* Filters + Timing — single combined row */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
            {/* Mcap filter tabs */}
            <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
              {[['all','All'],['large','>$10M'],['mid','$1M-10M'],['small','$100K-1M'],['micro','<$100K']].map(([key, label]) => (
                <button key={key} className={`tab-btn ${mcapFilter === key ? 'active' : ''}`} onClick={() => setMcapFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
            {/* Trenches toggle */}
            <button
              className={`btn btn-sm ${trenchOnly ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTrenchOnly(!trenchOnly)}
            >
              ⛏️ TRENCHES {trenchCount > 0 && `(${trenchCount})`}
            </button>
            {/* Timing group — same pill container as mcap filters */}
            <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: '3px', borderRadius: 8, border: '1px solid var(--border)', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-number)', fontSize: 7, color: 'var(--text-muted)', letterSpacing: 1, padding: '2px 4px', opacity: 0.6, borderRight: '1px solid var(--border)', marginRight: 2 }}>TIMING</span>
              {[
                { emoji: '🌊', label: 'WAVE',    sub: '<6h',    color: 'var(--neon-green)'     },
                { emoji: '📈', label: '2ND LEG', sub: '6-24h',  color: 'var(--amber)'          },
                { emoji: '🕐', label: 'LATE',    sub: '1-7d',   color: 'var(--text-secondary)' },
                { emoji: '🧊', label: 'COLD',    sub: '7d+',    color: 'var(--text-muted)'     },
              ].map(({ emoji, label, sub, color }) => (
                <Tooltip key={label} text={`${emoji} ${label} — entered ${sub} ago`}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
                    color, cursor: 'default', whiteSpace: 'nowrap',
                    padding: '2px 5px', borderRadius: 4,
                    border: `1px solid ${color}33`,
                  }}>
                    {emoji} {label} <span style={{ opacity: 0.65, fontSize: '0.85em' }}>{sub}</span>
                  </span>
                </Tooltip>
              ))}
            </div>
          </div>

          {/* Beta table */}
          <div className="beta-table">
            <div className="beta-table-header">
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                TOKEN
                <Tooltip text="Tap any row to open full token details">
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'default', opacity: 0.7 }}>ⓘ</span>
                </Tooltip>
              </span>
              <span onClick={() => handleSort('mcap')}   style={{ cursor: 'pointer', userSelect: 'none' }}>MCAP / Room <SortIcon col="mcap" /></span>
              <span onClick={() => handleSort('volume')} style={{ cursor: 'pointer', userSelect: 'none' }}>24h Vol <SortIcon col="volume" /></span>
              <span onClick={() => handleSort('liq')}    style={{ cursor: 'pointer', userSelect: 'none' }}>Liquidity <SortIcon col="liq" /></span>
              <span onClick={() => handleSort('change')} style={{ cursor: 'pointer', userSelect: 'none' }}>24h % <SortIcon col="change" /></span>
              <span onClick={() => handleSort('age')}    style={{ cursor: 'pointer', userSelect: 'none' }}>Age <SortIcon col="age" /></span>
              <span>Signal</span>
            </div>

            {/* ── Scan phase indicator — progressive population UX ── */}
            {alpha && betasLoading && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '8px 14px', marginBottom: 6,
                background: 'rgba(0,212,255,0.10)',
                border: '1px solid rgba(0,212,255,0.30)',
                borderRadius: 8, fontFamily: 'var(--font-mono)',
                fontSize: 11, fontWeight: 600, color: 'var(--cyan)',
              }}>
                <span style={{ animation: 'pulse 1s ease-in-out infinite', display: 'inline-block' }}>⟳</span>
                {scanPhase === 'expanding'  && <span>🔍 Expanding concept...</span>}
                {scanPhase === 'searching'  && <span>📡 Searching market... {betas.length > 0 ? `(${betas.length} found so far)` : ''}</span>}
                {scanPhase === 'scoring'    && <span>🤖 AI scoring {betas.length} candidates...</span>}
                {(!scanPhase || scanPhase === 'complete') && <span>Loading...</span>}
              </div>
            )}

            {/* Skeletons only when loading AND no stored betas to show yet */}
            {betasLoading && filteredBetas.length === 0 && (
              <>
                <div className="skeleton loading-row" />
                <div className="skeleton loading-row" />
                <div className="skeleton loading-row" />
                <div className="skeleton loading-row" />
              </>
            )}

            {!betasLoading && error && betas.length === 0 && (
              <div className="empty-state" style={{ marginTop: 24 }}>
                <div className="empty-state-icon">📭</div>
                <div className="empty-state-title">{error}</div>
                <div className="empty-state-sub">Try a different runner or check back when the narrative heats up.</div>
              </div>
            )}

            {/* Show betas whenever available — even while loading is still true */}
            {filteredBetas.map((beta, i) => (
              <BetaRow
                key={beta.id || i}
                beta={beta}
                alpha={alpha}
                isPinned={false}
                trenchOnly={trenchOnly}
                onOpenDrawer={onOpenDrawer}
              />
            ))}

            {/* Complete status */}
            {!betasLoading && scanPhase === 'complete' && filteredBetas.length > 0 && (
              <div style={{
                textAlign: 'center', padding: '10px 8px', fontSize: 11,
                fontFamily: 'var(--font-mono)', fontWeight: 700,
                color: 'var(--neon-green)',
                borderTop: '1px solid rgba(0,255,136,0.15)',
                marginTop: 4,
              }}>
                ✅ {betas.length} beta{betas.length !== 1 ? 's' : ''} found
              </div>
            )}

            {!betasLoading && trenchOnly && trenchCount === 0 && (
              <div className="empty-state" style={{ marginTop: 24 }}>
                <div className="empty-state-icon">⛏️</div>
                <div className="empty-state-title">No trench plays found.</div>
                <div className="empty-state-sub">All detected betas are above $30K mcap.</div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}


// ─── Watchlist Store ─────────────────────────────────────────────
// Users star any token (live, cooling, positioning) to watchlist it.
// Stored as an array of full token objects so the Watch tab works
// even after the token drops off the live feed.
const WATCH_STORE_KEY = 'betaplays_watchlist_v1'

const getWatchlistRaw = () => {
  try { return JSON.parse(localStorage.getItem(WATCH_STORE_KEY) || '[]') }
  catch { return [] }
}

const saveWatchlistRaw = (list) => {
  try { localStorage.setItem(WATCH_STORE_KEY, JSON.stringify(list)) }
  catch {}
}

// ─── Community Flag Store ─────────────────────────────────────────
// Simple localStorage-backed flagging system.
// Users flag a token as RUG, HONEYPOT, or LEGIT.
// Flags are shown to everyone — local majority vote surface pattern.
const FLAG_STORE_KEY = 'betaplays_flags_v1'

const getFlags = () => {
  try { return JSON.parse(localStorage.getItem(FLAG_STORE_KEY) || '{}') }
  catch { return {} }
}

const submitFlag = (address, flagType, symbol) => {
  try {
    const flags = getFlags()
    if (!flags[address]) flags[address] = { rug: 0, honeypot: 0, not_beta: 0, symbol }
    flags[address][flagType] = (flags[address][flagType] || 0) + 1
    flags[address].lastFlagged = Date.now()
    localStorage.setItem(FLAG_STORE_KEY, JSON.stringify(flags))
    return flags[address]
  } catch { return null }
}

const FlagButton = ({ address, symbol }) => {
  const [counts, setCounts] = useState(() => getFlags()[address] || null)
  const [voted,  setVoted]  = useState(() => {
    const f = getFlags()[address]
    return !!(f && (f.rug > 0 || f.honeypot > 0 || f.not_beta > 0))
  })
  const [votedType, setVotedType] = useState(() => {
    const f = getFlags()[address]
    if (!f) return null
    if (f.not_beta > 0) return 'not_beta'
    if (f.rug > 0)      return 'rug'
    if (f.honeypot > 0) return 'honeypot'
    return null
  })
  const [open, setOpen] = useState(false)

  const handleFlag = (e, flagType) => {
    e.stopPropagation()
    const result = submitFlag(address, flagType, symbol)
    setCounts(result)
    setVoted(true)
    setVotedType(flagType)
    setOpen(false)
  }

  const total = counts
    ? (counts.rug || 0) + (counts.honeypot || 0) + (counts.not_beta || 0)
    : 0

  const LABEL_MAP = {
    rug:      { emoji: '🪤', label: 'Rug pull',  color: 'var(--red)'        },
    honeypot: { emoji: '🍯', label: 'Honeypot',  color: 'var(--amber)'      },
    not_beta: { emoji: '❌', label: 'Not a beta', color: 'var(--text-muted)' },
  }

  const OPTIONS = [
    ['rug',      '🪤 Rug pull',   'var(--red)'],
    ['honeypot', '🍯 Honeypot',   'var(--amber)'],
    ['not_beta', '❌ Not a beta', 'var(--text-muted)'],
  ]

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* Current counts */}
      {total > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          {(counts?.rug      || 0) > 0 && <span style={{ fontFamily: 'var(--font-number)', fontSize: 10, color: 'var(--red)'        }}>🪤 Rug: {counts.rug}</span>}
          {(counts?.honeypot || 0) > 0 && <span style={{ fontFamily: 'var(--font-number)', fontSize: 10, color: 'var(--amber)'      }}>🍯 Honeypot: {counts.honeypot}</span>}
          {(counts?.not_beta || 0) > 0 && <span style={{ fontFamily: 'var(--font-number)', fontSize: 10, color: 'var(--text-muted)' }}>❌ Not a beta: {counts.not_beta}</span>}
        </div>
      )}

      {/* Voted state — shows what they picked, persists across drawer opens */}
      {voted && votedType ? (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: LABEL_MAP[votedType]?.color || 'var(--neon-green)' }}>
          ✓ Flagged as {LABEL_MAP[votedType]?.label}
        </span>
      ) : voted ? (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--neon-green)' }}>✓ Flagged</span>
      ) : (
        <>
          <button
            onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
            style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              color: 'var(--text-secondary)', cursor: 'pointer', borderRadius: 5,
              fontFamily: 'var(--font-mono)', fontSize: 9, padding: '5px 10px',
            }}
          >🚩 Flag this token</button>

          {open && (
            <div style={{
              position: 'absolute', left: 0, top: '110%', zIndex: 300,
              background: 'var(--surface-2)', border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
              minWidth: 140, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', padding: '0 4px 4px' }}>Flag as:</span>
              {OPTIONS.map(([type, label, color]) => (
                <button key={type} onClick={e => handleFlag(e, type)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'var(--font-number)', fontSize: 10, color, padding: '5px 8px',
                  borderRadius: 5, transition: 'background 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >{label}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Used inline in BetaRow to show warning badge only
const FlagWarningBadge = ({ address }) => {
  const flags = getFlags()[address] || null
  if (!flags) return null
  const rugWarn      = (flags.rug      || 0) >= 3
  const honeyWarn    = (flags.honeypot || 0) >= 3
  const notBetaWarn  = (flags.not_beta || 0) >= 3
  if (!rugWarn && !honeyWarn && !notBetaWarn) return null
  return (
    <span className="badge" style={{
      fontSize: 7, padding: '1px 4px',
      background: notBetaWarn ? 'rgba(255,255,255,0.06)' : 'rgba(255,68,102,0.15)',
      borderColor: notBetaWarn ? 'rgba(255,255,255,0.2)'  : 'rgba(255,68,102,0.4)',
      color: notBetaWarn ? 'var(--text-muted)' : 'var(--red)',
    }}>
      {rugWarn ? '⚠️ RUG' : honeyWarn ? '⚠️ HONEY' : '⚠️ DISPUTED'}
    </span>
  )
}

// ─── Token Detail Drawer ──────────────────────────────────────────
// Slide-in panel showing full token intel when a beta row is clicked:
//   - Live price + 24h, 7d, 30d change
//   - Holder count + concentration risk
//   - Buy/sell pressure
//   - Description
//   - Community flags
//   - Quick links: DEX, Birdeye, PumpFun

const TokenDrawer = ({ token, alpha, onClose }) => {
  const { birdeye } = useBirdeye(token?.address)

  if (!token) return null

  const change     = parseFloat(token.priceChange24h) || 0
  const isPositive = change >= 0
  const wave       = getWavePhase(alpha, token)
  const signal     = getSignal(token)
  const flags      = getFlags()[token.address] || null
  const totalFlags = flags ? (flags.rug || 0) + (flags.honeypot || 0) + (flags.not_beta || 0) : 0

  return (
    <div
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: 320, zIndex: 9999,
        background: 'var(--surface-1)',
        borderLeft: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '-12px 0 40px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column',
        animation: 'slideInRight 0.2s ease',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="token-icon" style={{ width: 36, height: 36 }}>
            {token.logoUrl ? <img src={token.logoUrl} alt={token.symbol} /> : token.symbol.slice(0, 3)}
          </div>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18 }}>
              ${token.symbol}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>
              {token.name}
            </div>
            <CopyAddress address={token.address} />
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, padding: '0 4px' }}
        >✕</button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Price + changes */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-number)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>PRICE ACTION</div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, color: isPositive ? 'var(--neon-green)' : 'var(--red)', marginBottom: 10 }}>
            {formatPrice(token.priceUsd)}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              ['24h', change, isPositive ? 'var(--neon-green)' : 'var(--red)'],
              ['7d',  birdeye?.change7d,  (birdeye?.change7d ?? 0) >= 0 ? 'var(--neon-green)' : 'var(--red)'],
              ['30d', birdeye?.change30d, (birdeye?.change30d ?? 0) >= 0 ? 'var(--neon-green)' : 'var(--red)'],
            ].map(([label, val, color]) => val != null && (
              <div key={label} style={{ background: 'var(--surface-3)', borderRadius: 5, padding: '4px 8px' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{label}</div>
                <div style={{ fontFamily: 'var(--font-number)', fontSize: 11, fontWeight: 700, color }}>
                  {val >= 0 ? '+' : ''}{Number(val).toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Market metrics */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>MARKET</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              ['MCAP', formatNum(token.marketCap)],
              ['VOL 24H', formatNum(token.volume24h)],
              ['LIQUIDITY', formatNum(token.liquidity)],
              ['AGE', token.ageLabel || '?'],
            ].map(([label, val]) => (
              <div key={label}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{label}</div>
                <div style={{ fontFamily: 'var(--font-number)', fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>{val}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Birdeye intel */}
        {birdeye?.hasData && (birdeye.holderCount != null || birdeye.buyRatio != null) && (
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>🔭 HOLDER INTEL</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {birdeye.holderCount != null && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>HOLDERS</div>
                  <div style={{ fontFamily: 'var(--font-number)', fontSize: 11, color: 'var(--cyan)', fontWeight: 700 }}>{birdeye.holderCount.toLocaleString()}</div>
                </div>
              )}
              {birdeye.concentration && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>TOP 10 OWN</div>
                  <div style={{ fontFamily: 'var(--font-number)', fontSize: 11, color: birdeye.concentration.riskColor, fontWeight: 700 }}>
                    {birdeye.concentration.top10Pct}% <span style={{ fontSize: 8 }}>({birdeye.concentration.risk})</span>
                  </div>
                </div>
              )}
              {birdeye.buyRatio != null && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>BUY PRESSURE</div>
                  <div style={{ fontFamily: 'var(--font-number)', fontSize: 11, fontWeight: 700,
                    color: birdeye.buyRatio >= 0.6 ? 'var(--neon-green)' : birdeye.buyRatio <= 0.4 ? 'var(--red)' : 'var(--amber)' }}>
                    {Math.round(birdeye.buyRatio * 100)}%
                  </div>
                </div>
              )}
              {birdeye.uniqueMakers != null && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>MAKERS 24H</div>
                  <div style={{ fontFamily: 'var(--font-number)', fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>
                    {birdeye.uniqueMakers.toLocaleString()}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Signal */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>DETECTION SIGNALS</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
            {(Array.isArray(token.signalSources) ? token.signalSources : (token.signalSources || '').split(',')).filter(Boolean).map(s => (
              <span key={s} className="badge badge-weak" style={{ fontSize: 7, padding: '2px 5px' }}>{s.trim()}</span>
            ))}
            {wave?.label !== 'UNKNOWN' && wave && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: wave.color, border: `1px solid ${wave.color}44`, borderRadius: 3, padding: '2px 5px' }}>{wave.label}</span>
            )}
          </div>
          {token.aiReason && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)', lineHeight: 1.5, fontStyle: 'italic' }}>
              "{token.aiReason}"
            </div>
          )}
        </div>

        {/* Description */}
        {token.description && (
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: 1 }}>DESCRIPTION</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {token.description.slice(0, 280)}{token.description.length > 280 ? '...' : ''}
            </div>
          </div>
        )}

        {/* Addresses — DEXScreener style copyable rows */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 10, letterSpacing: 1 }}>ADDRESSES</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Token CA */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', minWidth: 60 }}>TOKEN</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <CopyAddress address={token.address} />
                <a
                  href={token.dexUrl || `https://dexscreener.com/solana/${token.address}`}
                  target="_blank" rel="noreferrer"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)', textDecoration: 'none', border: '1px solid rgba(0,212,255,0.25)', borderRadius: 3, padding: '1px 5px' }}
                  onClick={e => e.stopPropagation()}
                >DEX ↗</a>
              </div>
            </div>
            {/* Alpha CA if available */}
            {alpha?.address && alpha.address !== token.address && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', minWidth: 60 }}>ALPHA</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CopyAddress address={alpha.address} />
                  <a
                    href={alpha.dexUrl || `https://dexscreener.com/solana/${alpha.address}`}
                    target="_blank" rel="noreferrer"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)', textDecoration: 'none', border: '1px solid rgba(0,212,255,0.25)', borderRadius: 3, padding: '1px 5px' }}
                    onClick={e => e.stopPropagation()}
                  >DEX ↗</a>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Community flags — FlagButton handles counts + voting UI */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>🚩 COMMUNITY FLAGS</div>
          {totalFlags === 0 && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginBottom: 8 }}>No flags yet — be the first</div>
          )}
          <FlagButton address={token.address} symbol={token.symbol} />
        </div>

        {/* Nominate for OG — compact version */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>⭐ NOMINATE FOR OG STATUS</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginBottom: 8 }}>
            Think this token deserves Legend status? Nominate it for review.
          </div>
          <NominateButton address={token.address} symbol={token.symbol} name={token.name} compact />
        </div>

        {/* Quick links */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            ['DEXScreener', token.dexUrl || `https://dexscreener.com/solana/${token.address}`],
            ['Birdeye', `https://birdeye.so/token/${token.address}?chain=solana`],
            token.address?.endsWith('pump') && ['PumpFun', `https://pump.fun/${token.address}`],
          ].filter(Boolean).map(([label, url]) => (
            <a key={label} href={url} target="_blank" rel="noreferrer" style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)',
              border: '1px solid rgba(0,212,255,0.3)', borderRadius: 5,
              padding: '5px 10px', textDecoration: 'none', transition: 'all 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,212,255,0.1)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >{label} ↗</a>
          ))}
          <a
            href={`https://twitter.com/search?q=${encodeURIComponent('$' + token.symbol)}&f=live`}
            target="_blank" rel="noreferrer"
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)',
              border: '1px solid rgba(0,212,255,0.3)', borderRadius: 5,
              padding: '5px 10px', textDecoration: 'none', transition: 'all 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,212,255,0.1)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
          >𝕏 Search ↗</a>
        </div>

      </div>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────

// ─── Footer ──────────────────────────────────────────────────────
const AppFooter = () => (
  <footer style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 20px',
    background: 'rgba(0,0,0,0.4)',
    borderTop: '1px solid rgba(0,212,255,0.08)',
    fontFamily: 'var(--font-mono)',
    fontSize: 9, color: 'var(--text-muted)',
    flexShrink: 0,
  }}>
    <span style={{ letterSpacing: 1 }}>BETAPLAYS · SOLANA · BETA</span>
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      {[
        { label: '𝕏 Twitter',  url: 'https://twitter.com/betaplays'  },
        { label: '✈️ Telegram', url: 'https://t.me/betaplays'          },
        { label: '💻 GitHub',   url: 'https://github.com/AdedamolaUX/beta-plays' },
      ].map(({ label, url }) => (
        <a key={label} href={url} target="_blank" rel="noreferrer"
          style={{ color: 'var(--text-muted)', textDecoration: 'none', letterSpacing: 0.5 }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--cyan)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
        >{label}</a>
      ))}
    </div>
    <span style={{ opacity: 0.5 }}>Not financial advice · DYOR</span>
  </footer>
)

export default function App() {
  const [selectedAlpha, setSelectedAlpha] = useState(null)
  const [customAlphaQuery, setCustomAlphaQuery] = useState('')
  const [customAlphaLoading, setCustomAlphaLoading] = useState(false)
  const [customAlphaError, setCustomAlphaError] = useState('')
  const clearAlphaBoardSearch = useRef(null) // set by AlphaBoard

  const handleSearchCustomAlpha = async (query) => {
    if (!query.trim()) return
    setCustomAlphaLoading(true)
    setCustomAlphaError('')
    try {
      const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
      // Try DEXScreener search
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query.trim())}`)
      const data = await res.json()
      const solanaPairs = (data.pairs || []).filter(p => p.chainId === 'solana')
      const q = query.trim().toLowerCase()

      // Priority 1: exact symbol match — pick highest liquidity among exact matches
      const exactSymbol = solanaPairs
        .filter(p => p.baseToken?.symbol?.toLowerCase() === q)
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))

      // Priority 2: exact address match
      const exactAddress = solanaPairs.filter(p => p.baseToken?.address === query.trim())

      // Priority 3: name contains query — highest liquidity
      const nameMatch = solanaPairs
        .filter(p => p.baseToken?.name?.toLowerCase().includes(q))
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))

      // Priority 4: any solana pair — highest liquidity
      const fallback = [...solanaPairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))

      const pair = exactAddress[0] || exactSymbol[0] || nameMatch[0] || fallback[0] || null

      if (!pair) {
        setCustomAlphaError(`No Solana token found for "${query}"`)
        return
      }

      const customAlpha = {
        id:            pair.baseToken.address,
        address:       pair.baseToken.address,
        symbol:        pair.baseToken.symbol,
        name:          pair.baseToken.name,
        logoUrl:       pair.info?.imageUrl || null,
        dexUrl:        pair.url || `https://dexscreener.com/solana/${pair.baseToken.address}`,
        priceUsd:      parseFloat(pair.priceUsd) || 0,
        priceChange24h: parseFloat(pair.priceChange?.h24) || 0,
        volume24h:     pair.volume?.h24 || 0,
        marketCap:     pair.marketCap || pair.fdv || 0,
        liquidity:     pair.liquidity?.usd || 0,
        ageDays:       pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 86400000) : '?',
        source:        'custom_search',
        isCustomSearch: true,
      }
      setSelectedAlpha(customAlpha)
      setCustomAlphaQuery('')
      // Clear the search bar so the pinned card shows clean
      if (clearAlphaBoardSearch.current) clearAlphaBoardSearch.current()
    } catch (err) {
      setCustomAlphaError('Search failed — check connection')
      console.warn('[CustomSearch]', err.message)
    } finally {
      setCustomAlphaLoading(false)
    }
  }
  const [showListModal, setShowListModal]  = useState(false)
  const [drawerToken,   setDrawerToken]    = useState(null)
  const [newRunners,    setNewRunners]     = useState(false)
  const [appLiveAlphas, setAppLiveAlphas] = useState([])
  const [appSznCards,     setAppSznCards]     = useState([])
  const [appCoolingAlphas, setAppCoolingAlphas] = useState([])  // fed by AlphaBoard via onLiveAlphas
  const alphaListRef = useRef(null)
  const isSzn = selectedAlpha?.isSzn === true

  const handleSelectAlpha = (alpha) => {
    setSelectedAlpha(alpha)
    if (alpha?.address) sessionStorage.setItem('betaplays_selected', alpha.address)
  }

  const handleNewRunners = useCallback(() => {
    setNewRunners(true)
    setTimeout(() => setNewRunners(false), 2000)
  }, [])

  const handleScrollToAlpha = useCallback(() => {
    if (!selectedAlpha?.address || !alphaListRef.current) return
    const el = alphaListRef.current.querySelector(`[data-address="${selectedAlpha.address}"]`)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedAlpha])

  return (
    <div className="app-wrapper">
      <Navbar onListBeta={() => setShowListModal(true)} newRunners={newRunners} liveAlphas={appLiveAlphas} coolingAlphas={appCoolingAlphas} />
      <NarrativeTicker liveAlphas={appLiveAlphas} sznCards={appSznCards} />
      <div className="main-layout" style={{ flex: 1, overflow: 'hidden' }}>
        <AlphaBoard selectedAlpha={selectedAlpha} onSelect={handleSelectAlpha} onNewRunners={handleNewRunners} onLiveAlphas={setAppLiveAlphas} onSznCards={setAppSznCards} onCoolingAlphas={setAppCoolingAlphas} onCustomSearch={handleSearchCustomAlpha} customAlphaLoading={customAlphaLoading} onRegisterClearSearch={fn => { clearAlphaBoardSearch.current = fn }} alphaListRef={alphaListRef} />
        {isSzn
          ? <SznPanel  szn={selectedAlpha}   onListBeta={() => setShowListModal(true)} onOpenDrawer={setDrawerToken} />
          : <BetaPanel alpha={selectedAlpha} liveAlphas={appLiveAlphas} onListBeta={() => setShowListModal(true)} onOpenDrawer={setDrawerToken} onScrollToAlpha={handleScrollToAlpha} onCustomSearch={handleSearchCustomAlpha} customAlphaLoading={customAlphaLoading} customAlphaError={customAlphaError} />
        }
      </div>

      {showListModal && (
        <div className="modal-overlay" onClick={() => setShowListModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">⚡ List Your Beta</div>
            <div className="modal-sub">Monetization flow — coming in Phase 3</div>
            <button className="btn btn-ghost" onClick={() => setShowListModal(false)}>Close</button>
          </div>
        </div>
      )}

      {/* Token detail drawer — rendered via portal into document.body so
          it escapes all ancestor overflow:hidden / stacking contexts */}
      {drawerToken && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.5)' }}
            onClick={() => setDrawerToken(null)}
          />
          <TokenDrawer
            token={drawerToken}
            alpha={selectedAlpha}
            onClose={() => setDrawerToken(null)}
          />
        </>,
        document.body
      )}
      <AppFooter />
    </div>
  )
}