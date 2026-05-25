import betaplaysLogo from './assets/betaplays-logo.png'
import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import useAlphas from './hooks/useAlphas'
import LEGENDS, { submitNomination, getNominations, syncNominationsFromDB, NOMINATIONS_KEY } from './data/historical_alphas'
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
const CopyAddress = ({ address, style = {} }) => {
  const [copied, setCopied] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
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

  const showTip = () => {
    if (ref.current && !copied) {
      const r = ref.current.getBoundingClientRect()
      const rawLeft = r.left + r.width / 2
      const clamped = Math.min(Math.max(rawLeft, 50), window.innerWidth - 50)
      setPos({ left: clamped, top: r.top - 6 })
    }
  }
  const hideTip = () => setPos(null)

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', ...style }}>
      <span
        onClick={handleCopy}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
          color: copied ? 'var(--neon-green)' : pos ? 'var(--cyan)' : 'var(--text-muted)',
          background: copied
            ? 'rgba(0,255,136,0.08)'
            : pos ? 'rgba(0,212,255,0.08)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${copied
            ? 'rgba(0,255,136,0.3)'
            : pos ? 'rgba(0,212,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: 4, padding: '2px 6px',
          cursor: 'pointer', userSelect: 'none',
          transition: 'all 0.15s ease',
          letterSpacing: '0.03em',
        }}
      >
        {copied ? '✓' : '⎘'}
      </span>
      {pos && !copied && createPortal(
        <span style={{
          position: 'fixed', left: pos.left, top: pos.top,
          transform: 'translate(-50%, -100%)',
          background: '#0d1117',
          border: '1px solid rgba(0,212,255,0.35)',
          borderRadius: 4, padding: '4px 10px', zIndex: 9999,
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.05em',
          color: 'var(--cyan)', whiteSpace: 'nowrap',
          boxShadow: '0 0 12px rgba(0,212,255,0.15), 0 4px 16px rgba(0,0,0,0.7)',
          pointerEvents: 'none', textAlign: 'center',
        }}>
          {shortAddress(address)} · click to copy
        </span>,
        document.body
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
  letterSpacing: '0.03em', textTransform: 'uppercase',
  color: 'var(--cyan)',
  whiteSpace: 'normal', maxWidth: 260, lineHeight: 1.5,
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
      // Clamp so tooltip never overflows viewport edges
      const rawLeft = r.left + r.width / 2
      const TOOLTIP_HALF = 130 // ~half of maxWidth:260
      const clamped = Math.min(
        Math.max(rawLeft, TOOLTIP_HALF + 8),
        window.innerWidth - TOOLTIP_HALF - 8
      )
      setPos({ left: clamped, top: r.top - 6 })
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
const DataSourceStatus = ({ liveAlphas = [], coolingAlphas = [] }) => {
  const [hovered, setHovered] = useState(null) // { source, pos }
  const all = [...liveAlphas, ...coolingAlphas]
  const sources = [
    { key: 'boost',          label: 'DEX Boosted',  short: 'BST', desc: 'Paid promoted tokens on DEXScreener. High visibility, may include non-organic projects.' },
    { key: 'profile',        label: 'DEX Profiles', short: 'PRF', desc: 'Tokens with DEXScreener profile pages. Indicates some project legitimacy and curation.' },
    { key: 'pumpfun_bonded', label: 'PumpFun',      short: 'PMP', desc: 'Tokens that graduated from PumpFun bonding curve. High degen activity signal.' },
    { key: 'new_pair',       label: 'New Pairs',    short: 'NEW', desc: 'Freshly created trading pairs on Solana DEXes. Earliest possible entry signals.' },
    { key: 'birdeye',        label: 'Birdeye',      short: 'BRD', desc: 'Organic trending tokens from Birdeye — ranked by real 24h volume and price action.' },
  { key: 'cto',            label: 'CTO',          short: 'CTO', desc: 'Community takeover tokens — dead projects revived by the community. High volatility, beta-rich.' },
  { key: 'profile_update', label: 'Updated',      short: 'UPD', desc: 'Tokens with recently updated profiles — catches rebrands, relaunches, and CTO pushes.' },
  { key: 'meta',           label: 'Meta',         short: 'MTA', desc: 'Tokens from Tier 2 confirmed DEXScreener narratives — at least 2 tokens up 30%+ in 24h.' },
  ]
  const activeSources = new Set(all.map(a => a.source).filter(Boolean))

  const showTip = (e, s) => {
    const r = e.currentTarget.getBoundingClientRect()
    // anchor below the pill, clamped so it never overflows right edge
    const rawLeft = r.left + r.width / 2
    const clamped = Math.min(rawLeft, window.innerWidth - 150)
    setHovered({ source: s, pos: { left: clamped, top: r.bottom + 6 } })
  }
  const hideTip = () => setHovered(null)

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        {sources.map((s) => {
          const live = activeSources.has(s.key)
          return (
            <span
              key={s.key}
              onMouseEnter={(e) => showTip(e, s)}
              onMouseLeave={hideTip}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 700,
                padding: '1px 4px', borderRadius: 3, cursor: 'default',
                background: live ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,102,0.1)',
                border: '1px solid ' + (live ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,102,0.3)'),
                color: live ? 'var(--neon-green)' : 'var(--red)',
                letterSpacing: 0.3,
              }}
            >
              {s.short}
            </span>
          )
        })}
      </div>

      {hovered && createPortal(
        <div style={{
          position: 'fixed',
          left: hovered.pos.left,
          top: hovered.pos.top,
          transform: 'translateX(-50%)',
          background: 'var(--surface-2)',
          border: `1px solid ${activeSources.has(hovered.source.key) ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,102,0.3)'}`,
          borderRadius: 8, padding: '10px 14px', zIndex: 9999,
          minWidth: 200, maxWidth: 260,
          boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
          pointerEvents: 'none',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              {hovered.source.label}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
              padding: '2px 5px', borderRadius: 3, flexShrink: 0,
              background: activeSources.has(hovered.source.key) ? 'rgba(0,255,136,0.15)' : 'rgba(255,68,102,0.15)',
              color: activeSources.has(hovered.source.key) ? 'var(--neon-green)' : 'var(--red)',
              border: `1px solid ${activeSources.has(hovered.source.key) ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,102,0.3)'}`,
            }}>
              {activeSources.has(hovered.source.key) ? '● LIVE' : '● OFFLINE'}
            </span>
          </div>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
            {hovered.source.desc}
          </p>
        </div>,
        document.body
      )}
    </>
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

// ─── Settings ────────────────────────────────────────────────────

const SETTINGS_KEY = 'betaplays_settings_v1'

const DEFAULT_SETTINGS = {
  hideWeakBetas:     false,   // hide WEAK tier betas
  hideUnclassified:  false,   // hide betas with no V8 score
  defaultTab:        'live',  // starting alpha tab
  metaSeedEnabled:   true,    // MetaSeed narrative injection
  compactBetas:      false,   // compact beta card layout
  defaultBetaSort:   'rank',  // default beta sort column
  theme:             'dark',  // 'dark' | 'dim'
}

const useSettings = () => {
  const [settings, setSettings] = useState(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
    } catch { return DEFAULT_SETTINGS }
  })

  const updateSetting = (key, value) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch {}
      // Apply DOM-level settings immediately
      if (key === 'theme') {
        document.body.setAttribute('data-theme', value)
      }
      if (key === 'compactBetas') {
        document.body.setAttribute('data-compact-betas', value ? 'true' : 'false')
      }
      return next
    })
  }

  const resetSettings = () => {
    try { localStorage.removeItem(SETTINGS_KEY) } catch {}
    setSettings(DEFAULT_SETTINGS)
  }

  // Apply initial DOM-level settings on mount
  useEffect(() => {
    document.body.setAttribute('data-theme', settings.theme || 'dark')
    document.body.setAttribute('data-compact-betas', settings.compactBetas ? 'true' : 'false')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { settings, updateSetting, resetSettings }
}

const SettingsPanel = ({ settings, onUpdate, onReset, onClose }) => {
  const overlay = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const panel = {
    background: 'var(--surface-2)', border: '1px solid var(--border-lit)',
    borderRadius: 12, padding: 24, width: 340, maxWidth: '90vw',
    display: 'flex', flexDirection: 'column', gap: 20,
  }
  const row = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  }
  const label = {
    fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700,
    color: 'var(--text-primary)',
  }
  const sublabel = {
    fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--text-muted)',
    marginTop: 2,
  }
  const Toggle = ({ settingKey }) => {
    const on = settings[settingKey]
    return (
      <div
        onClick={() => onUpdate(settingKey, !on)}
        style={{
          width: 36, height: 20, borderRadius: 10, flexShrink: 0,
          background: on ? 'var(--neon-green)' : 'rgba(255,255,255,0.1)',
          position: 'relative', cursor: 'pointer', transition: 'background 0.2s',
        }}
      >
        <div style={{
          position: 'absolute', top: 3, left: on ? 19 : 3,
          width: 14, height: 14, borderRadius: '50%',
          background: 'white', transition: 'left 0.2s',
        }} />
      </div>
    )
  }
  const Select = ({ settingKey, options }) => (
    <select
      value={settings[settingKey]}
      onChange={e => onUpdate(settingKey, e.target.value)}
      style={{
        background: 'var(--surface-3)', border: '1px solid var(--border)',
        borderRadius: 6, color: 'var(--text-primary)', padding: '4px 8px',
        fontFamily: 'var(--font-display)', fontSize: 11, cursor: 'pointer',
      }}
    >
      {options.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
    </select>
  )

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={panel}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 800, color: 'var(--neon-green)' }}>
            ⚙️ Settings
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>

        {/* Beta display */}
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 12 }}>BETA RESULTS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={row}>
              <div>
                <div style={label}>Hide weak betas</div>
                <div style={sublabel}>Remove WEAK tier from results</div>
              </div>
              <Toggle settingKey="hideWeakBetas" />
            </div>
            <div style={row}>
              <div>
                <div style={label}>Hide unclassified</div>
                <div style={sublabel}>Only show AI-scored betas</div>
              </div>
              <Toggle settingKey="hideUnclassified" />
            </div>
            <div style={row}>
              <div>
                <div style={label}>Default sort</div>
                <div style={sublabel}>How betas are ordered by default</div>
              </div>
              <Select settingKey="defaultBetaSort" options={[['rank','Rank'],['change','24h %'],['volume','Volume'],['mcap','Mcap']]} />
            </div>
            <div style={row}>
              <div>
                <div style={label}>Compact layout</div>
                <div style={sublabel}>Smaller beta cards, more visible</div>
              </div>
              <Toggle settingKey="compactBetas" />
            </div>
          </div>
        </div>

        {/* Appearance */}
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 12 }}>APPEARANCE</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={row}>
              <div>
                <div style={label}>Theme</div>
                <div style={sublabel}>Light or dark interface</div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[
                  { key: 'dark', label: '🌙 Dark' },
                  { key: 'dim',  label: '🌆 Dim'  },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => onUpdate('theme', key)}
                    style={{
                      padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
                      fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
                      border: `1px solid ${settings.theme === key ? 'var(--cyan)' : 'rgba(255,255,255,0.1)'}`,
                      background: settings.theme === key ? 'rgba(0,212,255,0.12)' : 'transparent',
                      color: settings.theme === key ? 'var(--cyan)' : 'var(--text-muted)',
                    }}
                  >{label}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Discovery */}
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 12 }}>DISCOVERY</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={row}>
              <div>
                <div style={label}>MetaSeed injection</div>
                <div style={sublabel}>Add active narrative terms to searches</div>
              </div>
              <Toggle settingKey="metaSeedEnabled" />
            </div>
            <div style={row}>
              <div>
                <div style={label}>Default tab</div>
                <div style={sublabel}>Which tab opens on load</div>
              </div>
              <Select settingKey="defaultTab" options={[['live','Live'],['cooling','Cooling'],['narratives','Narratives'],['watch','Watchlist']]} />
            </div>
          </div>
        </div>

        {/* Reset */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <button
            onClick={() => { onReset(); onClose() }}
            style={{
              background: 'rgba(255,68,102,0.1)', border: '1px solid rgba(255,68,102,0.3)',
              borderRadius: 6, color: 'var(--red)', fontFamily: 'var(--font-display)',
              fontSize: 11, fontWeight: 700, padding: '6px 14px', cursor: 'pointer', width: '100%',
            }}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Navbar ─────────────────────────────────────────────────────

const Navbar = ({ onListBeta, newRunners, liveAlphas, coolingAlphas, onSettings, onWalletConnect, onWalletSignIn, onWalletSignOut, isAuthed, isConnected, walletAddress }) => (
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
      {isAuthed ? (
        <button
          onClick={onWalletSignOut}
          title={`Connected: ${walletAddress}`}
          onMouseEnter={e => { e.currentTarget.dataset.hover = '1'; e.currentTarget.style.background = 'rgba(255,80,80,0.1)'; e.currentTarget.style.borderColor = 'rgba(255,80,80,0.4)'; e.currentTarget.style.color = '#ff5050' }}
          onMouseLeave={e => { e.currentTarget.dataset.hover = '0'; e.currentTarget.style.background = 'rgba(0,212,255,0.08)'; e.currentTarget.style.borderColor = 'rgba(0,212,255,0.3)'; e.currentTarget.style.color = 'var(--cyan)' }}
          style={{
            background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.3)',
            borderRadius: 8, cursor: 'pointer', color: 'var(--cyan)',
            fontSize: 11, padding: '6px 10px', lineHeight: 1, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.05em', transition: 'all 0.15s ease', minWidth: 80,
          }}
        >
          {walletAddress?.slice(0, 4)}…{walletAddress?.slice(-4)}
        </button>
      ) : isConnected ? (
        <button
          onClick={onWalletSignIn}
          style={{
            background: 'rgba(57,255,20,0.08)', border: '1px solid rgba(57,255,20,0.35)',
            borderRadius: 8, cursor: 'pointer', color: 'var(--neon-green)',
            fontSize: 11, padding: '6px 10px', lineHeight: 1, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.05em', transition: 'all 0.15s ease', animation: 'pulse 2s infinite',
          }}
        >
          ✍️ SIGN IN
        </button>
      ) : (
        <button
          onClick={onWalletConnect}
          style={{
            background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.25)',
            borderRadius: 8, cursor: 'pointer', color: 'var(--text-secondary)',
            fontSize: 11, padding: '6px 10px', lineHeight: 1, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.05em', transition: 'all 0.15s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(0,212,255,0.6)'; e.currentTarget.style.color = 'var(--cyan)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(0,212,255,0.25)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
        >
          🔗 CONNECT
        </button>
      )}
      <button
        onClick={onSettings}
        style={{
          background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)',
          borderRadius: 8, cursor: 'pointer', color: 'var(--text-muted)',
          fontSize: 16, padding: '6px 10px', lineHeight: 1,
          transition: 'all 0.15s ease',
        }}
        title="Settings"
      >⚙️</button>
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

  // Defensive label parsing — every Szn card needs [emoji, ...words].
  // Meta cards from DEXScreener now have emoji prefix via slugToEmoji,
  // but guard against any future label without one.
  const labelParts  = szn.label.split(' ')
  const hasEmoji    = labelParts[0] && /\p{Emoji}/u.test(labelParts[0])
  const cardEmoji   = hasEmoji ? labelParts[0] : (heat.emoji || '🔥')
  const cardTitle   = hasEmoji
    ? labelParts.slice(1).join(' ')
    : szn.label  // no emoji — use full label as title

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
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 17, flexShrink: 0 }}>{cardEmoji}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13, color: 'var(--cyan)' }}>
                {cardTitle} Szn
              </div>
              {szn.source === 'ai' && (
                <Tooltip text="AI-grouped — this entire narrative was identified and categorised by AI.">
                  <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 4px', cursor: 'default', gap: 3 }}>🤖 AI</span>
                </Tooltip>
              )}
              {szn.source === 'mixed' && (
                <Tooltip text={`AI-enriched — ${szn.aiEnriched} token${szn.aiEnriched !== 1 ? 's' : ''} in this narrative were added by AI classification, on top of keyword matches.`}>
                  <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 6px', cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span>🤖</span><span>+{szn.aiEnriched}</span>
                  </span>
                </Tooltip>
              )}
            </div>
            <div style={{ fontFamily: 'var(--font-number)', fontSize: 8, color: 'var(--text-muted)', marginTop: 4 }}>
              {szn.tokenCount} tokens · {formatNum(szn.totalVolume)} vol
            </div>
          </div>
        </div>
        {/* Heat badge + score */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: 8, fontWeight: 700,
            color: heat.color, letterSpacing: 0.3,
          }}>{heat.emoji} {heat.label}</span>
          <Tooltip text="Narrative score (0–100): combines total volume, number of tokens, avg price change, and momentum. Higher = more active narrative right now.">
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', cursor: 'default', borderBottom: '1px dotted rgba(255,255,255,0.2)' }}>
              score {sznScore}/100
            </span>
          </Tooltip>
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
          <span style={{ fontFamily: 'var(--font-number)', fontSize: 9, fontWeight: 700, color: 'var(--neon-green)', fontVariantNumeric: 'tabular-nums' }}>
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
              overflow: 'hidden',
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-secondary)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                ${t.symbol}
              </div>
              <div style={{ fontFamily: 'var(--font-number)', fontVariantNumeric: 'tabular-nums', fontSize: 9, fontWeight: 700, color: c >= 0 ? 'var(--neon-green)' : 'var(--red)' }}>
                {c >= 0 ? '+' : ''}{c.toFixed(0)}%
              </div>
            </div>
          )
        })}
      </div>

      {/* News event badge — real-world catalyst indicator */}
      {szn.newsEvent && (
        <div style={{
          marginTop: 6,
          background: 'rgba(100,200,255,0.06)',
          border: '1px solid rgba(100,200,255,0.15)',
          borderRadius: 5,
          padding: '4px 7px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 5,
        }}>
          <span style={{ fontSize: 9, flexShrink: 0, marginTop: 1 }}>📰</span>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 7, fontWeight: 700,
              color: 'var(--sky)', letterSpacing: 0.4, marginBottom: 2,
            }}>
              REAL-WORLD CATALYST · {Math.round(szn.newsEvent.confidence * 100)}% signal
            </div>
            <div style={{
              fontFamily: 'var(--font-body)', fontSize: 8, color: 'var(--text-muted)',
              lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            }}>
              {szn.newsEvent.headline}
            </div>
          </div>
        </div>
      )}
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

const AlphaCard = ({ alpha, isSelected, onClick, isWatched, onToggleWatch, isCalled, onFolioCall }) => {
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', overflow: 'hidden' }}>
              <div className="token-name" style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${alpha.symbol}</div>
              {derivative && (
                <Tooltip text={parentSymbol ? `Derivative of $${parentSymbol}` : 'Derivative token — shares narrative with a parent alpha'}>
                  <span className="badge badge-new" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>🧬</span>
                </Tooltip>
              )}
              {alpha.isLegend && (
                <Tooltip text="Legend — OG token with verified history">
                  <span className="badge badge-verified" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>🏆</span>
                </Tooltip>
              )}
              {alpha.isCooling && !alpha.isDumped && (
                <Tooltip text="Cooling — price action slowing down">
                  <span className="badge badge-weak" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>❄️</span>
                </Tooltip>
              )}
              {alpha.isDumped && (
                <Tooltip text="Dumped — price collapsed 75%+ from peak. Treat as dead unless volume returns.">
                  <span className="badge badge-weak" style={{ fontSize: 11, padding: '1px 3px', background: 'rgba(255,68,102,0.15)', borderColor: 'rgba(255,68,102,0.4)', color: 'var(--red)', cursor: 'default' }}>💀</span>
                </Tooltip>
              )}
              {alpha.source === 'pumpfun_bonded' && (
                <Tooltip text="Graduated from PumpFun — bonded token">
                  <span className="badge badge-new" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>🎓</span>
                </Tooltip>
              )}
              {alpha.source === 'pumpfun_pre' && (
                <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 5px', background: 'rgba(255,184,0,0.12)', borderColor: 'rgba(255,184,0,0.3)', color: 'var(--amber)' }}>
                  🔥 {alpha.bondingProgress}% bonding
                </span>
              )}
              {(alpha.source === 'birdeye_trending' || alpha.source === 'dex_gainers') && (
                <Tooltip text="Organic runner — found via momentum, not paid promotion">
                  <span className="badge badge-organic" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>🦅</span>
                </Tooltip>
              )}
              {alpha.source === 'dex_new' && (
                <Tooltip text="New pair — recently launched token">
                  <span className="badge badge-new-pair" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>✨</span>
                </Tooltip>
              )}
              {/* Revival badge — token returned from cooling/dumped state */}
              {alpha.isRevival && (
                <Tooltip text={
                  alpha.recoveryPct != null
                    ? `Revived Token — ${alpha.recoveryPct}% of peak recovered`
                    : `Revived Token — recovering from cooling`
                }>
                  <span style={{
                    fontSize: 11, padding: '1px 3px', borderRadius: 3,
                    cursor: 'default', lineHeight: 1,
                    animation: 'pulse 2s infinite',
                    display: 'inline-block', flexShrink: 0,
                  }}>🔄</span>
                </Tooltip>
              )}

              {/* Re-entry strength badge — how many times token has appeared on the runner feed */}
              {(alpha.runCount || 0) >= 3 && (
                <Tooltip text={`On runner feed ${alpha.runCount}× — signals strength`}>
                  <span style={{
                    fontFamily:  'var(--font-mono)', fontSize: 9,
                    padding:     '1px 4px', borderRadius: 3, cursor: 'default',
                    background:  alpha.runCount >= 10
                      ? 'rgba(0,255,153,0.15)'
                      : alpha.runCount >= 5
                      ? 'rgba(0,212,255,0.12)'
                      : 'rgba(255,255,255,0.07)',
                    border: alpha.runCount >= 10
                      ? '1px solid rgba(0,255,153,0.4)'
                      : alpha.runCount >= 5
                      ? '1px solid rgba(0,212,255,0.35)'
                      : '1px solid rgba(255,255,255,0.15)',
                    color: alpha.runCount >= 10
                      ? 'var(--neon-green)'
                      : alpha.runCount >= 5
                      ? 'var(--cyan)'
                      : 'var(--text-muted)',
                    fontWeight: 700,
                  }}>
                    🔄 {alpha.runCount}×
                  </span>
                </Tooltip>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <CopyAddress address={alpha.address} />
              {alpha.coolingLabel && (
                <span style={{
                  fontFamily:   'var(--font-mono)',
                  fontSize:     8,
                  color:        alpha.isDumped ? 'var(--red)' : 'var(--cyan)',
                  maxWidth:     90,
                  overflow:     'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace:   'nowrap',
                  display:      'inline-block',
                }}
                title={alpha.coolingLabel}
                >
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
          {/* Actions: star + folio call + DEX link */}
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
            {onFolioCall && (
              <Tooltip text={isCalled ? 'Remove from folio' : '🎯 Call it — add to public folio'}>
              <button
                onClick={e => { e.stopPropagation(); onFolioCall?.(alpha) }}
                style={{
                  background: isCalled ? 'rgba(57,255,20,0.12)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${isCalled ? 'rgba(57,255,20,0.4)' : 'rgba(255,255,255,0.12)'}`,
                  borderRadius: 4, cursor: 'pointer', padding: '1px 5px',
                  fontSize: 11, lineHeight: 1.6, color: isCalled ? 'var(--neon-green)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(57,255,20,0.15)'; e.currentTarget.style.borderColor = 'rgba(57,255,20,0.5)' }}
                onMouseLeave={e => { e.currentTarget.style.background = isCalled ? 'rgba(57,255,20,0.12)' : 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = isCalled ? 'rgba(57,255,20,0.4)' : 'rgba(255,255,255,0.12)' }}
              >{isCalled ? '🎯' : '◎'}</button>
              </Tooltip>
            )}
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
  const [nominations, setNominations] = useState([])
  const [nomLoading, setNomLoading]   = useState(false)

  // Load nominations from Supabase on auth — not localStorage.
  // All nominations from all users/devices are visible to admin.
  const loadNominations = async () => {
    setNomLoading(true)
    try {
      const res = await fetch(`${BACKEND_URL}/api/nominations`)
      if (!res.ok) throw new Error('fetch failed')
      const { nominations: rows } = await res.json()
      setNominations(rows || [])
    } catch {
      // Fallback to localStorage if Supabase unavailable
      try {
        setNominations(Object.values(JSON.parse(localStorage.getItem('betaplays_nominations') || '{}')))
      } catch { setNominations([]) }
    } finally {
      setNomLoading(false)
    }
  }

  const handleAuth = () => {
    if (pwInput === ADMIN_PASSWORD) {
      sessionStorage.setItem('bp_admin', '1')
      setAuthed(true)
      loadNominations()
    } else {
      setPwError(true)
      setPwInput('')
      setTimeout(() => setPwError(false), 2000)
    }
  }

  // Re-load when already authed on mount
  useEffect(() => { if (authed) loadNominations() }, [authed])

  const updateStatus = async (address, status) => {
    try {
      // Write to Supabase
      await fetch(`${BACKEND_URL}/api/nominations/${address}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status }),
      })
      // Optimistic local update
      setNominations(prev => prev.map(n => n.address === address ? { ...n, status } : n))
    } catch (err) {
      console.warn('[Nominations] Status update failed:', err.message)
    }
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

// ─── FolioCard ───────────────────────────────────────────────────
// Self-contained folio card. Loads its own calls when expanded.
// Collapsed: name, bio, call count, public badge.
// Expanded: edit fields + token list + CA search.
const FolioCard = ({ folio, authWallet, authToken, folioSearch, folioSearchRes, folioSearching, onFolioSearch, onFolioCall, folioCallAddrs, folioTagging, setFolioTagging, onFolioTag, onUpdate, onDelete, backendUrl }) => {
  const [expanded,   setExpanded]   = useState(false)
  const [calls,      setCalls]      = useState([])
  const [loadingC,   setLoadingC]   = useState(false)
  const [nameEdit,   setNameEdit]   = useState(folio.name || '')
  const [bioEdit,    setBioEdit]    = useState(folio.bio || '')
  const [pubEdit,    setPubEdit]    = useState(folio.public ?? true)
  const [saving,     setSaving]     = useState(false)
  const [saveMsg,    setSaveMsg]    = useState('')
  const TAGS = ['AI', 'dogs', 'cats', 'sports', 'political', 'space', 'DeSci', 'gaming', 'anime', 'degen']

  const loadCalls = async () => {
    if (!authToken) return
    setLoadingC(true)
    try {
      const r = await fetch(`${backendUrl}/api/folios/${folio.id}/calls`, { headers: { Authorization: `Bearer ${authToken}` } })
      const data = await r.json()
      if (Array.isArray(data)) setCalls(data)
    } catch {}
    setLoadingC(false)
  }

  const handleExpand = () => {
    if (!expanded) loadCalls()
    setExpanded(e => !e)
  }

  const handleSave = async () => {
    if (!authToken) return
    setSaving(true); setSaveMsg('')
    try {
      const res = await fetch(`${backendUrl}/api/folios/${folio.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: nameEdit.trim() || null, bio: bioEdit.trim() || null, public: pubEdit }),
      })
      if (res.ok) {
        onUpdate({ name: nameEdit.trim(), bio: bioEdit.trim(), public: pubEdit })
        setSaveMsg('✓ Saved')
        setTimeout(() => { setSaveMsg(''); setExpanded(false) }, 1000)
      } else { setSaveMsg('Error saving') }
    } catch { setSaveMsg('Error saving') }
    setSaving(false)
  }

  const handleDelete = async () => {
    if (!authToken || !window.confirm(`Delete folio "${folio.name || 'Folio'}"? This removes all its calls.`)) return
    try {
      await fetch(`${backendUrl}/api/folios/${folio.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } })
      onDelete(folio.id)
    } catch {}
  }

  const handleRemoveCall = async (address) => {
    try {
      await fetch(`${backendUrl}/api/folio/call/${address}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } })
      setCalls(prev => prev.filter(c => c.token_address !== address))
      onUpdate({ call_count: Math.max(0, (folio.call_count || 0) - 1) })
    } catch {}
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Collapsed header */}
      <div onClick={handleExpand} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', transition: 'border-color 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(0,212,255,0.3)'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{folio.name || 'Unnamed Folio'}</div>
            {folio.bio && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{folio.bio}</div>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--cyan)' }}>{folio.call_count || 0}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>calls</div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginTop: 2 }}>{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: pubEdit ? 'rgba(57,255,20,0.07)' : 'rgba(255,255,255,0.05)', border: pubEdit ? '1px solid rgba(57,255,20,0.3)' : '1px solid var(--border)', color: pubEdit ? 'var(--neon-green)' : 'var(--text-muted)' }}>{pubEdit ? '🌐 PUBLIC' : '🔒 PRIVATE'}</span>
        </div>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 2px' }}>
          {/* Edit */}
          <input value={nameEdit} onChange={e => setNameEdit(e.target.value)} placeholder="Folio name..."
            style={{ width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }} />
          <input value={bioEdit} onChange={e => setBioEdit(e.target.value.slice(0, 80))} placeholder="Short bio (80 chars)..."
            style={{ width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 10, outline: 'none', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setPubEdit(p => !p)} style={{ padding: '5px 8px', borderRadius: 6, fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, cursor: 'pointer', background: pubEdit ? 'rgba(57,255,20,0.1)' : 'rgba(255,255,255,0.05)', border: pubEdit ? '1px solid rgba(57,255,20,0.4)' : '1px solid var(--border)', color: pubEdit ? 'var(--neon-green)' : 'var(--text-muted)' }}>{pubEdit ? '🌐' : '🔒'}</button>
            <button onClick={handleSave} disabled={saving} style={{ flex: 1, padding: '5px 10px', borderRadius: 6, fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, cursor: 'pointer', background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.3)', color: 'var(--cyan)', opacity: saving ? 0.5 : 1 }}>{saving ? 'SAVING...' : 'SAVE & CLOSE'}</button>
            <button onClick={handleDelete} style={{ padding: '5px 8px', borderRadius: 6, fontSize: 9, fontFamily: 'var(--font-mono)', cursor: 'pointer', background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.25)', color: '#ff5050' }}>🗑</button>
          </div>
          {saveMsg && <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: saveMsg.startsWith('✓') ? 'var(--neon-green)' : '#ff5050', margin: 0 }}>{saveMsg}</p>}

          {/* Add by CA/ticker */}
          <input value={folioSearch} onChange={e => onFolioSearch(e.target.value)} placeholder="Add by CA or ticker..."
            style={{ width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }} />
          {folioSearching && <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>Searching...</p>}
          {(folioSearchRes || []).map(t => (
            <div key={t.address} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>${t.symbol} <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{t.name}</span></span>
              <button onClick={() => { onFolioCall({ ...t, _targetFolioId: folio.id }); onFolioSearch('') }}
                style={{ padding: '3px 8px', borderRadius: 4, fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, cursor: 'pointer', background: folioCallAddrs?.has(t.address) ? 'rgba(57,255,20,0.1)' : 'rgba(0,212,255,0.08)', border: folioCallAddrs?.has(t.address) ? '1px solid rgba(57,255,20,0.3)' : '1px solid rgba(0,212,255,0.25)', color: folioCallAddrs?.has(t.address) ? 'var(--neon-green)' : 'var(--cyan)' }}>
                {folioCallAddrs?.has(t.address) ? '🎯 CALLED' : '🎯 CALL IT'}
              </button>
            </div>
          ))}

          {/* Calls list */}
          {loadingC ? <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>Loading calls...</p> : (
            <>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', margin: 0 }}>{calls.length} call{calls.length !== 1 ? 's' : ''} · Hit ◎ on any runner to add</p>
              {calls.length === 0 && <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>No calls yet.</p>}
              {calls.map(c => {
                const isTagging = folioTagging === c.token_address
                return (
                  <div key={c.token_address} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-2)', border: '1px solid rgba(57,255,20,0.2)', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--neon-green)', flexShrink: 0 }}>🎯 ${c.symbol}</span>
                        {c.narrative_tag && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, background: 'rgba(57,255,20,0.07)', border: '1px solid rgba(57,255,20,0.25)', borderRadius: 3, padding: '1px 5px', color: 'var(--neon-green)', textTransform: 'uppercase' }}>{c.narrative_tag}</span>}
                        {c.price_at_call && <span style={{ fontFamily: 'var(--font-number)', fontSize: 9, color: 'var(--text-muted)' }}>@ ${Number(c.price_at_call).toFixed(6)}</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => setFolioTagging(isTagging ? null : c.token_address)} style={{ padding: '2px 6px', borderRadius: 4, fontSize: 8, fontFamily: 'var(--font-mono)', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>{isTagging ? 'CANCEL' : c.narrative_tag ? 'RETAG' : '+ TAG'}</button>
                        <button onClick={() => handleRemoveCall(c.token_address)} style={{ padding: '2px 6px', borderRadius: 4, fontSize: 8, fontFamily: 'var(--font-mono)', cursor: 'pointer', background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.25)', color: '#ff5050' }}>✕</button>
                      </div>
                    </div>
                    {isTagging && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', paddingLeft: 4 }}>
                        {TAGS.map(tag => (
                          <button key={tag} onClick={() => { onFolioTag(c.token_address, tag); setCalls(prev => prev.map(x => x.token_address === c.token_address ? { ...x, narrative_tag: tag } : x)) }}
                            style={{ padding: '3px 7px', borderRadius: 4, fontSize: 8, fontFamily: 'var(--font-mono)', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', background: c.narrative_tag === tag ? 'rgba(57,255,20,0.12)' : 'rgba(0,212,255,0.07)', border: c.narrative_tag === tag ? '1px solid rgba(57,255,20,0.4)' : '1px solid rgba(0,212,255,0.25)', color: c.narrative_tag === tag ? 'var(--neon-green)' : 'var(--cyan)' }}>{tag}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const AlphaBoard = ({ selectedAlpha, onSelect, onNewRunners, onLiveAlphas, onSznCards, onCoolingAlphas, onCustomSearch, customAlphaLoading, onRegisterClearSearch, alphaListRef, searchResults, onSelectSearchResult, defaultTab = 'live', authToken, isAuthed, authWallet, onFolioCall, folioCallAddrs, folioLeaderboard, folioLoading, folioView, setFolioView, folioSaveMsg, myFolios, setMyFolios, folioSearch, folioSearchRes, folioSearching, onSaveFolioName, onFolioSearch, onFolioLeaderboard, folioTagging, setFolioTagging, onFolioTag, folioProfile, onCreateFolio, activeFolioId, setActiveFolioId }) => {
  const [activeTab,        setActiveTab]        = useState(defaultTab)
  const [searchQuery,      setSearchQuery]      = useState('')
  useEffect(() => {
    if (onRegisterClearSearch) onRegisterClearSearch(() => setSearchQuery(''))
  }, [])
  const [showAdminPanel,   setShowAdminPanel]   = useState(false)
  // ── Folio state ───────────────────────────────────────────────
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

  const { liveAlphas, coolingAlphas: localCoolingAlphas, positioningAlphas: localPositioningAlphas, legends, loading, isRefreshing, error, lastUpdated, refresh } = useAlphas()
  const sznCards = useNarrativeSzn(liveAlphas)

  // ── Cooling/Positioning: Neon DB cutover ──────────────────────
  // Local (useAlphas) data shows instantly from localStorage.
  // When either tab becomes active, we fetch /api/history/full from Neon
  // which has richer data (peakMarketCap, firstSeen, cross-device history).
  // Neon data replaces local once loaded. Falls back to local on error.
  const [neonHistoryTokens,    setNeonHistoryTokens]    = useState(null)  // null = not fetched yet
  const [neonHistoryLoading,   setNeonHistoryLoading]   = useState(false)
  const neonHistoryFetchedRef  = useRef(false)

  useEffect(() => {
    // Only fetch when cooling or positioning tab is active, and only once per session
    if (activeTab !== 'cooling' && activeTab !== 'positioning') return
    if (neonHistoryFetchedRef.current || neonHistoryLoading) return

    neonHistoryFetchedRef.current = true
    setNeonHistoryLoading(true)

    fetch(`${BACKEND_URL}/api/history/full?days=7`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(({ tokens }) => {
        if (Array.isArray(tokens) && tokens.length > 0) {
          setNeonHistoryTokens(tokens)
        }
      })
      .catch(() => { /* silent — local data stays active */ })
      .finally(() => setNeonHistoryLoading(false))
  }, [activeTab, neonHistoryLoading])

  // Build cooling and positioning arrays from Neon data when available,
  // otherwise fall back to localStorage-sourced data from useAlphas.
  const liveAddresses = useMemo(() => new Set(liveAlphas.map(a => a.address)), [liveAlphas])

  const coolingAlphas = useMemo(() => {
    if (!neonHistoryTokens) return localCoolingAlphas

    // Cooling = negative 24h change, not currently live, seen within 7 days
    const now = Date.now()
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
    return neonHistoryTokens
      .filter(t =>
        t.address && t.symbol &&
        !liveAddresses.has(t.address) &&
        (parseFloat(t.priceChange24h) || 0) < 0 &&
        (t.lastSeen ? t.lastSeen > sevenDaysAgo : true)
      )
      .map(t => ({
        ...t,
        // volumeRising: vol is positive but price is down — accumulation signal
        volumeRising: (t.volume24h || 0) > 1000 && (parseFloat(t.priceChange24h) || 0) < 0,
      }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
  }, [neonHistoryTokens, localCoolingAlphas, liveAddresses])

  const positioningAlphas = useMemo(() => {
    if (!neonHistoryTokens) return localPositioningAlphas

    // Positioning = peaked high, now drawn down, volume still alive
    return neonHistoryTokens
      .filter(t => {
        if (!t.address || !t.symbol) return false
        if (liveAddresses.has(t.address)) return false
        const peak    = parseFloat(t.peakMarketCap) || 0
        const current = parseFloat(t.marketCap)     || 0
        if (peak < 100_000) return false            // too small to be worth a position
        if (current <= 0)   return false
        const drawdown = ((peak - current) / peak) * 100
        if (drawdown < 40)  return false            // not drawn down enough to be interesting
        if ((t.volume24h || 0) < 100) return false  // dead — no volume means no liquidity
        return true
      })
      .map(t => {
        const peak    = parseFloat(t.peakMarketCap) || 0
        const current = parseFloat(t.marketCap)     || 0
        const drawdown = peak > 0 ? Math.round(((peak - current) / peak) * 100) : 0
        // Opportunity score: higher drawdown + higher volume + higher peak = better setup
        const opportunityScore = Math.min(100, Math.round(
          (drawdown * 0.4) +
          (Math.min(Math.log10((t.volume24h || 1) + 1) / Math.log10(1_000_000), 1) * 40) +
          (Math.min(Math.log10((peak || 1) + 1) / Math.log10(10_000_000), 1) * 20)
        ))
        const ageDays = t.firstSeen
          ? Math.floor((Date.now() - t.firstSeen) / 86400000)
          : null
        return {
          ...t,
          drawdownPct:     drawdown,
          opportunityScore,
          peakMarketCap:   peak,
          ageDays:         ageDays ?? '?',
        }
      })
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
  }, [neonHistoryTokens, localPositioningAlphas, liveAddresses])

  // ── Watchlist helpers ──────────────────────────────────────────
  const watchedAddresses = useMemo(() => new Set(watchlist.map(a => a.address)), [watchlist])

  const handleToggleWatch = useCallback((alpha) => {
    setWatchlist(prev => {
      const isWatched = prev.some(a => a.address === alpha.address)
      const next = isWatched
        ? prev.filter(a => a.address !== alpha.address)
        : [{ ...alpha, watchedAt: Date.now() }, ...prev]
      saveWatchlistRaw(next)
      // Sync to Supabase if authed
      if (isAuthed && authToken) {
        if (isWatched) {
          fetch(`${BACKEND_URL}/api/watchlist/${alpha.address}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${authToken}` },
          }).catch(() => {})
        } else {
          fetch(`${BACKEND_URL}/api/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({
              token_address: alpha.address,
              symbol:        alpha.symbol,
              name:          alpha.name,
              price_at_add:  alpha.priceUsd || alpha.price || null,
              logo_url:      alpha.logoUrl || null,
              mcap_at_add:   alpha.marketCap || alpha.mcap || null,
            }),
          }).catch(() => {})
        }
      }
      return next
    })
  }, [isAuthed, authToken])

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

    // Warmup live alphas only — cooling tokens are not actionable and waste AI compute
    // Include isRevival + recoveryPct so Supabase alpha_runs preserves revival state.
    // On next page load, history/full returns these fields and revival tokens
    // are re-promoted without waiting for the next detectReversal cycle.
    const allAlphas = [...liveAlphas].map(a => ({
      symbol:      a.symbol,
      name:        a.name,
      address:     a.address,
      description: a.description || '',
      logoUrl:     a.logoUrl     || a.info?.imageUrl || '',
      marketCap:   a.marketCap   || 0,
      liquidity:   a.liquidity   || 0,
      isRevival:   a.isRevival   || false,
      recoveryPct: a.recoveryPct || null,
    }))

    // Add parent alphas from parent map — Supabase first, localStorage fallback
    // No await here — useCallback isn't async. Use .then() chain and fire report-alphas
    // inside the callback once parentMap resolves.
    const localParentMap = JSON.parse(localStorage.getItem('betaplays_parent_map') || '{}')
    const seenAlphas     = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')

    const applyParentMapAndReport = (parentMap) => {
      const seenAddrs = new Set(allAlphas.map(a => a.address))
      Object.values(parentMap).forEach(parent => {
        if (!parent?.address || seenAddrs.has(parent.address)) return
        const full = seenAlphas[parent.address]
        allAlphas.push({
          symbol:  parent.symbol  || full?.symbol  || '',
          name:    full?.name     || parent.symbol || '',
          address: parent.address,
        })
        seenAddrs.add(parent.address)
      })
      fetch(`${BACKEND_URL}/api/report-alphas`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ alphas: allAlphas }),
      }).catch(() => {})
    }

    fetch(`${BACKEND_URL}/api/parent-map`)
      .then(r => r.ok ? r.json() : { map: {} })
      .then(({ map }) => applyParentMapAndReport({ ...localParentMap, ...map }))
      .catch(() => applyParentMapAndReport(localParentMap))
  }, [liveAlphas, coolingAlphas])

  const rawList =
    activeTab === 'live'        ? liveAlphas         :
    activeTab === 'narratives'  ? []                 :
    activeTab === 'cooling'     ? filteredCooling     :
    activeTab === 'positioning' ? positioningAlphas   :
    activeTab === 'watch'       ? watchlist           :
    activeTab === 'folio'       ? []                  :
    activeTab === 'runners'     ? []                  :
    legends

  // Apply search filter across all tabs — guard against malformed entries
  const displayList = useMemo(() => {
    const valid = rawList.filter(a => a && a.symbol && a.address)
    return searchQuery ? valid.filter(a => matchesSearch(a, searchQuery)) : valid
  }, [rawList, searchQuery])



  // ── Alpha filter + sort state (live tab only) ─────────────────────
  const [alphaFilter, setAlphaFilter] = useState('all')  // all | organic | revival | boosted | deriv | new
  const [alphaSort,   setAlphaSort]   = useState('momentum')  // momentum | change | volume | mcap | age

  const filteredSortedLive = useMemo(() => {
    if (activeTab !== 'live') return displayList
    let list = [...displayList]

    // Filter
    if (alphaFilter === 'organic')  list = list.filter(a => a.source === 'birdeye_trending' || a.source === 'dex_gainers')
    if (alphaFilter === 'revival')  list = list.filter(a => a.isRevival)
    if (alphaFilter === 'boosted')  list = list.filter(a => a.source === 'dexscreener_boosted' || a.source === 'boost')
    if (alphaFilter === 'deriv')    list = list.filter(a => isDerivative(a.symbol))
    if (alphaFilter === 'new')      list = list.filter(a => a.source === 'dex_new')

    // Sort
    if (alphaSort === 'change')   list.sort((a, b) => parseFloat(b.priceChange24h || 0) - parseFloat(a.priceChange24h || 0))
    if (alphaSort === 'volume')   list.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
    if (alphaSort === 'mcap')     list.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
    if (alphaSort === 'age')      list.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0))
    // Momentum sort: revival tokens are pinned at 999 ONLY when revival filter is active.
    // In 'all' view, revivals sort by real momentum so they don't hijack the top.
    if (alphaSort === 'momentum' && alphaFilter !== 'revival') {
      list.sort((a, b) => {
        const aScore = a.isRevival ? (a.priceChange24h || 0) * 0.4 + (a.volume24h || 0) * 0.0001 : (a.momentumScore || 0)
        const bScore = b.isRevival ? (b.priceChange24h || 0) * 0.4 + (b.volume24h || 0) * 0.0001 : (b.momentumScore || 0)
        return bScore - aScore
      })
    }
    // When revival filter IS active, keep 999 pin — user explicitly wants revivals highlighted
    console.log(`[AlphaSort] sort=${alphaSort} filter=${alphaFilter} count=${list.length} top=$${list[0]?.symbol}`)

    return list
  }, [displayList, activeTab, alphaFilter, alphaSort])

  // Final list shown in the alpha panel — uses filter/sort on live tab
  const finalDisplayList = activeTab === 'live' && !searchQuery ? filteredSortedLive : displayList

  // Also filter szn cards
  // Deduplicate tokens across szn cards — a token should only appear
  // in the highest-scoring szn card it belongs to, not multiple.
  const dedupedSznCards = useMemo(() => {
    // Step 1: deduplicate cards by key — same category can appear from
    // keyword + novel meta sources simultaneously, causing duplicate React keys.
    // Keep the card with the higher sznScore when there's a conflict.
    const cardsByKey = new Map()
    for (const szn of sznCards) {
      const existing = cardsByKey.get(szn.key)
      if (!existing || szn.sznScore > existing.sznScore) {
        cardsByKey.set(szn.key, szn)
      }
    }
    const uniqueCards = [...cardsByKey.values()]

    // Step 2: deduplicate tokens across cards by address
    const seen = new Set()
    return uniqueCards.map(szn => ({
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

  // History tab removed — use Past Runners tab instead

  useEffect(() => {
    const liveSet = new Set(liveAlphas.map(a => a.address))

    const fetchHistory = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/history?days=7`)
        if (!res.ok) throw new Error('history api failed')
        const { tokens } = await res.json()
        if (Array.isArray(tokens) && tokens.length > 0) {
          const filtered = tokens
            .filter(a => a && a.symbol && a.address && !liveSet.has(a.address))
            .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))
            .slice(0, 50)
          setHistoryAlphas(filtered)
          return
        }
      } catch { /* fall through to localStorage */ }

      // Fallback: localStorage (works offline, pre-DB data)
      try {
        const seen = JSON.parse(localStorage.getItem('betaplays_seen_alphas') || '{}')
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
        const filtered = Object.values(seen)
          .filter(a => a && typeof a === 'object' && a.symbol && a.address &&
            !liveSet.has(a.address) &&
            ((a.lastSeen && a.lastSeen > cutoff) || (a.timestamp && a.timestamp > cutoff)))
          .sort((a, b) => (b.lastSeen || b.timestamp || 0) - (a.lastSeen || a.timestamp || 0))
          .slice(0, 50)
        setHistoryAlphas(filtered)
      } catch { setHistoryAlphas([]) }
    }

    fetchHistory()
  }, [liveAlphas])

  // ── Past Runners tab — historical alpha runners with beta performance ──
  const [pastRunners,        setPastRunners]        = useState([])
  const [pastRunnersLoading, setPastRunnersLoading] = useState(false)
  const [pastRunnersDays,    setPastRunnersDays]    = useState(30)
  const [pastRunnersQuery,   setPastRunnersQuery]   = useState('')

  useEffect(() => {
    if (activeTab !== 'runners') return
    setPastRunnersLoading(true)
    fetch(`${BACKEND_URL}/api/past-runners?days=${pastRunnersDays}&limit=50`)
      .then(r => r.json())
      .then(({ runners }) => {
        setPastRunners(Array.isArray(runners) ? runners : [])
      })
      .catch(() => setPastRunners([]))
      .finally(() => setPastRunnersLoading(false))
  }, [activeTab, pastRunnersDays])

  const tabs = [
    { key: 'live',        label: '🔥 Live',           count: liveAlphas.length        },
    { key: 'narratives',  label: '🌊 ACTIVE NARRATIVES', count: sznCards.length        },
    { key: 'cooling',     label: '❄️ COOLING PLAYS',  count: null                     },
    { key: 'positioning', label: '🎯 Position',       count: null                     },
    { key: 'watch',       label: '⭐ Watchlist',       count: watchlist.length         },
    { key: 'folio',       label: '📊 Folios',          count: null                     },
    { key: 'runners',     label: '🏁 Past Runners',   count: null                     },
    { key: 'legends',     label: '🏆 OGs',            count: legends.length           },
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
            placeholder={activeTab === 'watch' ? 'Filter watchlist...' : 'Search runners or any token...'}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              // Clear custom alpha when user starts typing again
              // so the pinned card doesn't linger
            }}
            onKeyDown={(e) => {
              // On watch tab, Enter just filters — no DEX search
              if (e.key === 'Enter' && searchQuery.trim() && !customAlphaLoading && onCustomSearch && activeTab !== 'watch') {
                onCustomSearch(searchQuery.trim())
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
          {/* DEX search button — hidden on watch tab, watchlist is local only */}
          {searchQuery && !customAlphaLoading && activeTab !== 'watch' && (
            <button
              onClick={() => onCustomSearch?.(searchQuery.trim())}
              style={{
                background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.3)',
                borderRadius: 4, cursor: 'pointer', color: 'var(--cyan)',
                fontFamily: 'var(--font-mono)', fontSize: 8, padding: '2px 6px',
                whiteSpace: 'nowrap', lineHeight: 1.4,
              }}
            >DEX ↗</button>
          )}
          {/* Watchlist match count — shown instead of DEX button */}
          {searchQuery && activeTab === 'watch' && watchlist.length > 0 && (
            <span style={{
              fontSize: 8, color: 'var(--text-muted)', whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)',
            }}>
              {displayList.length}/{watchlist.length}
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
            onClick={() => { setActiveTab(key); setSearchQuery(''); if (key === 'folio' && folioView === 'leaderboard') onFolioLeaderboard() }}
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
              fontFamily: 'var(--font-display)',
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
                Tokens with positive price action right now.
              </p>
              {/* Filter pills + sort dropdown — single line */}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'nowrap', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {[
                    { key: 'all',     label: 'All', title: 'All runners' },
                    { key: 'organic', label: '🦅',  title: 'Organic runners' },
                    { key: 'revival', label: '🔄',  title: 'Revived tokens' },
                    { key: 'boosted', label: '⚡',  title: 'Boosted tokens' },
                    { key: 'deriv',   label: '🧬',  title: 'Derivative tokens' },
                    { key: 'new',     label: '✨',  title: 'New pairs' },
                  ].map(f => (
                    <button key={f.key} onClick={() => setAlphaFilter(f.key)} title={f.title} style={{
                      fontFamily: 'var(--font-display)', fontSize: 8, fontWeight: 700,
                      padding: '2px 7px', borderRadius: 4, cursor: 'pointer', border: '1px solid',
                      flexShrink: 0,
                      background: alphaFilter === f.key ? 'rgba(0,212,255,0.2)' : 'transparent',
                      borderColor: alphaFilter === f.key ? 'rgba(0,212,255,0.6)' : 'rgba(255,255,255,0.1)',
                      color: alphaFilter === f.key ? 'var(--cyan)' : 'var(--text-muted)',
                      transition: 'all 0.15s',
                    }}>{f.label}</button>
                  ))}
                </div>
                <select value={alphaSort} onChange={e => setAlphaSort(e.target.value)} style={{
                  fontFamily: 'var(--font-mono)', fontSize: 8, flexShrink: 0,
                  background: 'var(--surface-2)', color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4,
                  padding: '2px 5px', cursor: 'pointer', outline: 'none',
                }}>
                  <option value="momentum">🔥 Momentum</option>
                  <option value="change">📈 24h %</option>
                  <option value="volume">💧 Volume</option>
                  <option value="mcap">💰 Cap</option>
                  <option value="age">🆕 Newest</option>
                </select>
              </div>
            </div>
          )}
          {activeTab === 'cooling' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, borderLeft: '2px solid var(--cyan)', paddingLeft: 8 }}>
              {volumeRising
                ? `📈 ${filteredCooling.length} tokens with rising volume despite negative price — accumulation signal. Gold in the rough.`
                : `Tokens retracing or consolidating — ${filteredCooling.length} in the last ${coolingTimeframe}. Sorted by recency. Gold in the rough.`
              }
              {neonHistoryLoading && <span style={{ opacity: 0.6 }}> · loading from DB...</span>}
              {!neonHistoryLoading && neonHistoryTokens && <span style={{ opacity: 0.5 }}> · shared</span>}
            </p>
          )}
          {activeTab === 'positioning' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, borderLeft: '2px solid var(--amber)', paddingLeft: 8 }}>
              Big peak. Big drawdown. Volume still alive. These are the second-leg setups degens hunt.
              {positioningAlphas.length === 0 && !neonHistoryLoading && ' Populates as tokens peak and retrace — check back after the next wave.'}
              {neonHistoryLoading && <span style={{ opacity: 0.6 }}> · loading from DB...</span>}
              {!neonHistoryLoading && neonHistoryTokens && <span style={{ opacity: 0.5 }}> · shared</span>}
            </p>
          )}

          {activeTab === 'watch' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, borderLeft: '2px solid var(--amber)', paddingLeft: 8 }}>
              Your starred tokens. ☆ star any runner, cooling token, or positioning play to save it here.
            </p>
          )}
          {activeTab === 'folio' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 20 }}>
              {/* Sub-nav */}
              <div style={{ display: 'flex', gap: 6 }}>
                {['leaderboard', 'mine'].map(v => (
                  <button key={v} onClick={() => { setFolioView(v); if (v === 'leaderboard') onFolioLeaderboard() }} style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 10, fontFamily: 'var(--font-mono)',
                    fontWeight: 700, cursor: 'pointer', letterSpacing: '0.06em',
                    background: folioView === v ? 'rgba(0,212,255,0.12)' : 'transparent',
                    border: folioView === v ? '1px solid rgba(0,212,255,0.4)' : '1px solid var(--border)',
                    color: folioView === v ? 'var(--cyan)' : 'var(--text-muted)',
                    transition: 'all 0.15s ease',
                  }}>
                    {v === 'leaderboard' ? '📊 LEADERBOARD' : '🎯 MY FOLIOS'}
                  </button>
                ))}
              </div>

              {/* Leaderboard */}
              {folioView === 'leaderboard' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {folioLoading && <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>Loading...</p>}
                  {!folioLoading && folioLeaderboard.length === 0 && (
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
                      No public folios yet. Connect wallet and hit ◎ on any runner to make your first call.
                    </p>
                  )}
                  {folioLeaderboard.map((wallet, i) => {
                    const rankColors = ['#FFD700', '#C0C0C0', '#CD7F32']
                    const pnlColor = wallet.overall_pnl === null ? 'var(--text-muted)' : wallet.overall_pnl >= 0 ? 'var(--neon-green)' : '#ff5050'
                    const memberDays = wallet.first_seen ? Math.floor((Date.now() - new Date(wallet.first_seen)) / 86400000) : null
                    return (
                      <div key={wallet.wallet_address} style={{ background: 'var(--surface-2)', border: '1px solid ' + (i < 3 ? rankColors[i] + '40' : 'var(--border)'), borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: i === 0 ? '0 0 12px rgba(255,215,0,0.08)' : 'none' }}>
                        {/* Wallet header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 900, color: i < 3 ? rankColors[i] : 'var(--text-muted)', minWidth: 24 }}>#{i + 1}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                              {wallet.wallet_address?.slice(0,6)}…{wallet.wallet_address?.slice(-4)}
                              {memberDays !== null && ' · ' + memberDays + 'd member'}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            {wallet.overall_pnl !== null ? (
                              <>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: pnlColor }}>{wallet.overall_pnl >= 0 ? '+' : ''}{wallet.overall_pnl.toFixed(1)}%</div>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>avg P&L</div>
                              </>
                            ) : (
                              <>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--cyan)' }}>{wallet.total_calls}</div>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>calls</div>
                              </>
                            )}
                          </div>
                        </div>
                        {/* All folios for this wallet */}
                        {(wallet.folios || []).map(folio => {
                          const folPnlColor = folio.avg_pnl === null ? 'var(--text-muted)' : folio.avg_pnl >= 0 ? 'var(--neon-green)' : '#ff5050'
                          const narratives = [...new Set((folio.calls || []).map(c => c.narrative_tag).filter(Boolean))]
                          return (
                            <div key={folio.folio_id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{folio.folio_name || 'Unnamed Folio'}</span>
                                  {folio.folio_bio && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginTop: 1 }}>{folio.folio_bio}</div>}
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                  {folio.avg_pnl !== null && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: folPnlColor }}>{folio.avg_pnl >= 0 ? '+' : ''}{folio.avg_pnl.toFixed(1)}%</div>}
                                  {folio.best_call && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--neon-green)' }}>🏆 ${folio.best_call.symbol} +{folio.best_call.pnl_pct?.toFixed(0)}%</div>}
                                </div>
                              </div>
                              {narratives.length > 0 && (
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                  {narratives.map(tag => <span key={tag} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, background: 'rgba(57,255,20,0.07)', border: '1px solid rgba(57,255,20,0.25)', borderRadius: 4, padding: '1px 5px', color: 'var(--neon-green)', textTransform: 'uppercase' }}>{tag}</span>)}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                {(folio.calls || []).slice(0, 6).map(c => <span key={c.address} style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 5px', color: 'var(--text-secondary)' }}>${c.symbol}</span>)}
                                {(folio.calls || []).length > 6 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>+{folio.calls.length - 6}</span>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* My Folios */}
              {folioView === 'mine' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {!isAuthed ? (
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
                      Connect wallet to create folios and appear on the leaderboard.
                    </p>
                  ) : (
                    <>
                      {(myFolios || []).map(folio => (
                        <FolioCard
                          key={folio.id}
                          folio={folio}
                          authWallet={authWallet}
                          authToken={authToken}
                          folioSearch={activeFolioId === folio.id ? folioSearch : ''}
                          folioSearchRes={activeFolioId === folio.id ? folioSearchRes : []}
                          folioSearching={activeFolioId === folio.id ? folioSearching : false}
                          onFolioSearch={onFolioSearch}
                          onFolioCall={onFolioCall}
                          folioCallAddrs={folioCallAddrs}
                          folioTagging={folioTagging}
                          setFolioTagging={setFolioTagging}
                          onFolioTag={onFolioTag}
                          onUpdate={(updated) => setMyFolios(prev => prev.map(f => f.id === folio.id ? { ...f, ...updated } : f))}
                          onDelete={(id) => setMyFolios(prev => prev.filter(f => f.id !== id))}
                          backendUrl={`${BACKEND_URL}`}
                        />
                      ))}
                      <button onClick={() => onCreateFolio('New Folio')} style={{
                        padding: '8px 14px', borderRadius: 10, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700,
                        cursor: 'pointer', background: 'transparent', border: '1px dashed var(--border)', color: 'var(--text-muted)',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(0,212,255,0.4)'; e.currentTarget.style.color = 'var(--cyan)' }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                        + NEW FOLIO
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {activeTab === 'legends' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, borderLeft: '2px solid var(--amber)', paddingLeft: 8 }}>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap', overflow: 'hidden' }}>
            <span className="mono text-muted" style={{ fontSize: 9, flexShrink: 0 }}>
              {isRefreshing
                ? <span style={{ color: 'var(--cyan)', animation: 'pulse 1.2s ease-in-out infinite' }}>↻ Updating...</span>
                : `Updated ${lastUpdated.toLocaleTimeString()}`
              }
            </span>

          </div>
          <button className="btn btn-ghost btn-sm" onClick={refresh} style={{ padding: '2px 8px', fontSize: 9, flexShrink: 0 }}>
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
        {/* DEX Search results — shown as AlphaCards in the left panel */}
        {searchResults?.length > 0 && (
          <div style={{ flexShrink: 0 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)',
              letterSpacing: 1, padding: '3px 4px', opacity: 0.8,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>🔍 {searchResults.length} DEX RESULTS — PICK ONE</span>
              <span onClick={() => onSelectSearchResult(null)} style={{ cursor: 'pointer', opacity: 0.6 }}>✕ clear</span>
            </div>
            {searchResults.map(token => (
              <AlphaCard
                key={token.address}
                alpha={token}
                isSelected={selectedAlpha?.address === token.address}
                onClick={() => onSelectSearchResult(token)}
                isWatched={watchedAddresses.has(token.address)}
                onToggleWatch={handleToggleWatch}
                isCalled={folioCallAddrs?.has(token.address)}
                onFolioCall={isAuthed ? onFolioCall : null}
              />
            ))}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '6px 0' }} />
          </div>
        )}

        {/* Single custom search result pinned (legacy — when no multi-results) */}
        {!searchResults?.length && selectedAlpha?.isCustomSearch && !displayList.some(a => a.address === selectedAlpha.address) && (
          <div style={{ flexShrink: 0 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)',
              letterSpacing: 1, padding: '3px 4px', opacity: 0.8,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>🔍 FROM DEX SEARCH</span>
              <span onClick={() => onSelect(null)} style={{ cursor: 'pointer', opacity: 0.6 }}>✕ clear</span>
            </div>
            <AlphaCard
              alpha={selectedAlpha}
              isSelected={true}
              onClick={() => onSelect(selectedAlpha)}
              isWatched={watchedAddresses.has(selectedAlpha.address)}
              onToggleWatch={handleToggleWatch}
              isCalled={folioCallAddrs?.has(selectedAlpha.address)}
              onFolioCall={isAuthed ? onFolioCall : null}
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


        {!loading && isEmpty && searchQuery && (
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

        {!loading && finalDisplayList.map((alpha) => {
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
                  isCalled={folioCallAddrs?.has(alpha.address)}
                  onFolioCall={isAuthed ? onFolioCall : null}
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
                isCalled={folioCallAddrs?.has(alpha.address)}
                onFolioCall={isAuthed ? onFolioCall : null}
              />
            </div>
          )
        })}

        {/* Past Runners tab */}
        {activeTab === 'runners' && (
          <div style={{ padding: '0 4px' }}>
            {/* Header controls — search + day filter */}
            <div style={{ marginBottom: 8 }}>
              {/* Search input */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(255,255,255,0.04)',
                border: `1px solid ${pastRunnersQuery ? 'rgba(0,212,255,0.35)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 8, padding: '6px 10px', marginBottom: 8,
                transition: 'border-color 0.15s',
              }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>🔍</span>
                <input
                  type="text"
                  placeholder="Search past runners by symbol or name..."
                  value={pastRunnersQuery}
                  onChange={e => setPastRunnersQuery(e.target.value)}
                  style={{
                    background: 'transparent', border: 'none', outline: 'none',
                    fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
                    color: 'var(--text-primary)', width: '100%', letterSpacing: '0.02em',
                  }}
                />
                {pastRunnersQuery && (
                  <button
                    onClick={() => setPastRunnersQuery('')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, padding: 0, lineHeight: 1, flexShrink: 0 }}
                  >✕</button>
                )}
              </div>
              {/* Day filter + count row */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {[7, 14, 30].map(d => (
                  <button
                    key={d}
                    onClick={() => setPastRunnersDays(d)}
                    style={{
                      padding:      '3px 10px',
                      borderRadius: 6,
                      border:       `1px solid ${pastRunnersDays === d ? 'var(--cyan)' : 'rgba(255,255,255,0.1)'}`,
                      background:   pastRunnersDays === d ? 'rgba(0,212,255,0.12)' : 'transparent',
                      color:        pastRunnersDays === d ? 'var(--cyan)' : 'var(--text-muted)',
                      fontFamily:   'var(--font-display)',
                      fontSize:     10,
                      cursor:       'pointer',
                      fontWeight:   pastRunnersDays === d ? 700 : 400,
                    }}
                  >{d}D</button>
                ))}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginLeft: 4 }}>
                  {pastRunnersQuery
                    ? `${pastRunners.filter(r =>
                        (r.symbol || '').toLowerCase().includes(pastRunnersQuery.toLowerCase()) ||
                        (r.name   || '').toLowerCase().includes(pastRunnersQuery.toLowerCase())
                      ).length} / ${pastRunners.length} runners`
                    : `${pastRunners.length} runners`
                  }
                </span>
              </div>
            </div>

            {pastRunnersLoading && (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                Loading past runners...
              </div>
            )}

            {!pastRunnersLoading && pastRunnersQuery && pastRunners.length > 0 &&
              pastRunners.filter(r =>
                (r.symbol || '').toLowerCase().includes(pastRunnersQuery.toLowerCase()) ||
                (r.name   || '').toLowerCase().includes(pastRunnersQuery.toLowerCase())
              ).length === 0 && (
              <div style={{ textAlign: 'center', padding: 32 }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>🔍</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>
                  No runners match "{pastRunnersQuery}"
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                  Try a different symbol or name
                </div>
              </div>
            )}

            {!pastRunnersLoading && pastRunners.length === 0 && (
              <div style={{ textAlign: 'center', padding: 32 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🏁</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>No past runners yet</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                  Data accumulates as alphas hit the feed. Check back after 24–48h.
                </div>
              </div>
            )}

            {!pastRunnersLoading && pastRunners
              .filter(runner =>
                !pastRunnersQuery ||
                (runner.symbol || '').toLowerCase().includes(pastRunnersQuery.toLowerCase()) ||
                (runner.name   || '').toLowerCase().includes(pastRunnersQuery.toLowerCase())
              )
              .map(runner => {
              const peakFmt = runner.peakMcap >= 1_000_000
                ? `$${(runner.peakMcap / 1_000_000).toFixed(1)}M`
                : runner.peakMcap >= 1_000
                  ? `$${(runner.peakMcap / 1_000).toFixed(0)}K`
                  : runner.peakMcap > 0 ? `$${runner.peakMcap.toFixed(0)}` : '—'

              const lastSeenLabel = runner.lastSeen
                ? (() => {
                    const h = Math.round((Date.now() - runner.lastSeen) / 3_600_000)
                    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
                  })()
                : '—'

              const sources = (runner.sources || []).join(', ')

              // Build a minimal alpha object that the beta engine can scan
              const runnerAsAlpha = {
                address:        runner.address,
                symbol:         runner.symbol,
                name:           runner.name,
                logoUrl:        runner.logoUrl,
                marketCap:      runner.lastMcap  || 0,
                volume24h:      runner.lastVol   || 0,
                priceChange24h: 0,
                peakMarketCap:  runner.peakMcap  || 0,
                source:         'past_runner',
              }

              return (
                <div
                  key={runner.address}
                  onClick={() => {
                    onSelect(runnerAsAlpha)
                    setActiveTab('live')  // switch to live tab so beta panel is visible
                  }}
                  style={{
                    background:   'var(--surface-2)',
                    border:       '1px solid var(--border)',
                    borderRadius: 10,
                    padding:      '12px 14px',
                    marginBottom: 6,
                    cursor:       'pointer',
                    transition:   'border-color 0.15s, background 0.15s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = 'var(--border-lit)'
                    e.currentTarget.style.background  = 'var(--surface-3)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--border)'
                    e.currentTarget.style.background  = 'var(--surface-2)'
                  }}
                >
                  {/* Token header row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                    {runner.logoUrl
                      ? <img src={runner.logoUrl} alt="" style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0 }} onError={e => { e.target.style.display = 'none' }} />
                      : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.2)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 800, color: 'var(--cyan)' }}>{(runner.symbol || '?')[0]}</div>
                    }
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '0.01em' }}>${runner.symbol}</span>
                        {runner.runCount > 1 && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--amber)', background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.25)', borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>
                            🔄 {runner.runCount}×
                          </span>
                        )}
                        {runner.category && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)', background: 'rgba(0,212,255,0.07)', border: '1px solid rgba(0,212,255,0.18)', borderRadius: 3, padding: '1px 5px' }}>
                            {runner.category}
                          </span>
                        )}
                      </div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                        {runner.name} · {lastSeenLabel}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', letterSpacing: 0.5, marginBottom: 2 }}>ATH</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--neon-green)' }}>{peakFmt}</div>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: runner.topBetas?.length > 0 ? 10 : 0 }}>
                    <div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>TIMES RAN</div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--text-primary)' }}>{runner.runCount}</div>
                    </div>
                    <div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>BETAS FOUND</div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--text-primary)' }}>{runner.betaCount}</div>
                    </div>
                    {sources && (
                      <div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>SOURCE</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{sources}</div>
                      </div>
                    )}
                  </div>

                  {/* Top betas */}
                  {runner.topBetas?.length > 0 && (
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 5, letterSpacing: 1 }}>TOP CONFIRMED BETAS</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {runner.topBetas.map(beta => {
                          const hasPrice = beta.priceAtDetection > 0
                          return (
                            <div
                              key={beta.address}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}
                              onClick={e => { e.stopPropagation(); window.open(`https://dexscreener.com/solana/${beta.address}`, '_blank') }}
                            >
                              {beta.logoUrl
                                ? <img src={beta.logoUrl} alt="" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0 }} onError={e => { e.target.style.display = 'none' }} />
                                : <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
                              }
                              <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--text-primary)', flex: 1 }}>${beta.symbol}</span>
                              {beta.confirmedCount > 1 && (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>×{beta.confirmedCount}</span>
                              )}
                              {beta.relationshipType && (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--cyan)', background: 'rgba(0,212,255,0.08)', borderRadius: 3, padding: '1px 4px' }}>{beta.relationshipType}</span>
                              )}
                              {hasPrice && (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
                                  @ ${beta.priceAtDetection < 0.001
                                    ? beta.priceAtDetection.toExponential(2)
                                    : beta.priceAtDetection.toFixed(4)}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
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
      const rawLeft = r.left + r.width / 2
      const TOOLTIP_HALF = 130
      const clamped = Math.min(
        Math.max(rawLeft, TOOLTIP_HALF + 8),
        window.innerWidth - TOOLTIP_HALF - 8
      )
      setPos({ left: clamped, top: r.top - 6 })
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
// Emoji-only in the row; full label shown on hover via Tooltip.
const WAVE_PHASE_META = {
  WAVE:    { emoji: '🌊', tip: 'Wave — entered less than 6h ago. Fresh and still moving.' },
  '2ND LEG': { emoji: '📈', tip: '2nd Leg — entered 6–24h ago. May be building for a second push.' },
  LATE:    { emoji: '🕐', tip: 'Late — entered 1–7 days ago. Narrative is maturing.' },
  COLD:    { emoji: '🧊', tip: 'Cold — entered 7+ days ago. Narrative has cooled.' },
}

const WaveBadge = ({ phase }) => {
  if (!phase || phase.label === 'UNKNOWN') return null
  const meta = WAVE_PHASE_META[phase.label]
  if (!meta) return null
  return (
    <Tooltip text={meta.tip}>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 11,
        cursor: 'default', userSelect: 'none',
        lineHeight: 1,
      }}>
        {meta.emoji}
      </span>
    </Tooltip>
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

  // Sync count from Supabase on mount — gives accurate cross-device count
  useEffect(() => {
    syncNominationsFromDB().then(all => {
      const n = all[address]?.nominationCount
      if (n) setCount(n)
    }).catch(() => {})
  }, [address])

  const doSubmit = (noteText) => {
    // Write to localStorage via existing submitNomination (session record)
    const result = submitNomination(address, symbol, name, noteText)
    // Also write to Supabase — fire and forget, all users/devices see it
    fetch(`${BACKEND_URL}/api/nominate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address, symbol, name, note: noteText }),
    }).catch(err => console.warn('[Nominations] Supabase write failed:', err.message))
    return result
  }

  const handleSubmit = () => {
    const result = doSubmit(note)
    if (result) setCount(result.nominationCount)
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
          const result = doSubmit('')
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

// ─── Jupiter Swap Helper ─────────────────────────────────────────
// Jupiter Plugin v4 — Ultra mode, RPC-less.
// No referralAccount for now — causes init error until properly registered
// under the Plugin project. Re-add once confirmed working end-to-end.
let isJupiterOpen = false

const openJupiterSwap = (token) => {
  if (!token?.address) return

  const Jupiter = window.Jupiter
  if (!Jupiter) {
    console.warn('[Jupiter] Plugin not loaded — check index.html script tag')
    return
  }

  const backdrop = document.getElementById('jupiter-plugin-mount')
  const inner    = document.getElementById('jupiter-plugin-inner')
  if (!backdrop || !inner) {
    console.warn('[Jupiter] Mount divs missing from index.html')
    return
  }

  if (isJupiterOpen) {
    try {
      Jupiter.syncProps({
        formProps: {
          initialInputMint: 'So11111111111111111111111111111111111111112',
          initialOutputMint: token.address,
        }
      })
    } catch {}
    return
  }

  const handleClose = () => {
    isJupiterOpen = false
    backdrop.style.display = 'none'
    try { Jupiter.close() } catch {}
  }

  backdrop.style.display = 'flex'
  backdrop.onclick = (e) => { if (e.target === backdrop) handleClose() }
  isJupiterOpen = true

  Jupiter.init({
    displayMode: 'integrated',
    integratedTargetId: 'jupiter-plugin-inner',
    formProps: {
      initialInputMint: 'So11111111111111111111111111111111111111112',
      initialOutputMint: token.address,
    },
    defaultExplorer: 'Solana Explorer',
    onSuccess: ({ txid }) => {
      console.log('[Jupiter] Swap success:', txid)
      handleClose()
    },
    onSwapError: ({ error }) => {
      console.warn('[Jupiter] Swap error:', error)
    },
  })
}
// ─── Beta Row ────────────────────────────────────────────────────

const BetaRow = ({ beta, alpha, isPinned, trenchOnly, onOpenDrawer, onSwap }) => {
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
            {isLPPair       && <Tooltip text="LP pair — direct on-chain liquidity link"><span className="badge badge-cabal" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>🔗</span></Tooltip>}
            {isTelegramSig  && <Tooltip text="Telegram signal — spotted in CT alpha channels"><span className="badge" style={{ fontSize: 11, padding: '1px 3px', background: 'rgba(0,212,180,0.15)', borderColor: 'rgba(0,212,180,0.4)', color: 'rgb(0,212,180)', animation: 'pulse 2s infinite', cursor: 'default' }}>📡</span></Tooltip>}
            {isTwitterSig   && <Tooltip text="Twitter signal — spotted on CT"><span className="badge" style={{ fontSize: 11, padding: '1px 3px', background: 'rgba(29,161,242,0.15)', borderColor: 'rgba(29,161,242,0.4)', color: 'rgb(29,161,242)', animation: 'pulse 2s infinite', cursor: 'default' }}>🐦</span></Tooltip>}
            {isTied         && <Tooltip text="Tied — two tokens with similar momentum for this concept"><span className="badge badge-strong" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>⚡</span></Tooltip>}
            {isTrench       && <Tooltip text="Trenches — market cap under $30K. Very high risk, very high reward."><span className="badge badge-new" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>⛏️</span></Tooltip>}
            <FlagWarningBadge address={beta.address} />
            {beta.decayCount >= 2 && (
              <Tooltip text={`⚠️ ${beta.decayCount}/5 decay signals: ${(beta.decaySignals || []).join(', ')}`}>
                <span style={{
                  fontSize: 7, padding: '1px 5px', cursor: 'default',
                  background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.3)',
                  borderRadius: 3, color: 'var(--amber)', fontFamily: 'var(--font-mono)',
                  fontWeight: 700, letterSpacing: 0.3,
                }}>⚠️ {beta.decayCount}/5</span>
              </Tooltip>
            )}
            {isPinned       && <Tooltip text="Dev verified — project team verified"><span className="badge badge-verified" style={{ fontSize: 11, padding: '1px 3px', cursor: 'default' }}>✓</span></Tooltip>}
            {beta.isSibling && <Tooltip text="Sibling — shares the same parent alpha"><span className="badge badge-cabal" style={{ fontSize: 11, padding: '1px 3px', opacity: 0.85, cursor: 'default' }}>👥</span></Tooltip>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
            <CopyAddress address={beta.address} />
            {beta.isHistorical && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '1px 3px' }}>📦</span>}
            <WaveBadge phase={wave} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{formatNum(beta.marketCap)}</span>
        <McapRatioBadge ratio={beta.mcapRatio} />
        {/* ATH — only shown when peak_mcap is known (token was previously an alpha) */}
        {(beta.peakMarketCap || 0) > 0 && (beta.peakMarketCap || 0) > (beta.marketCap || 0) && (
          <Tooltip text={`ATH ${formatNum(beta.peakMarketCap)} · now ${Math.round((beta.marketCap / beta.peakMarketCap) * 100)}% of peak`}>
            <span style={{
              fontFamily:   'var(--font-mono)', fontSize: 8,
              color:        'var(--text-muted)', cursor: 'default',
              letterSpacing: 0.2,
            }}>
              ATH {formatNum(beta.peakMarketCap)}
            </span>
          </Tooltip>
        )}
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
          <span className="badge badge-weak" style={{ fontSize: 9, padding: '1px 3px', cursor: 'default' }}>
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

const BetaPanel = ({ alpha, liveAlphas, onListBeta, onOpenDrawer, onSwap, onScrollToAlpha, onCustomSearch, customAlphaLoading, customAlphaError, settings = {} }) => {
  const { parent, loading: parentLoading }               = useParentAlpha(alpha, liveAlphas)
  const { betas, loading: betasLoading, error, scanPhase, refresh } = useBetas(alpha, parent, { metaSeedEnabled: settings.metaSeedEnabled ?? true })
  const { birdeye }                                       = useBirdeye(alpha?.address)
  const [trenchOnly,   setTrenchOnly]   = useState(false)
  const [mcapFilter,   setMcapFilter]   = useState('all')
  const [sortBy,       setSortBy]       = useState(settings.defaultBetaSort || 'rank')
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
    const filtered = betas.filter(b => {
      if (!mcapFilterFn[mcapFilter](b)) return false
      // Settings gates
      if (settings.hideWeakBetas    && b.signalTier === 'WEAK')                        return false
      if (settings.hideUnclassified && (!b.relationshipType || b.relationshipType === 'SPIN') && !b.aiScore) return false
      return true
    })
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
      )}
      {!alpha ? (
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
            {/* Timing legend — shows what each wave emoji means on hover */}
            <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: '3px', borderRadius: 8, border: '1px solid var(--border)', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 7, color: 'var(--text-secondary)', letterSpacing: 0.5, padding: '2px 5px', opacity: 0.85, borderRight: '1px solid var(--border)', marginRight: 2, fontWeight: 700, textTransform: 'uppercase' }}>TIMING</span>
              {[
                { emoji: '🌊', label: 'WAVE',    sub: '<6h',    color: 'var(--neon-green)',    tip: 'Wave — entered less than 6h ago. Fresh and still moving.' },
                { emoji: '📈', label: '2ND LEG', sub: '6-24h',  color: 'var(--amber)',         tip: '2nd Leg — entered 6–24h ago. May be building for a second push.' },
                { emoji: '🕐', label: 'LATE',    sub: '1-7d',   color: '#a0aec0',             tip: 'Late — entered 1–7 days ago. Narrative is maturing.' },
                { emoji: '🧊', label: 'COLD',    sub: '7d+',    color: '#687280',             tip: 'Cold — entered 7+ days ago. Narrative has cooled.' },
              ].map(({ emoji, label, sub, color, tip }) => (
                <Tooltip key={label} text={tip}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    fontFamily: 'var(--font-display)', fontSize: 8, fontWeight: 700,
                    color, cursor: 'default', whiteSpace: 'nowrap',
                    padding: '2px 6px', borderRadius: 4,
                    background: 'rgba(255,255,255,0.03)',
                    border: `1px solid ${color}44`,
                  }}>
                    {emoji} <span style={{ opacity: 0.9 }}>{label}</span> <span style={{ fontFamily: 'var(--font-number)', opacity: 0.55, fontSize: '0.8em', fontWeight: 400 }}>{sub}</span>
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
                onSwap={onSwap}
              />
            ))}

            {/* Complete status + AI availability banner */}
            {!betasLoading && scanPhase === 'complete' && filteredBetas.length > 0 && (() => {
              const hasAIScored = betas.some(b => b.signalSources?.includes('ai_match'))
              return (
                <>
                  {/* AI unavailable notice — shown when V8 failed silently for all batches */}
                  {!hasAIScored && betas.length > 0 && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      margin: '8px 0 2px',
                      background: 'rgba(255,170,0,0.07)',
                      border: '1px solid rgba(255,170,0,0.2)',
                      borderRadius: 7, padding: '7px 12px',
                    }}>
                      <span style={{ fontSize: 13 }}>⚠️</span>
                      <div>
                        <div style={{
                          fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 800,
                          color: 'var(--amber)', letterSpacing: '0.04em',
                        }}>
                          PATTERN MATCH ONLY
                        </div>
                        <div style={{
                          fontFamily: 'var(--font-body)', fontSize: 9,
                          color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4,
                        }}>
                          AI scoring unavailable this scan — results are keyword &amp; lore matches only.
                          Accuracy is lower. Rescan to retry.
                        </div>
                      </div>
                    </div>
                  )}
                  <div style={{
                    textAlign: 'center', padding: '10px 8px', fontSize: 11,
                    fontFamily: 'var(--font-mono)', fontWeight: 700,
                    color: 'var(--neon-green)',
                    borderTop: '1px solid rgba(0,255,136,0.15)',
                    marginTop: 4,
                  }}>
                    ✅ {betas.length} beta{betas.length !== 1 ? 's' : ''} found
                    {!hasAIScored && <span style={{ color: 'var(--amber)', marginLeft: 6, fontSize: 9 }}>(unscored)</span>}
                  </div>
                </>
              )
            })()}

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

// ─── Flags — Supabase-backed, localStorage as session cache ──────
// getFlags() reads from the in-memory cache populated by loadAllFlags()
// on mount. Stays fast (no async) for synchronous callers like FlagWarningBadge.
let _flagsCache = null

const loadAllFlags = async () => {
  try {
    const res = await fetch(`${BACKEND_URL}/api/flags`)
    if (!res.ok) throw new Error('flags fetch failed')
    const { flags } = await res.json()
    if (flags && Object.keys(flags).length > 0) {
      // Merge with localStorage — Supabase wins on conflict
      const local  = JSON.parse(localStorage.getItem(FLAG_STORE_KEY) || '{}')
      _flagsCache  = { ...local, ...flags }
      localStorage.setItem(FLAG_STORE_KEY, JSON.stringify(_flagsCache))
      return _flagsCache
    }
  } catch { /* fall through */ }
  // Fallback: localStorage
  try {
    _flagsCache = JSON.parse(localStorage.getItem(FLAG_STORE_KEY) || '{}')
    return _flagsCache
  } catch { return {} }
}

const getFlags = () => {
  if (_flagsCache) return _flagsCache
  try { return JSON.parse(localStorage.getItem(FLAG_STORE_KEY) || '{}') }
  catch { return {} }
}

const submitFlag = (address, flagType, symbol) => {
  try {
    // Optimistic local update — UI responds instantly
    const flags = getFlags()
    if (!flags[address]) flags[address] = { rug: 0, honeypot: 0, not_beta: 0, symbol }
    flags[address][flagType] = (flags[address][flagType] || 0) + 1
    flags[address].lastFlagged = Date.now()
    _flagsCache = flags
    localStorage.setItem(FLAG_STORE_KEY, JSON.stringify(flags))

    // Write to Supabase — fire and forget
    fetch(`${BACKEND_URL}/api/flag-token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address, symbol, flagType }),
    }).catch(err => console.warn('[Flags] Supabase write failed:', err.message))

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

const TokenDrawer = ({ token, alpha, onClose, onSwap }) => {
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

        {/* Swap button — only show if token has enough liquidity for Jupiter to route */}
        {onSwap && (
          <button
            onClick={() => onSwap(token)}
            style={{
              width: '100%',
              background: 'linear-gradient(135deg, rgba(0,212,255,0.18), rgba(0,255,136,0.12))',
              border: '1px solid rgba(0,212,255,0.45)',
              borderRadius: 10, padding: '12px 16px',
              cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 800,
              color: 'var(--cyan)', letterSpacing: '0.06em',
              transition: 'all 0.15s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0,212,255,0.28), rgba(0,255,136,0.2))'
              e.currentTarget.style.borderColor = 'rgba(0,212,255,0.7)'
              e.currentTarget.style.boxShadow = '0 0 20px rgba(0,212,255,0.2)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0,212,255,0.18), rgba(0,255,136,0.12))'
              e.currentTarget.style.borderColor = 'rgba(0,212,255,0.45)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            ⚡ SWAP ${token.symbol} <span style={{ fontSize: 9, opacity: 0.7, fontWeight: 400 }}>via Jupiter</span>
          </button>
        )}

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
  // ── Wallet auth ──────────────────────────────────────────────────
  const { publicKey, signMessage, connected } = useWallet()
  const { setVisible: setWalletModalVisible } = useWalletModal()
  const [showWalletModal, setShowWalletModal] = useState(false)
  const [authToken,    setAuthToken]    = useState(() => localStorage.getItem('betaplays_jwt') || null)
  const [authWallet,   setAuthWallet]   = useState(() => localStorage.getItem('betaplays_wallet') || null)
  const isAuthed = !!(authToken && authWallet && connected && publicKey?.toBase58() === authWallet)

  // Sign in with wallet — request nonce, sign, verify, store JWT
  const handleWalletSignIn = useCallback(async () => {
    if (!publicKey || !signMessage) return
    console.log('[Auth] Starting sign-in for', publicKey.toBase58().slice(0,8))
    await new Promise(r => setTimeout(r, 300)) // let wallet modal fully close before sign
    try {
      const wallet = publicKey.toBase58()
      const nonceRes = await fetch(`${BACKEND_URL}/api/auth/nonce?wallet=${wallet}`)
      const { nonce } = await nonceRes.json()
      console.log('[Auth] Got nonce, requesting signature...')
      const msgBytes = new TextEncoder().encode(nonce)
      const sigBytes = await signMessage(msgBytes)
      console.log('[Auth] Signature received, verifying...')
      const verifyRes = await fetch(`${BACKEND_URL}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, signature: Array.from(sigBytes) }),
      })
      const { token } = await verifyRes.json()
      if (!token) throw new Error('No token returned')
      console.log('[Auth] JWT received, storing...')
      localStorage.setItem('betaplays_jwt', token)
      localStorage.setItem('betaplays_wallet', wallet)
      setAuthToken(token)
      setAuthWallet(wallet)
      // Migrate local watchlist to Supabase on first sign-in — sequential to avoid DB storm
      const local = getWatchlistRaw()
      if (local.length > 0) {
        for (const t of local.slice(0, 20)) { // cap at 20 items
          try {
            await fetch(`${BACKEND_URL}/api/watchlist`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ token_address: t.address, symbol: t.symbol, name: t.name }),
            })
          } catch { /* non-fatal */ }
        }
      }
    } catch (err) {
      console.error('[Auth] Sign-in failed:', err.message)
    }
  }, [publicKey, signMessage])

  const handleSignOut = useCallback(() => {
    localStorage.removeItem('betaplays_jwt')
    localStorage.removeItem('betaplays_wallet')
    setAuthToken(null)
    setAuthWallet(null)
    // Note: we don't call disconnect() — it crashes React 19 + wallet adapter
    // due to portal removeChild conflict. User stays wallet-connected but loses JWT.
    // They can disconnect from Phantom extension directly if needed.
  }, [])

  const { settings, updateSetting, resetSettings } = useSettings()

  // ── Folio state (multi-folio system) ────────────────────────
  const [folioLeaderboard, setFolioLeaderboard] = useState([])
  const [folioLoading,     setFolioLoading]     = useState(false)
  const [folioView,        setFolioView]        = useState('leaderboard')
  const [folioSaveMsg,     setFolioSaveMsg]     = useState('')
  const [myFolios,         setMyFolios]         = useState([])
  const [folioCallAddrs,   setFolioCallAddrs]   = useState(new Set())
  const [folioSearch,      setFolioSearch]      = useState('')
  const [folioSearchRes,   setFolioSearchRes]   = useState([])
  const [folioSearching,   setFolioSearching]   = useState(false)
  const [folioTagging,     setFolioTagging]     = useState(null)
  const [folioProfile,     setFolioProfile]     = useState(null)
  const [activeFolioId,    setActiveFolioId]    = useState(null)
  const [showFolioPicker,  setShowFolioPicker]  = useState(false)
  const [pendingCallToken, setPendingCallToken] = useState(null)

  // Load my folios + profile when authed
  useEffect(() => {
    if (!isAuthed || !authToken) return
    // Load all my folios
    fetch(`${BACKEND_URL}/api/folios/mine`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(rows => {
        if (!Array.isArray(rows)) return
        setMyFolios(rows)
        // Set default active folio to first one
        if (rows.length > 0 && !activeFolioId) setActiveFolioId(rows[0].id)
      }).catch(() => {})
    // Load profile
    fetch(`${BACKEND_URL}/api/folio/profile`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(profile => { if (profile?.wallet_address) setFolioProfile(profile) })
      .catch(() => {})
    // Load all called addresses for 🎯 button state
    fetch(`${BACKEND_URL}/api/folio/mine`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(rows => {
        if (!Array.isArray(rows)) return
        setFolioCallAddrs(new Set(rows.map(r => r.token_address)))
      }).catch(() => {})
  }, [isAuthed, authToken]) // eslint-disable-line

  // Create a new folio
  const handleCreateFolio = useCallback(async (name) => {
    if (!authToken) return
    try {
      const res = await fetch(`${BACKEND_URL}/api/folios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: name || 'New Folio', public: true }),
      })
      const newFolio = await res.json()
      if (newFolio.id) {
        setMyFolios(prev => [...prev, { ...newFolio, call_count: 0 }])
        setActiveFolioId(newFolio.id)
      }
    } catch {}
  }, [authToken])

  // Internal add-call helper (not a hook — plain async fn used inside callbacks)
  const doAddCall = async (token, folioId, token_authToken) => {
    const address = token.address || token.token_address
    const body = {
      token_address: address, symbol: token.symbol, name: token.name,
      logo_url: token.logoUrl || token.logo_url || null,
      price_at_call: token.priceUsd || token.price_at_call || null,
      mcap_at_call: token.marketCap || token.mcap || token.mcap_at_call || null,
      folio_id: folioId,
    }
    await fetch(`${BACKEND_URL}/api/folio/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token_authToken}` },
      body: JSON.stringify(body),
    }).catch(() => {})
    setFolioCallAddrs(prev => new Set([...prev, address]))
    setMyFolios(prev => prev.map(f => f.id === folioId ? { ...f, call_count: (f.call_count || 0) + 1 } : f))
  }

  // Handle 🎯 click — if _targetFolioId set, add to that folio directly
  // If multiple folios, show picker; if one, add directly; if none, create default
  const handleFolioCall = useCallback(async (token) => {
    if (!isAuthed || !authToken) return
    const address = token.address || token.token_address
    const alreadyCalled = folioCallAddrs.has(address)
    if (alreadyCalled) {
      await fetch(`${BACKEND_URL}/api/folio/call/${address}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
      }).catch(() => {})
      setFolioCallAddrs(prev => { const s = new Set(prev); s.delete(address); return s })
      setMyFolios(prev => prev.map(f => ({ ...f, call_count: Math.max(0, (f.call_count || 0) - 1) })))
    } else if (token._targetFolioId) {
      // Called from FolioCard search — add to specific folio
      await doAddCall(token, token._targetFolioId, authToken)
    } else if (myFolios.length === 0) {
      const res = await fetch(`${BACKEND_URL}/api/folios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: 'My Folio', public: true }),
      }).catch(() => null)
      if (res?.ok) {
        const newFolio = await res.json()
        setMyFolios([{ ...newFolio, call_count: 0 }])
        setActiveFolioId(newFolio.id)
        await doAddCall(token, newFolio.id, authToken)
      }
    } else if (myFolios.length === 1) {
      await doAddCall(token, myFolios[0].id, authToken)
    } else {
      setPendingCallToken(token)
      setShowFolioPicker(true)
    }
  }, [isAuthed, authToken, folioCallAddrs, myFolios]) // eslint-disable-line

  const handleFolioPickerSelect = useCallback(async (folioId) => {
    setShowFolioPicker(false)
    if (pendingCallToken && authToken) {
      await doAddCall(pendingCallToken, folioId, authToken)
      setPendingCallToken(null)
    }
  }, [pendingCallToken, authToken]) // eslint-disable-line

  const handleFolioSearch = useCallback(async (q) => {
    setFolioSearch(q)
    if (q.length < 2) { setFolioSearchRes([]); return }
    setFolioSearching(true)
    try {
      const r = await fetch(`${BACKEND_URL}/api/folio/search?q=${encodeURIComponent(q)}`)
      const data = await r.json()
      setFolioSearchRes(Array.isArray(data) ? data : [])
    } catch { setFolioSearchRes([]) }
    setFolioSearching(false)
  }, [])

  const handleFolioTag = useCallback(async (address, tag) => {
    setFolioTagging(null)
    try {
      await fetch(`${BACKEND_URL}/api/folio/call/${address}/tag`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ narrative_tag: tag }),
      })
    } catch {}
  }, [authToken])

  const handleFolioLeaderboard = useCallback(() => {
    setFolioLoading(true)
    fetch(`${BACKEND_URL}/api/folio/leaderboard`)
      .then(r => r.json())
      .then(data => { setFolioLeaderboard(data.wallets || []); setFolioLoading(false) })
      .catch(() => setFolioLoading(false))
  }, [])

  const handleSaveFolioName = useCallback(async () => {}, []) // kept for compat

  const [showSettings, setShowSettings] = useState(false)
  const [selectedAlpha, setSelectedAlpha] = useState(null)
  const [customAlphaQuery,   setCustomAlphaQuery]   = useState('')
  const [customAlphaLoading, setCustomAlphaLoading] = useState(false)
  const [customAlphaError,   setCustomAlphaError]   = useState('')
  const [searchResults,      setSearchResults]      = useState([])
  const clearAlphaBoardSearch = useRef(null) // set by AlphaBoard

  const handleSearchCustomAlpha = async (query) => {
    if (!query.trim()) return
    setCustomAlphaLoading(true)
    setCustomAlphaError('')
    setSearchResults([])
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query.trim())}`)
      const data = await res.json()
      const solanaPairs = (data.pairs || []).filter(p => p.chainId === 'solana')
      const q = query.trim().toLowerCase()

      if (!solanaPairs.length) {
        setCustomAlphaError(`No Solana token found for "${query}"`)
        return
      }

      // Score each pair for relevance — higher = better match
      const scored = solanaPairs.map(p => {
        const sym  = (p.baseToken?.symbol || '').toLowerCase()
        const name = (p.baseToken?.name   || '').toLowerCase()
        const addr = (p.baseToken?.address || '')
        let score  = 0

        // Exact address match — always wins
        if (addr === query.trim())        score += 1000
        // Exact symbol match
        if (sym  === q)                   score += 100
        // Symbol starts with query
        if (sym.startsWith(q))            score += 50
        // Name exact match
        if (name === q)                   score += 80
        // Name contains query
        if (name.includes(q))             score += 30
        // Symbol contains query
        if (sym.includes(q))              score += 20
        // Boost by liquidity (log scale so it doesn't dominate)
        const liq = p.liquidity?.usd || 0
        if (liq > 0) score += Math.log10(liq) * 2

        return { pair: p, score }
      })

      // Sort by score desc, deduplicate by token address, take top 8
      const seen = new Set()
      const topResults = scored
        .sort((a, b) => b.score - a.score)
        .filter(({ pair }) => {
          const addr = pair.baseToken?.address
          if (!addr || seen.has(addr)) return false
          seen.add(addr)
          return true
        })
        .slice(0, 8)
        .map(({ pair }) => ({
          id:             pair.baseToken.address,
          address:        pair.baseToken.address,
          symbol:         pair.baseToken.symbol,
          name:           pair.baseToken.name,
          logoUrl:        pair.info?.imageUrl || null,
          dexUrl:         pair.url || `https://dexscreener.com/solana/${pair.baseToken.address}`,
          priceUsd:       parseFloat(pair.priceUsd) || 0,
          priceChange24h: parseFloat(pair.priceChange?.h24) || 0,
          volume24h:      pair.volume?.h24 || 0,
          marketCap:      pair.marketCap || pair.fdv || 0,
          liquidity:      pair.liquidity?.usd || 0,
          ageDays:        pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 86400000) : '?',
          source:         'custom_search',
          isCustomSearch: true,
        }))

      // If exact address match — auto-select immediately, no picker needed
      if (query.trim().length >= 32 && topResults.length === 1) {
        setSelectedAlpha(topResults[0])
        setCustomAlphaQuery('')
        setSearchResults([])
        return
      }

      // If only one result total — auto-select
      if (topResults.length === 1) {
        setSelectedAlpha(topResults[0])
        setCustomAlphaQuery('')
        setSearchResults([])
        return
      }

      // Multiple results — show picker in BetaPanel
      // Do NOT clear the search bar — user needs to see what they searched
      setSearchResults(topResults)
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

  // Load flags from Supabase on mount — populates _flagsCache so
  // all synchronous getFlags() calls see shared community flag counts.
  useEffect(() => { loadAllFlags() }, [])

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
      <Navbar onListBeta={() => setShowListModal(true)} newRunners={newRunners} liveAlphas={appLiveAlphas} coolingAlphas={appCoolingAlphas} onSettings={() => setShowSettings(true)} onWalletConnect={() => setWalletModalVisible(true)} onWalletSignIn={handleWalletSignIn} onWalletSignOut={handleSignOut} isAuthed={isAuthed} isConnected={connected} walletAddress={authWallet} />
      <NarrativeTicker liveAlphas={appLiveAlphas} sznCards={appSznCards} />
      <div className="main-layout" style={{ flex: 1, overflow: 'hidden' }}>
        <AlphaBoard selectedAlpha={selectedAlpha} onSelect={handleSelectAlpha} onNewRunners={handleNewRunners} onLiveAlphas={setAppLiveAlphas} onSznCards={setAppSznCards} onCoolingAlphas={setAppCoolingAlphas} onCustomSearch={handleSearchCustomAlpha} customAlphaLoading={customAlphaLoading} onRegisterClearSearch={fn => { clearAlphaBoardSearch.current = fn }} alphaListRef={alphaListRef} searchResults={searchResults} onSelectSearchResult={(token) => { if (!token) { setSearchResults([]); return }; setSelectedAlpha(token); setSearchResults([]) }} defaultTab={settings.defaultTab} authToken={authToken} isAuthed={isAuthed} authWallet={authWallet} onFolioCall={handleFolioCall} folioCallAddrs={folioCallAddrs} folioLeaderboard={folioLeaderboard} folioLoading={folioLoading} folioView={folioView} setFolioView={setFolioView} folioSaveMsg={folioSaveMsg} myFolios={myFolios} setMyFolios={setMyFolios} folioSearch={folioSearch} folioSearchRes={folioSearchRes} folioSearching={folioSearching} onSaveFolioName={handleSaveFolioName} onFolioSearch={handleFolioSearch} onFolioLeaderboard={handleFolioLeaderboard} folioTagging={folioTagging} setFolioTagging={setFolioTagging} onFolioTag={handleFolioTag} folioProfile={folioProfile} onCreateFolio={handleCreateFolio} activeFolioId={activeFolioId} setActiveFolioId={setActiveFolioId} />
        {isSzn
          ? <SznPanel  szn={selectedAlpha}   onListBeta={() => setShowListModal(true)} onOpenDrawer={setDrawerToken} />
          : <BetaPanel alpha={selectedAlpha} liveAlphas={appLiveAlphas} onListBeta={() => setShowListModal(true)} onOpenDrawer={setDrawerToken} onSwap={(t) => openJupiterSwap(t)} onScrollToAlpha={handleScrollToAlpha} onCustomSearch={handleSearchCustomAlpha} customAlphaLoading={customAlphaLoading} customAlphaError={customAlphaError} settings={settings} />
        }
      </div>

      {/* Folio picker — shown when 🎯 clicked with multiple folios */}
      {showFolioPicker && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 99998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowFolioPicker(false)}>
          <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 16, padding: 20, minWidth: 280, maxWidth: 360 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Add to which folio?</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginBottom: 16 }}>
              {pendingCallToken?.symbol ? `$${pendingCallToken.symbol}` : 'Token'} will be added with entry price locked
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {myFolios.map(f => (
                <button key={f.id} onClick={() => handleFolioPickerSelect(f.id)} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
                  padding: '10px 14px', cursor: 'pointer', transition: 'all 0.15s',
                  fontFamily: 'var(--font-mono)', color: 'var(--text-primary)',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(57,255,20,0.4)'; e.currentTarget.style.background = 'rgba(57,255,20,0.05)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surface-2)' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{f.name || `Folio #${f.id}`}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{f.call_count || 0} calls</div>
                  </div>
                  <span style={{ color: 'var(--neon-green)', fontSize: 14 }}>🎯</span>
                </button>
              ))}
              <button onClick={() => handleCreateFolio('New Folio').then(() => handleFolioPickerSelect(myFolios[myFolios.length - 1]?.id))} style={{
                padding: '8px 14px', borderRadius: 10, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700,
                cursor: 'pointer', background: 'transparent', border: '1px dashed var(--border)', color: 'var(--text-muted)',
              }}>+ Create new folio</button>
            </div>
          </div>
        </div>,
        document.body
      )}

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
            onSwap={(t) => { setDrawerToken(null); openJupiterSwap(t) }}
          />
        </>,
        document.body
      )}

      <AppFooter />
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onUpdate={updateSetting}
          onReset={resetSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}