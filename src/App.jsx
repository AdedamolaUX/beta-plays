import { useState } from 'react'
import useAlphas from './hooks/useAlphas'
import './index.css'

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

const AlphaCard = ({ alpha, isSelected, onClick }) => {
  const change = parseFloat(alpha.priceChange24h) || 0
  const isPositive = change >= 0
  return (
    <div className={`card alpha-card ${isSelected ? 'active' : ''}`} onClick={onClick}>
      <div className="alpha-card-top">
        <div className="token-info">
          <div className="token-icon">
            {alpha.logoUrl ? <img src={alpha.logoUrl} alt={alpha.symbol} /> : alpha.symbol.slice(0, 3)}
          </div>
          <div>
            <div className="token-name">${alpha.symbol}</div>
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

const AlphaBoard = ({ selectedAlpha, onSelect }) => {
  const [activeTab, setActiveTab] = useState('live')
  const { liveAlphas, historicalAlphas, loading, error, lastUpdated, refresh } = useAlphas()
  const displayList = activeTab === 'live' ? liveAlphas : historicalAlphas
  const isEmpty = !loading && displayList.length === 0

  return (
    <aside className="alpha-board">
      <div className="alpha-board-header">
        <span className="alpha-board-title">🎯 Runners</span>
        <div className="tab-group">
          <button className={`tab-btn ${activeTab === 'live' ? 'active' : ''}`} onClick={() => setActiveTab('live')}>Live</button>
          <button className={`tab-btn ${activeTab === 'past' ? 'active' : ''}`} onClick={() => setActiveTab('past')}>Past</button>
        </div>
      </div>

      {lastUpdated && activeTab === 'live' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
          <span className="mono text-muted" style={{ fontSize: 9 }}>Updated {lastUpdated.toLocaleTimeString()}</span>
          <button className="btn btn-ghost btn-sm" onClick={refresh} style={{ padding: '2px 8px', fontSize: 9 }}>↺ Refresh</button>
        </div>
      )}

      {error && (
        <div style={{ background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.3)', borderRadius: 6, padding: '8px 12px', fontSize: 11, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
          {error}
        </div>
      )}

      <div className="alpha-list scroll-y">
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
            <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('past')} style={{ marginTop: 12 }}>
              View Past Alphas
            </button>
          </div>
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

const BetaPanel = ({ alpha }) => (
  <section className="beta-panel">
    <div className="beta-panel-header">
      <div className="beta-panel-title-group">
        <h1 className="beta-panel-title">
          {alpha ? `Beta Plays for $${alpha.symbol}` : 'Select a Runner'}
        </h1>
        <p className="beta-panel-subtitle">
          {alpha
            ? <span>Surfacing derivative tokens for <span style={{ color: 'var(--neon-green)' }}>${alpha.symbol}</span></span>
            : 'Pick a runner from the left panel to surface its beta plays'}
        </p>
      </div>
      {alpha && <button className="btn btn-secondary btn-sm">Sort ↕</button>}
    </div>

    {!alpha ? (
      <div className="empty-state">
        <div className="empty-state-icon">👈</div>
        <div className="empty-state-title">No runner selected</div>
        <div className="empty-state-sub">Select a runner from the left panel to surface its beta plays.</div>
      </div>
    ) : (
      <div className="beta-table">
        <div className="beta-table-header">
          <span>Token</span>
          <span>MCAP</span>
          <span>24h Vol</span>
          <span>24h %</span>
          <span>Age</span>
          <span>Signal</span>
        </div>
        <div className="empty-state" style={{ marginTop: 24 }}>
          <div className="empty-state-icon">🔍</div>
          <div className="empty-state-title">Scanning for beta plays...</div>
          <div className="empty-state-sub">Mapping derivative tokens for ${alpha.symbol}. Detection engine coming next.</div>
        </div>
      </div>
    )}
  </section>
)

export default function App() {
  const [selectedAlpha, setSelectedAlpha] = useState(null)
  const [showListModal, setShowListModal] = useState(false)

  return (
    <div className="app-wrapper">
      <Navbar onListBeta={() => setShowListModal(true)} />
      <div className="main-layout">
        <AlphaBoard selectedAlpha={selectedAlpha} onSelect={setSelectedAlpha} />
        <BetaPanel alpha={selectedAlpha} />
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