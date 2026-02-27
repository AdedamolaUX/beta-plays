import { useState, useMemo, useCallback, useRef } from 'react'
import useAlphas from './hooks/useAlphas'
import useBetas, { getSignal, getWavePhase, getMcapRatio } from './hooks/useBetas'
import useParentAlpha from './hooks/useParentAlpha'
import useNarrativeSzn from './hooks/useNarrativeSzn'
import useBirdeye from './hooks/useBirdeye'
import './index.css'

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
  if (n < 0.0001) return `$${n.toExponential(2)}`
  if (n < 1)      return `$${n.toFixed(6)}`
  return `$${n.toFixed(4)}`
}

const shortAddress = (addr) =>
  addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : ''

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

// ─── Navbar ─────────────────────────────────────────────────────

const Navbar = ({ onListBeta }) => (
  <nav className="navbar">
    <div className="navbar-brand">
      <div className="brand-logo">β</div>
      <span className="brand-name">Beta<span>Plays</span></span>
    </div>
    <div className="navbar-status">
      <span className="status-dot"></span>
      LIVE · SOLANA
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
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
            momentum
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: momentum >= 60 ? 'var(--neon-green)' : 'var(--text-muted)' }}>
            {momentum}% green
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
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: 'var(--neon-green)' }}>
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
const PositioningCard = ({ alpha, isSelected, onClick }) => {
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
              <div className="token-address">{shortAddress(alpha.address)}</div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>
                {alpha.ageDays}d ago
              </span>
            </div>
          </div>
        </div>
        {/* DEX link */}
        <span
          onClick={e => { e.stopPropagation(); window.open(alpha.dexUrl || `https://dexscreener.com/solana/${alpha.address}`, '_blank') }}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.08)' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--cyan)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
        >DEX ↗</span>
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

const AlphaCard = ({ alpha, isSelected, onClick }) => {
  const change     = parseFloat(alpha.priceChange24h) || 0
  const isPositive = change >= 0
  const derivative = isDerivative(alpha.symbol)

  return (
    <div className={`card alpha-card ${isSelected ? 'active' : ''}`} onClick={onClick}>
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
                <span className="badge badge-new" style={{ fontSize: 7, padding: '1px 5px' }}>DERIV</span>
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
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div className="token-address">{shortAddress(alpha.address)}</div>
              {alpha.coolingLabel && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: alpha.isDumped ? 'var(--red)' : 'var(--cyan)' }}>
                  {alpha.coolingLabel}
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
          {/* DEX link — separate from select click */}
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
            title="Open on DEXScreener"
          >
            DEX ↗
          </span>
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
      </div>
    </div>
  )
}

// ─── Alpha Board ─────────────────────────────────────────────────

const AlphaBoard = ({ selectedAlpha, onSelect }) => {
  const [activeTab,    setActiveTab]    = useState('live')
  const [searchQuery,  setSearchQuery]  = useState('')
  const { liveAlphas, coolingAlphas, positioningAlphas, legends, loading, isRefreshing, error, lastUpdated, refresh } = useAlphas()
  const sznCards = useNarrativeSzn(liveAlphas)

  const rawList =
    activeTab === 'live'        ? liveAlphas        :
    activeTab === 'cooling'     ? coolingAlphas     :
    activeTab === 'positioning' ? positioningAlphas :
    legends

  // Apply search filter across all tabs
  const displayList = useMemo(() =>
    searchQuery ? rawList.filter(a => matchesSearch(a, searchQuery)) : rawList,
    [rawList, searchQuery]
  )

  // Also filter szn cards
  const filteredSzn = useMemo(() =>
    searchQuery
      ? sznCards.filter(s =>
          s.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.tokens.some(t => matchesSearch(t, searchQuery))
        )
      : sznCards,
    [sznCards, searchQuery]
  )

  const isEmpty = !loading && displayList.length === 0

  const tabs = [
    { key: 'live',        label: '🔥 Live',     count: liveAlphas.length        },
    { key: 'cooling',     label: '❄️ Cool',     count: coolingAlphas.length     },
    { key: 'positioning', label: '🎯 Position', count: positioningAlphas.length },
    { key: 'legends',     label: '🏆 OGs',      count: legends.length           },
  ]

  return (
    <aside className="alpha-board">
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
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>🔍</span>
          <input
            type="text"
            placeholder="Search runners..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              fontFamily: 'var(--font-mono)', fontSize: 11,
              color: 'var(--text-primary)', width: '100%',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 12, padding: 0, lineHeight: 1,
              }}
            >✕</button>
          )}
        </div>
      </div>

      {/* Tabs — single row, compact */}
      <div style={{
        display: 'flex', gap: 2,
        background: 'var(--surface-2)', padding: 3,
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        {tabs.map(({ key, label, count }) => (
          <button
            key={key}
            className={`tab-btn ${activeTab === key ? 'active' : ''}`}
            onClick={() => { setActiveTab(key); setSearchQuery('') }}
            style={{ flex: 1, textAlign: 'center' }}
          >
            {label}
            {count > 0 && (
              <span style={{
                marginLeft: 2, fontSize: 7,
                color: activeTab === key ? 'var(--neon-green)' : 'var(--text-muted)',
              }}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab descriptions */}
      {!searchQuery && (
        <div style={{ flexShrink: 0, paddingBottom: 4 }}>
          {activeTab === 'live' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Tokens with positive price action right now.
            </p>
          )}
          {activeTab === 'cooling' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)', lineHeight: 1.5 }}>
              Tokens down in the last 24h — retracing or consolidating. Watch for second leg entry.
            </p>
          )}
          {activeTab === 'positioning' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)', lineHeight: 1.5 }}>
              Big peak. Big drawdown. Volume still alive. These are the second-leg setups degens hunt.
              {positioningAlphas.length === 0 && ' Populates as tokens peak and retrace — check back after the next wave.'}
            </p>
          )}
          {activeTab === 'legends' && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)', lineHeight: 1.5 }}>
              Established narrative anchors. Still spawn betas when they move.
            </p>
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

      <div className="alpha-list">
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
            <div className="empty-state-title">No retracing tokens right now.</div>
            <div className="empty-state-sub">
              Everything is either pumping or dead. Check back after the market moves.
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('legends')} style={{ marginTop: 12 }}>
              View Legends
            </button>
          </div>
        )}

        {!loading && isEmpty && searchQuery && (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <div className="empty-state-title">No results for "{searchQuery}"</div>
            <div className="empty-state-sub">Try a different symbol or name.</div>
            <button className="btn btn-ghost btn-sm" onClick={() => setSearchQuery('')} style={{ marginTop: 12 }}>
              Clear Search
            </button>
          </div>
        )}

        {/* Szn cards — live tab only, hidden when searching */}
        {!loading && activeTab === 'live' && !searchQuery && filteredSzn.length > 0 && (
          <>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
              color: 'var(--text-muted)', textTransform: 'uppercase',
              letterSpacing: 1, padding: '4px 0 6px',
            }}>🌊 Active Narratives</div>
            {filteredSzn.map((szn) => (
              <SznCard
                key={szn.id}
                szn={szn}
                isSelected={selectedAlpha?.id === szn.id}
                onClick={() => onSelect(szn)}
              />
            ))}
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
              color: 'var(--text-muted)', textTransform: 'uppercase',
              letterSpacing: 1, padding: '10px 0 6px',
              borderTop: '1px solid var(--border)',
            }}>🔥 Individual Runners</div>
          </>
        )}

        {!loading && displayList.map((alpha) => (
          activeTab === 'positioning'
            ? <PositioningCard
                key={alpha.id || alpha.address}
                alpha={alpha}
                isSelected={selectedAlpha?.id === alpha.id}
                onClick={() => onSelect(alpha)}
              />
            : <AlphaCard
                key={alpha.id}
                alpha={alpha}
                isSelected={selectedAlpha?.id === alpha.id}
                onClick={() => onSelect(alpha)}
              />
        ))}
      </div>
    </aside>
  )
}

// ─── Signal Badge ────────────────────────────────────────────────

const SignalBadge = ({ beta }) => {
  const signal = getSignal(beta)
  const classMap = {
    CABAL:    'badge-cabal',
    TRENDING: 'badge-strong',
    STRONG:   'badge-strong',
    LORE:     'badge-weak',
    WEAK:     'badge-weak',
    LP_PAIR:  'badge-cabal',
    AI:       'badge-verified',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
      {beta.tokenClass && (
        <span
          className={`badge ${beta.tokenClass === 'OG' ? 'badge-verified' : beta.tokenClass === 'RIVAL' ? 'badge-cabal' : 'badge-weak'}`}
          style={{ fontSize: 8, padding: '2px 6px' }}
        >
          {beta.tokenClass === 'OG' ? '👑 OG' : beta.tokenClass === 'RIVAL' ? '⚔️ RIVAL' : '🌀 SPIN'}
        </span>
      )}
      <span className={`badge ${classMap[signal.label] || 'badge-weak'}`} style={{ fontSize: 8, padding: '2px 6px' }}>
        {signal.label === 'CABAL'    ? '🕵️ CABAL'   :
         signal.label === 'TRENDING' ? '🔥 TRENDING' :
         signal.label === 'LP_PAIR'  ? '🔗 LP PAIR'  :
         signal.label === 'AI'       ? '🤖 AI MATCH' : signal.label}
      </span>
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
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, color, letterSpacing: 0.5 }}>
      {ratio >= 1000 ? `${(ratio / 1000).toFixed(1)}Kx` : `${ratio}x`} room
    </span>
  )
}

// ─── Beta Row ────────────────────────────────────────────────────

const BetaRow = ({ beta, alpha, isPinned, trenchOnly, onOpenDrawer }) => {
  const change     = parseFloat(beta.priceChange24h) || 0
  const isPositive = change >= 0
  const wave       = getWavePhase(alpha, beta)
  const isTrench   = (beta.marketCap || 0) < 100_000
  const isLPPair   = beta.signalSources?.includes('lp_pair')
  const flags      = getFlags()[beta.address] || null
  const rugWarn    = flags && flags.rug >= 3
  const honeyWarn  = flags && flags.honeypot >= 3

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
            {isLPPair       && <span className="badge badge-cabal"     style={{ fontSize: 7, padding: '1px 4px' }}>🔗 PAIRED</span>}
            {isTrench       && <span className="badge badge-new"      style={{ fontSize: 7, padding: '1px 4px' }}>⛏️ TRENCH</span>}
            {(rugWarn || honeyWarn) && (
              <span className="badge" style={{ fontSize: 7, padding: '1px 4px', background: 'rgba(255,68,102,0.15)', borderColor: 'rgba(255,68,102,0.4)', color: 'var(--red)' }}>
                {rugWarn ? '⚠️ RUG' : '⚠️ HONEY'}
              </span>
            )}
            {isPinned       && <span className="badge badge-verified" style={{ fontSize: 7, padding: '1px 4px' }}>DEV VERIFIED</span>}
            {beta.isSibling && <span className="badge badge-cabal"    style={{ fontSize: 7, padding: '1px 4px', opacity: 0.85 }}>👥 SIBLING</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
            <span className="token-address">{shortAddress(beta.address)}</span>
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
      <span className={`mono token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 12 }}>
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
        marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8,
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
            <div className="token-address">{shortAddress(parent.address)}</div>
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

const SznPanel = ({ szn, onListBeta }) => {
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
              onClick={() => window.open(`https://dexscreener.com/solana/${token.pairAddress || token.address}`, '_blank')}
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
              <span className={`mono token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 12 }}>
                {isPositive ? '+' : ''}{change.toFixed(1)}%
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
              <span className="badge badge-strong" style={{ fontSize: 8, padding: '2px 6px' }}>🌊 SZN</span>
            </div>
          )
        })}
      </div>
    </section>

    {/* Token detail drawer */}
    {drawerToken && (
      <>
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 199, background: 'rgba(0,0,0,0.4)' }}
          onClick={() => setDrawerToken(null)}
        />
        <TokenDrawer
          token={drawerToken}
          alpha={alpha}
          onClose={() => setDrawerToken(null)}
        />
      </>
    )}
  )
}

// ─── Beta Panel ──────────────────────────────────────────────────

const BetaPanel = ({ alpha, onListBeta }) => {
  const { parent, loading: parentLoading }               = useParentAlpha(alpha)
  const { betas, loading: betasLoading, error, refresh } = useBetas(alpha, parent)
  const { birdeye }                                       = useBirdeye(alpha?.address)
  const [trenchOnly,   setTrenchOnly]   = useState(false)
  const [mcapFilter,   setMcapFilter]   = useState('all')
  const [drawerToken,  setDrawerToken]  = useState(null)

  const mcapFilterFn = {
    all:   () => true,
    large: (b) => (b.marketCap || 0) >= 10_000_000,
    mid:   (b) => (b.marketCap || 0) >= 1_000_000  && (b.marketCap || 0) < 10_000_000,
    small: (b) => (b.marketCap || 0) >= 100_000    && (b.marketCap || 0) < 1_000_000,
    micro: (b) => (b.marketCap || 0) < 100_000,
  }

  const filteredBetas = betas.filter(mcapFilterFn[mcapFilter])
  const trenchCount   = betas.filter(b => (b.marketCap || 0) < 100_000).length

  return (
    <section className="beta-panel">
      <div className="beta-panel-header">
        <div className="beta-panel-title-group">
          <h1 className="beta-panel-title">
            {alpha ? `Beta Plays for $${alpha.symbol}` : 'Select a Runner'}
          </h1>
          <p className="beta-panel-subtitle">
            {alpha
              ? <span>Surfacing derivative tokens for <span style={{ color: 'var(--neon-green)' }}>${alpha.symbol}</span> — sorted by 24h gain</span>
              : 'Pick a runner from the left panel to surface its beta plays'}
          </p>
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
          <div className="empty-state-sub">Select a runner from the left panel to surface its beta plays.</div>
        </div>
      ) : (
        <>
          {parentLoading && <div className="skeleton" style={{ height: 100, borderRadius: 10, marginBottom: 8 }} />}
          {!parentLoading && parent && <ParentAlphaCard parent={parent} />}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
              {[['all','All'],['large','>$10M'],['mid','$1M-10M'],['small','$100K-1M'],['micro','<$100K']].map(([key, label]) => (
                <button key={key} className={`tab-btn ${mcapFilter === key ? 'active' : ''}`} onClick={() => setMcapFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
            <button
              className={`btn btn-sm ${trenchOnly ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTrenchOnly(!trenchOnly)}
            >
              ⛏️ TRENCH {trenchCount > 0 && `(${trenchCount})`}
            </button>
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
            <span className="badge badge-verified" style={{ fontSize: 8, padding: '2px 6px' }}>👑 OG</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>=original</span>
            <span className="badge badge-cabal"    style={{ fontSize: 8, padding: '2px 6px', marginLeft: 6 }}>⚔️ RIVAL</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>=challenging throne</span>
            <span className="badge badge-weak"     style={{ fontSize: 8, padding: '2px 6px', marginLeft: 6 }}>🌀 SPIN</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>=riding narrative</span>
            <span className="badge badge-cabal"    style={{ fontSize: 8, padding: '2px 6px', marginLeft: 6 }}>🕵️ CABAL</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>=multi-signal</span>
            <span className="badge badge-cabal"    style={{ fontSize: 8, padding: '2px 6px', marginLeft: 6 }}>🔗 LP PAIR</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>=direct pair</span>
            <span className="badge badge-verified"  style={{ fontSize: 8, padding: '2px 6px', marginLeft: 6 }}>🤖 AI MATCH</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>=semantic match</span>
          </div>

          {/* Wave timing legend */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Timing:</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--neon-green)',     fontWeight: 700 }}>🌊 WAVE &lt;6h</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--amber)',          fontWeight: 700 }}>📈 2ND LEG 6-24h</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)', fontWeight: 700 }}>🕐 LATE 1-7d</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)',     fontWeight: 700 }}>🧊 COLD 7d+</span>
          </div>

          {/* Beta table */}
          <div className="beta-table">
            <div className="beta-table-header">
              <span>Token</span><span>MCAP / Room</span><span>24h Vol</span><span>24h %</span><span>Age</span><span>Signal</span>
            </div>

            {betasLoading && (
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

            {!betasLoading && filteredBetas.map((beta, i) => (
              <BetaRow
                key={beta.id || i}
                beta={beta}
                alpha={alpha}
                isPinned={false}
                trenchOnly={trenchOnly}
                onOpenDrawer={setDrawerToken}
              />
            ))}

            {!betasLoading && trenchOnly && trenchCount === 0 && (
              <div className="empty-state" style={{ marginTop: 24 }}>
                <div className="empty-state-icon">⛏️</div>
                <div className="empty-state-title">No trench plays found.</div>
                <div className="empty-state-sub">All detected betas are above $100K mcap.</div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
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
    if (!flags[address]) flags[address] = { rug: 0, honeypot: 0, legit: 0, symbol }
    flags[address][flagType] = (flags[address][flagType] || 0) + 1
    flags[address].lastFlagged = Date.now()
    localStorage.setItem(FLAG_STORE_KEY, JSON.stringify(flags))
    return flags[address]
  } catch { return null }
}

const FlagButton = ({ address, symbol, compact = false }) => {
  const [counts, setCounts]   = useState(() => getFlags()[address] || null)
  const [voted,  setVoted]    = useState(false)
  const [open,   setOpen]     = useState(false)

  const handleFlag = (e, flagType) => {
    e.stopPropagation()
    const result = submitFlag(address, flagType, symbol)
    setCounts(result)
    setVoted(true)
    setOpen(false)
  }

  const total   = counts ? (counts.rug + counts.honeypot + counts.legit) : 0
  const topFlag = counts && total > 0
    ? (counts.rug >= counts.honeypot && counts.rug >= counts.legit ? 'rug'
    : counts.honeypot >= counts.legit ? 'honeypot' : 'legit')
    : null
  const rugWarn = topFlag === 'rug' && counts.rug >= 3
  const honeyWarn = topFlag === 'honeypot' && counts.honeypot >= 3

  if (compact) return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {(rugWarn || honeyWarn) && (
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 7, fontWeight: 700,
          color: 'var(--red)', border: '1px solid rgba(255,68,102,0.4)',
          borderRadius: 3, padding: '1px 4px', marginRight: 4,
        }}>
          {rugWarn ? '⚠️ RUG' : '⚠️ HONEYPOT'} ({topFlag === 'rug' ? counts.rug : counts.honeypot})
        </span>
      )}
      {!voted && (
        <span
          onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)',
            cursor: 'pointer', padding: '1px 4px', borderRadius: 3,
            border: '1px solid rgba(255,255,255,0.08)',
          }}
          title="Flag this token"
        >🚩</span>
      )}
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', zIndex: 100,
          background: 'var(--surface-2)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8, padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
          minWidth: 110, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', padding: '0 2px' }}>Flag as:</span>
          {[['rug', '🪤 Rug pull', 'var(--red)'], ['honeypot', '🍯 Honeypot', 'var(--amber)'], ['legit', '✅ Legit', 'var(--neon-green)']].map(([type, label, color]) => (
            <button key={type} onClick={e => handleFlag(e, type)} style={{
              background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--font-mono)', fontSize: 9, color, padding: '3px 6px',
              borderRadius: 4, transition: 'background 0.1s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >{label}</button>
          ))}
        </div>
      )}
    </div>
  )
  return null
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
  const totalFlags = flags ? flags.rug + flags.honeypot + flags.legit : 0

  return (
    <div
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: 320, zIndex: 200,
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
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
              {token.name}
            </div>
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
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>PRICE ACTION</div>
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
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color }}>
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
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>{val}</div>
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
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--cyan)', fontWeight: 700 }}>{birdeye.holderCount.toLocaleString()}</div>
                </div>
              )}
              {birdeye.concentration && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>TOP 10 OWN</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: birdeye.concentration.riskColor, fontWeight: 700 }}>
                    {birdeye.concentration.top10Pct}% <span style={{ fontSize: 8 }}>({birdeye.concentration.risk})</span>
                  </div>
                </div>
              )}
              {birdeye.buyRatio != null && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>BUY PRESSURE</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                    color: birdeye.buyRatio >= 0.6 ? 'var(--neon-green)' : birdeye.buyRatio <= 0.4 ? 'var(--red)' : 'var(--amber)' }}>
                    {Math.round(birdeye.buyRatio * 100)}%
                  </div>
                </div>
              )}
              {birdeye.uniqueMakers != null && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)' }}>MAKERS 24H</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>
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
            {(token.signalSources || '').split(',').filter(Boolean).map(s => (
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

        {/* Community flags */}
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>🚩 COMMUNITY FLAGS</div>
          {totalFlags > 0 ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              {flags.rug > 0 && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--red)' }}>🪤 Rug: {flags.rug}</div>}
              {flags.honeypot > 0 && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--amber)' }}>🍯 Honeypot: {flags.honeypot}</div>}
              {flags.legit > 0 && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neon-green)' }}>✅ Legit: {flags.legit}</div>}
            </div>
          ) : (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginBottom: 8 }}>No flags yet — be the first</div>
          )}
          <FlagButton address={token.address} symbol={token.symbol} />
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
        </div>

      </div>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────

export default function App() {
  const [selectedAlpha, setSelectedAlpha] = useState(null)
  const [showListModal, setShowListModal]  = useState(false)
  const isSzn = selectedAlpha?.isSzn === true

  return (
    <div className="app-wrapper">
      <Navbar onListBeta={() => setShowListModal(true)} />
      <div className="main-layout">
        <AlphaBoard selectedAlpha={selectedAlpha} onSelect={setSelectedAlpha} />
        {isSzn
          ? <SznPanel  szn={selectedAlpha}   onListBeta={() => setShowListModal(true)} />
          : <BetaPanel alpha={selectedAlpha} onListBeta={() => setShowListModal(true)} />
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
    </div>
  )
}