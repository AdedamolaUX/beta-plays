import { useState } from 'react'
import useAlphas from './hooks/useAlphas'
import useBetas, { getSignal } from './hooks/useBetas'
import useParentAlpha from './hooks/useParentAlpha'
import { extractRootCandidates } from './hooks/useParentAlpha'
import useNarrativeSzn from './hooks/useNarrativeSzn'
import './index.css'

// ─── Helpers ────────────────────────────────────────────────────

const formatNum = (num) => {
  if (!num || num === 0) return '—'
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`
  return `$${num.toFixed(2)}`
}

const formatPrice = (price) => {
  if (!price) return '—'
  const n = parseFloat(price)
  if (n < 0.0001) return `$${n.toExponential(2)}`
  if (n < 1) return `$${n.toFixed(6)}`
  return `$${n.toFixed(4)}`
}

const shortAddress = (addr) =>
  addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : ''

// ─── Derivative Detection ────────────────────────────────────────
// Only flag as derivative if symbol has a known degen prefix or suffix.
// Clean original tickers like $PUMP, $RETURN, $TRENCH are never tagged.

const KNOWN_PREFIXES = [
  'BABY', 'MINI', 'MICRO', 'GIGA', 'MEGA', 'SUPER', 'BASED',
  'REAL', 'TURBO', 'CHAD', 'FAT', 'TINY', 'LITTLE', 'BIG',
]

const KNOWN_SUFFIXES = [
  'KIN', 'INU', 'WIF', 'HAT', 'CAT', 'DOG', 'AI',
  'DAO', 'MOON', 'PUMP', 'WIFHAT', 'WIFCAT',
]

const isDerivative = (symbol) => {
  const s = symbol.toUpperCase()
  const hasPrefix = KNOWN_PREFIXES.some(
    (p) => s.startsWith(p) && s.length > p.length + 1
  )
  const hasSuffix = KNOWN_SUFFIXES.some(
    (sfx) => s.endsWith(sfx) && s.length > sfx.length + 1
  )
  return hasPrefix || hasSuffix
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
  const isPositive = szn.avgChange >= 0
  const topThree = szn.tokens.slice(0, 3)

  return (
    <div
      className={`card szn-card ${isSelected ? 'active' : ''}`}
      onClick={onClick}
      style={{
        background: isSelected ? 'rgba(0,212,255,0.08)' : 'rgba(0,212,255,0.03)',
        borderColor: isSelected ? 'var(--cyan)' : 'rgba(0,212,255,0.2)',
        marginBottom: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>{szn.label.split(' ')[0]}</span>
          <div>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 800,
              fontSize: 14, color: 'var(--cyan)',
            }}>
              {szn.label.split(' ').slice(1).join(' ')} Szn
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
              {szn.tokenCount} tokens · {formatNum(szn.totalVolume)} vol
            </div>
          </div>
        </div>
        <div className={`token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 13 }}>
          {isPositive ? '+' : ''}{szn.avgChange.toFixed(1)}% avg
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {topThree.map((t) => (
          <div key={t.id} style={{
            flex: 1, background: 'rgba(255,255,255,0.04)',
            borderRadius: 6, padding: '4px 6px',
            fontFamily: 'var(--font-mono)', fontSize: 9,
          }}>
            <div style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>${t.symbol}</div>
            <div style={{
              color: (parseFloat(t.priceChange24h) || 0) >= 0 ? 'var(--neon-green)' : 'var(--red)',
              fontSize: 8,
            }}>
              {(parseFloat(t.priceChange24h) || 0) >= 0 ? '+' : ''}
              {(parseFloat(t.priceChange24h) || 0).toFixed(0)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Alpha Token Card ────────────────────────────────────────────

const AlphaCard = ({ alpha, isSelected, onClick }) => {
  const change = parseFloat(alpha.priceChange24h) || 0
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="token-name">${alpha.symbol}</div>
              {derivative && (
                <span className="badge badge-new" style={{ fontSize: 7, padding: '1px 5px' }}>
                  DERIV
                </span>
              )}
            </div>
            <div className="token-address">{shortAddress(alpha.address)}</div>
          </div>
        </div>
        <div className={`token-change ${isPositive ? 'positive' : 'negative'}`}>
          {isPositive ? '+' : ''}{change.toFixed(1)}%
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
      {alpha.isHistorical && (
        <span className="badge badge-weak" style={{ marginTop: 4 }}>PAST ALPHA</span>
      )}
    </div>
  )
}

// ─── Alpha Board (Left Panel) ────────────────────────────────────

const AlphaBoard = ({ selectedAlpha, onSelect }) => {
  const [activeTab, setActiveTab] = useState('live')
  const { liveAlphas, historicalAlphas, loading, error, lastUpdated, refresh } = useAlphas()
  const sznCards = useNarrativeSzn(liveAlphas)

  const displayList = activeTab === 'live' ? liveAlphas : historicalAlphas
  const isEmpty = !loading && displayList.length === 0

  return (
    <aside className="alpha-board">
      <div className="alpha-board-header">
        <span className="alpha-board-title">🎯 Runners</span>
        <div className="tab-group">
          <button
            className={`tab-btn ${activeTab === 'live' ? 'active' : ''}`}
            onClick={() => setActiveTab('live')}
          >Live</button>
          <button
            className={`tab-btn ${activeTab === 'past' ? 'active' : ''}`}
            onClick={() => setActiveTab('past')}
          >Past</button>
        </div>
      </div>

      {lastUpdated && activeTab === 'live' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', flexShrink: 0 }}>
          <span className="mono text-muted" style={{ fontSize: 9 }}>
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={refresh}
            style={{ padding: '2px 8px', fontSize: 9 }}
          >↺ Refresh</button>
        </div>
      )}

      {error && (
        <div style={{
          background: 'rgba(255,68,102,0.08)',
          border: '1px solid rgba(255,68,102,0.3)',
          borderRadius: 6, padding: '8px 12px',
          fontSize: 11, color: 'var(--red)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}>{error}</div>
      )}

      <div className="alpha-list">
        {loading && (
          <>
            <div className="skeleton loading-row" />
            <div className="skeleton loading-row" />
            <div className="skeleton loading-row" />
          </>
        )}

        {!loading && isEmpty && activeTab === 'live' && (
          <div className="empty-state">
            <div className="empty-state-icon">📡</div>
            <div className="empty-state-title">No runners found in this sector right now.</div>
            <div className="empty-state-sub">Trenches might be cooked.</div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setActiveTab('past')}
              style={{ marginTop: 12 }}
            >View Past Alphas</button>
          </div>
        )}

        {/* Narrative Szn cards — live tab only */}
        {!loading && activeTab === 'live' && sznCards.length > 0 && (
          <>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
              color: 'var(--text-muted)', textTransform: 'uppercase',
              letterSpacing: 1, padding: '4px 0 6px', flexShrink: 0,
            }}>
              🌊 Active Narratives
            </div>
            {sznCards.map((szn) => (
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
              borderTop: '1px solid var(--border)', flexShrink: 0,
            }}>
              🔥 Individual Runners
            </div>
          </>
        )}

        {!loading && displayList.map((alpha) => (
          <AlphaCard
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

// ─── Signal + Class Badge ────────────────────────────────────────

const SignalBadge = ({ beta }) => {
  const signal = getSignal(beta)
  const classMap = {
    CABAL: 'badge-cabal',
    TRENDING: 'badge-strong',
    STRONG: 'badge-strong',
    LORE: 'badge-weak',
    WEAK: 'badge-weak',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
      {beta.tokenClass && (
        <span
          className={`badge ${
            beta.tokenClass === 'OG'    ? 'badge-verified' :
            beta.tokenClass === 'RIVAL' ? 'badge-cabal' : 'badge-weak'
          }`}
          style={{ fontSize: 8, padding: '2px 6px' }}
        >
          {beta.tokenClass === 'OG'    ? '👑 OG' :
           beta.tokenClass === 'RIVAL' ? '⚔️ RIVAL' : '🌀 SPIN'}
        </span>
      )}
      <span
        className={`badge ${classMap[signal.label] || 'badge-weak'}`}
        style={{ fontSize: 8, padding: '2px 6px' }}
      >
        {signal.label === 'CABAL'    ? '🕵️ CABAL' :
         signal.label === 'TRENDING' ? '🔥 TRENDING' : signal.label}
      </span>
    </div>
  )
}

// ─── Beta Row ────────────────────────────────────────────────────

const BetaRow = ({ beta, isPinned }) => {
  const change = parseFloat(beta.priceChange24h) || 0
  const isPositive = change >= 0

  return (
    <div
      className={`beta-row ${isPinned ? 'pinned' : ''}`}
      onClick={() => beta.dexUrl && window.open(beta.dexUrl, '_blank')}
    >
      <div className="token-info">
        <div className="token-icon" style={{ width: 28, height: 28, fontSize: 9 }}>
          {beta.logoUrl
            ? <img src={beta.logoUrl} alt={beta.symbol} />
            : beta.symbol.slice(0, 3)}
        </div>
        <div>
          <div style={{
            fontFamily: 'var(--font-display)', fontWeight: 700,
            fontSize: 13, color: 'var(--text-primary)'
          }}>
            ${beta.symbol}
            {isPinned && (
              <span className="badge badge-verified" style={{ marginLeft: 6 }}>DEV VERIFIED</span>
            )}
          </div>
          <div className="token-address">{shortAddress(beta.address)}</div>
        </div>
      </div>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>
        {formatNum(beta.marketCap)}
      </span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {formatNum(beta.volume24h)}
      </span>
      <span className={`mono token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 12 }}>
        {isPositive ? '+' : ''}{change.toFixed(1)}%
      </span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {beta.ageLabel}
      </span>
      <SignalBadge beta={beta} />
    </div>
  )
}

// ─── Parent Alpha Card ───────────────────────────────────────────

const ParentAlphaCard = ({ parent }) => {
  const change = parseFloat(parent.priceChange24h) || 0
  const isPositive = change >= 0

  return (
    <div
      onClick={() => parent.dexUrl && window.open(parent.dexUrl, '_blank')}
      style={{
        background: 'rgba(0, 212, 255, 0.04)',
        border: '1px solid rgba(0, 212, 255, 0.3)',
        borderRadius: 10, padding: '14px 16px',
        cursor: 'pointer', marginBottom: 8,
        transition: 'all 0.15s ease',
        flexShrink: 0,
      }}
    >
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
        color: 'var(--cyan)', letterSpacing: 1.5, textTransform: 'uppercase',
        marginBottom: 10,
      }}>
        🧬 Parent Alpha — Root of this narrative
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="token-info">
          <div className="token-icon" style={{ width: 40, height: 40, border: '1px solid rgba(0,212,255,0.4)' }}>
            {parent.logoUrl
              ? <img src={parent.logoUrl} alt={parent.symbol} />
              : parent.symbol.slice(0, 3)}
          </div>
          <div>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 800,
              fontSize: 16, color: 'var(--text-primary)',
            }}>
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
      <div style={{
        marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10,
        color: 'var(--text-muted)',
      }}>
        ⚠️ If parent dumps, this runner likely follows. Watch both.
      </div>
    </div>
  )
}

// ─── Szn Panel ───────────────────────────────────────────────────

const SznPanel = ({ szn, onListBeta }) => {
  const [sortBy, setSortBy] = useState('change')
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

  const displayed = [...szn.tokens]
    .filter(filterMap[mcapFilter])
    .sort(sortMap[sortBy])

  return (
    <section className="beta-panel">
      <div className="beta-panel-header">
        <div className="beta-panel-title-group">
          <h1 className="beta-panel-title">{szn.label} Szn</h1>
          <p className="beta-panel-subtitle">
            <span style={{ color: 'var(--cyan)' }}>{szn.tokenCount} tokens</span>
            {' '}running the narrative · avg{' '}
            <span style={{ color: szn.avgChange >= 0 ? 'var(--neon-green)' : 'var(--red)' }}>
              {szn.avgChange >= 0 ? '+' : ''}{szn.avgChange.toFixed(1)}%
            </span>
            {' '}24h
          </p>
        </div>
        <button className="btn btn-amber btn-sm" onClick={onListBeta}>⚡ List Beta</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
          {[['change', '24h %'], ['volume', 'Volume'], ['mcap', 'MCAP']].map(([key, label]) => (
            <button key={key} className={`tab-btn ${sortBy === key ? 'active' : ''}`} onClick={() => setSortBy(key)}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
          {[['all', 'All'], ['large', '>$10M'], ['mid', '$1M-10M'], ['micro', '<$1M']].map(([key, label]) => (
            <button key={key} className={`tab-btn ${mcapFilter === key ? 'active' : ''}`} onClick={() => setMcapFilter(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="beta-table">
        <div className="beta-table-header">
          <span>Token</span>
          <span>MCAP</span>
          <span>24h Vol</span>
          <span>24h %</span>
          <span>Age</span>
          <span>Signal</span>
        </div>

        {displayed.length === 0 && (
          <div className="empty-state" style={{ marginTop: 24 }}>
            <div className="empty-state-icon">🔍</div>
            <div className="empty-state-title">No tokens match this filter.</div>
            <div className="empty-state-sub">Try a different MCAP range.</div>
          </div>
        )}

        {displayed.map((token, i) => {
          const change = parseFloat(token.priceChange24h) || 0
          const isPositive = change >= 0
          return (
            <div
              key={token.id || i}
              className="beta-row"
              onClick={() => {
                const url = `https://dexscreener.com/solana/${token.pairAddress || token.address}`
                window.open(url, '_blank')
              }}
            >
              <div className="token-info">
                <div className="token-icon" style={{ width: 28, height: 28, fontSize: 9 }}>
                  {token.logoUrl
                    ? <img src={token.logoUrl} alt={token.symbol} />
                    : token.symbol.slice(0, 3)}
                </div>
                <div>
                  <div style={{
                    fontFamily: 'var(--font-display)', fontWeight: 700,
                    fontSize: 13, color: 'var(--text-primary)',
                  }}>${token.symbol}</div>
                  <div className="token-address">{shortAddress(token.address)}</div>
                </div>
              </div>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                {formatNum(token.marketCap)}
              </span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {formatNum(token.volume24h)}
              </span>
              <span className={`mono token-change ${isPositive ? 'positive' : 'negative'}`} style={{ fontSize: 12 }}>
                {isPositive ? '+' : ''}{change.toFixed(1)}%
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
              <span className="badge badge-strong" style={{ fontSize: 8, padding: '2px 6px' }}>
                🌊 SZN
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── Beta Panel ──────────────────────────────────────────────────

const BetaPanel = ({ alpha, onListBeta }) => {
  const { betas, loading: betasLoading, error, refresh } = useBetas(alpha)
  const { parent, loading: parentLoading } = useParentAlpha(alpha)

  return (
    <section className="beta-panel">
      <div className="beta-panel-header">
        <div className="beta-panel-title-group">
          <h1 className="beta-panel-title">
            {alpha ? `Beta Plays for $${alpha.symbol}` : 'Select a Runner'}
          </h1>
          <p className="beta-panel-subtitle">
            {alpha
              ? (
                <span>
                  Surfacing derivative tokens for{' '}
                  <span style={{ color: 'var(--neon-green)' }}>${alpha.symbol}</span>
                  {' '}— sorted by 24h gain
                </span>
              )
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

      {!alpha ? (
        <div className="empty-state">
          <div className="empty-state-icon">👈</div>
          <div className="empty-state-title">No runner selected</div>
          <div className="empty-state-sub">
            Select a runner from the left panel to surface its beta plays.
          </div>
        </div>
      ) : (
        <>
          {parentLoading && (
            <div className="skeleton" style={{ height: 100, borderRadius: 10, marginBottom: 8 }} />
          )}
          {!parentLoading && parent && <ParentAlphaCard parent={parent} />}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center', flexShrink: 0 }}>
            <span className="badge badge-verified" style={{ fontSize: 8, padding: '2px 6px' }}>👑 OG</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>= original</span>
            <span className="badge badge-cabal" style={{ fontSize: 8, padding: '2px 6px', marginLeft: 8 }}>⚔️ RIVAL</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>= challenging throne</span>
            <span className="badge badge-weak" style={{ fontSize: 8, padding: '2px 6px', marginLeft: 8 }}>🌀 SPIN</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>= riding narrative</span>
            <span className="badge badge-cabal" style={{ fontSize: 8, padding: '2px 6px', marginLeft: 8 }}>🕵️ CABAL</span>
            <span className="mono text-muted" style={{ fontSize: 10 }}>= multi-signal</span>
          </div>

          <div className="beta-table">
            <div className="beta-table-header">
              <span>Token</span>
              <span>MCAP</span>
              <span>24h Vol</span>
              <span>24h %</span>
              <span>Age</span>
              <span>Signal</span>
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
                <div className="empty-state-sub">
                  Try a different runner or check back when the narrative heats up.
                </div>
              </div>
            )}

            {!betasLoading && betas.map((beta, i) => (
              <BetaRow key={beta.id || i} beta={beta} isPinned={false} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

// ─── Main App ────────────────────────────────────────────────────

export default function App() {
  const [selectedAlpha, setSelectedAlpha] = useState(null)
  const [showListModal, setShowListModal] = useState(false)

  const isSzn = selectedAlpha?.isSzn === true

  return (
    <div className="app-wrapper">
      <Navbar onListBeta={() => setShowListModal(true)} />
      <div className="main-layout">
        <AlphaBoard
          selectedAlpha={selectedAlpha}
          onSelect={setSelectedAlpha}
        />
        {isSzn
          ? <SznPanel szn={selectedAlpha} onListBeta={() => setShowListModal(true)} />
          : <BetaPanel alpha={selectedAlpha} onListBeta={() => setShowListModal(true)} />
        }
      </div>

      {showListModal && (
        <div className="modal-overlay" onClick={() => setShowListModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">⚡ List Your Beta</div>
            <div className="modal-sub">Monetization flow — coming in Phase 3</div>
            <button className="btn btn-ghost" onClick={() => setShowListModal(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}