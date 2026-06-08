import re

with open('src/App.jsx', 'r', encoding='utf-8') as f:
    jsx = f.read()

original_len = len(jsx)

# ─── 1. SettingsPanel header: ⚙️ Settings → ☰ Menu ───────────────
jsx = jsx.replace(
    '            ⚙️ Settings\n          </div>',
    '            ☰ Menu\n          </div>'
)

# ─── 2. SettingsPanel panel style: add maxHeight + overflow for scrollable ───
jsx = jsx.replace(
    '    background: \'var(--surface-2)\', border: \'1px solid var(--border-lit)\',\n    borderRadius: 12, padding: 24, width: 340, maxWidth: \'90vw\',\n    display: \'flex\', flexDirection: \'column\', gap: 20,',
    '    background: \'var(--surface-2)\', border: \'1px solid var(--border-lit)\',\n    borderRadius: 12, padding: 24, width: 340, maxWidth: \'90vw\',\n    display: \'flex\', flexDirection: \'column\', gap: 20,\n    maxHeight: \'85dvh\', overflowY: \'auto\','
)

# ─── 3. SettingsPanel: add Community section after Reset button ───
jsx = jsx.replace(
    '''        {/* Reset */}
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
}''',
    '''        {/* Reset */}
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

        {/* Community */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 12 }}>COMMUNITY</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <a href="https://twitter.com/betaplaysai" target="_blank" rel="noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontFamily: 'var(--font-display)', fontSize: 11, textDecoration: 'none' }}>
              <span>🐦</span><span>@betaplaysai</span>
            </a>
            <a href="https://t.me/betaplays" target="_blank" rel="noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontFamily: 'var(--font-display)', fontSize: 11, textDecoration: 'none' }}>
              <span>📡</span><span>t.me/betaplays</span>
            </a>
            <a href="https://github.com/AdedamolaUX/beta-plays" target="_blank" rel="noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontFamily: 'var(--font-display)', fontSize: 11, textDecoration: 'none' }}>
              <span>⚙️</span><span>GitHub</span>
            </a>
          </div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
            DYOR. Not financial advice. BetaPlays surfaces correlations — always verify before trading.
          </div>
        </div>
      </div>
    </div>
  )
}'''
)

# ─── 4. Navbar: add ecosystem pill after navbar-brand, add className to ⚙️ btn ───
jsx = jsx.replace(
    '  <div className="navbar-brand">\n    <img\n      src={betaplaysLogo}\n      alt="BetaPlays"\n      style={{ height: 44, width: 44, objectFit: \'contain\' }}\n    />\n    <span className="brand-name">Beta<span>Plays</span></span>\n  </div>',
    '  <div className="navbar-brand">\n    <img\n      src={betaplaysLogo}\n      alt="BetaPlays"\n      style={{ height: 44, width: 44, objectFit: \'contain\' }}\n    />\n    <span className="brand-name">Beta<span>Plays</span></span>\n  </div>\n  <div className="navbar-ecosystem">\n    <span style={{ width: 6, height: 6, borderRadius: \'50%\', background: \'var(--neon-green)\', display: \'inline-block\', marginRight: 5, boxShadow: \'0 0 6px var(--neon-green)\' }} />\n    <span>SOLANA</span>\n  </div>'
)

jsx = jsx.replace(
    '        onClick={onSettings}\n        style={{\n          background: \'rgba(255,255,255,0.05)\', border: \'1px solid var(--border)\',\n          borderRadius: 8, cursor: \'pointer\', color: \'var(--text-muted)\',\n          fontSize: 16, padding: \'6px 10px\', lineHeight: 1,\n          transition: \'all 0.15s ease\',\n        }}\n        title="Settings"\n      >⚙️</button>',
    '        onClick={onSettings}\n        className="navbar-settings-btn"\n        style={{\n          background: \'rgba(255,255,255,0.05)\', border: \'1px solid var(--border)\',\n          borderRadius: 8, cursor: \'pointer\', color: \'var(--text-muted)\',\n          fontSize: 16, padding: \'6px 10px\', lineHeight: 1,\n          transition: \'all 0.15s ease\',\n        }}\n        title="Settings"\n      >⚙️</button>'
)

# ─── 5. AlphaBoard: add onRegisterSwitchTab to signature ───
jsx = jsx.replace(
    'const AlphaBoard = ({ selectedAlpha, onSelect, onNewRunners, onLiveAlphas, onSznCards, onCoolingAlphas, onCustomSearch, customAlphaLoading, onRegisterClearSearch,',
    'const AlphaBoard = ({ selectedAlpha, onSelect, onNewRunners, onLiveAlphas, onSznCards, onCoolingAlphas, onCustomSearch, customAlphaLoading, onRegisterClearSearch, onRegisterSwitchTab,'
)

# ─── 6. AlphaBoard: wire onRegisterSwitchTab after onRegisterClearSearch useEffect ───
jsx = jsx.replace(
    '  useEffect(() => {\n    if (onRegisterClearSearch) onRegisterClearSearch(() => setSearchQuery(\'\'))\n  }, [])',
    '  useEffect(() => {\n    if (onRegisterClearSearch) onRegisterClearSearch(() => setSearchQuery(\'\'))\n  }, [])\n  useEffect(() => {\n    if (onRegisterSwitchTab) onRegisterSwitchTab((tab) => setActiveTab(tab))\n  }, [])'
)

# ─── 7. App: add switchTabRef ref near clearAlphaBoardSearch ───
jsx = jsx.replace(
    '  const clearAlphaBoardSearch = useRef(null) // set by AlphaBoard',
    '  const clearAlphaBoardSearch = useRef(null) // set by AlphaBoard\n  const switchTabRef = useRef(null) // set by AlphaBoard'
)

# ─── 8. App: pass onRegisterSwitchTab to AlphaBoard in render ───
jsx = jsx.replace(
    'onRegisterClearSearch={fn => { clearAlphaBoardSearch.current = fn }}',
    'onRegisterClearSearch={fn => { clearAlphaBoardSearch.current = fn }} onRegisterSwitchTab={fn => { switchTabRef.current = fn }}'
)

# ─── 9. App render: add bottom nav after closing main-layout div ───
jsx = jsx.replace(
    '      {/* Folio picker — shown when 🎯 clicked with multiple folios */}',
    '''      <nav className="mobile-bottom-nav">
        <button className="mobile-nav-btn" onClick={() => { setMobileView('list'); setSelectedAlpha(null); if (switchTabRef.current) switchTabRef.current('live') }}>
          <span className="mobile-nav-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="10" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4"/>
              <line x1="10" y1="5.3" x2="8.5" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <line x1="10" y1="5.3" x2="11.5" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <line x1="8.5" y1="10" x2="6.5" y2="14.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <line x1="11.5" y1="10" x2="13.5" y2="14.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <line x1="7.5" y1="8" x2="5" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <line x1="12.5" y1="8" x2="15" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </span>
          <span className="mobile-nav-label">Runners</span>
        </button>
        <button className="mobile-nav-btn" onClick={() => { setMobileView('list'); if (switchTabRef.current) switchTabRef.current('watch') }}>
          <span className="mobile-nav-icon">⭐</span>
          <span className="mobile-nav-label">Watchlist</span>
        </button>
        <button className="mobile-nav-btn" onClick={() => setShowSettings(true)}>
          <span className="mobile-nav-icon">☰</span>
          <span className="mobile-nav-label">Menu</span>
        </button>
      </nav>

      {/* Folio picker — shown when 🎯 clicked with multiple folios */}'''
)

with open('src/App.jsx', 'w', encoding='utf-8', newline='\n') as f:
    f.write(jsx)

new_len = len(jsx)
print(f"Done. Chars: {original_len} → {new_len} (+{new_len - original_len})")

# Verify key strings landed
checks = [
    ('☰ Menu header', '☰ Menu'),
    ('maxHeight 85dvh', 'maxHeight: \'85dvh\''),
    ('Community section', 'COMMUNITY'),
    ('navbar-ecosystem', 'navbar-ecosystem'),
    ('navbar-settings-btn', 'navbar-settings-btn'),
    ('onRegisterSwitchTab prop', 'onRegisterSwitchTab,'),
    ('switchTab useEffect', 'onRegisterSwitchTab) onRegisterSwitchTab'),
    ('switchTabRef decl', 'const switchTabRef = useRef(null)'),
    ('switchTabRef passed', 'onRegisterSwitchTab={fn =>'),
    ('bottom nav', 'mobile-bottom-nav'),
]
for name, needle in checks:
    found = needle in jsx
    print(f"  {'✅' if found else '❌'} {name}")
