# ── App.jsx patches ──────────────────────────────────────────────
with open('src/App.jsx', 'r', encoding='utf-8') as f:
    jsx = f.read()

original_jsx = len(jsx)

# 1. Remove Trenches badge from desktop row
jsx = jsx.replace(
    '            {isTrench       && <Tooltip text="Trenches — market cap under $30K. Very high risk, very high reward."><span className="badge badge-new" style={{ fontSize: 11, padding: \'1px 3px\', cursor: \'default\' }}>⛏️</span></Tooltip>}\n',
    ''
)

# 2. Remove Trenches badge from mobile card-top
jsx = jsx.replace(
    '              {isTrench      && <span className="badge badge-new" style={{ fontSize: 9, padding: \'1px 4px\' }}>⛏️ TRENCH</span>}\n',
    ''
)

with open('src/App.jsx', 'w', encoding='utf-8', newline='\n') as f:
    f.write(jsx)

print(f"App.jsx: {original_jsx} → {len(jsx)} (+{len(jsx)-original_jsx})")
print(f"  {'✅' if 'isTrench       && <Tooltip' not in jsx else '❌'} Trenches desktop badge removed")
print(f"  {'✅' if 'isTrench      && <span' not in jsx else '❌'} Trenches mobile badge removed")

# ── index.css patches ─────────────────────────────────────────────
with open('src/index.css', 'r', encoding='utf-8') as f:
    css = f.read()

original_css = len(css)

# 3. Hide navbar-ecosystem on mobile
css = css.replace(
    '  /* Hide entire middle navbar section (LIVE·SOLANA + badges + latency) */\n  .navbar-center { display: none !important; }',
    '  /* Hide entire middle navbar section (LIVE·SOLANA + badges + latency) */\n  .navbar-center { display: none !important; }\n  .navbar-ecosystem { display: none !important; }'
)

# 4. Style navbar-ecosystem to match app theme — neon green, mono font
css = css.replace(
    '.navbar-ecosystem {\n  display: flex;\n  align-items: center;\n  background: rgba(0,212,255,0.06);\n  border: 1px solid rgba(0,212,255,0.2);\n  border-radius: 20px;\n  padding: 4px 10px;\n  flex-shrink: 0;\n}',
    '.navbar-ecosystem {\n  display: flex;\n  align-items: center;\n  gap: 5px;\n  background: rgba(57,255,20,0.06);\n  border: 1px solid rgba(57,255,20,0.2);\n  border-radius: 20px;\n  padding: 4px 10px;\n  flex-shrink: 0;\n  font-family: var(--font-mono);\n  font-size: 10px;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  color: var(--neon-green);\n}'
)

# 5. Fix Active Narratives / alpha-list scrolling on mobile
css = css.replace(
    '  /* Alpha board: full height, scrollable */\n  .main-layout > *:first-child {\n    flex: 1;\n    min-height: 0;\n    overflow: hidden;\n    display: flex;\n    flex-direction: column;\n  }',
    '  /* Alpha board: full height, scrollable */\n  .main-layout > *:first-child {\n    flex: 1;\n    min-height: 0;\n    overflow: hidden;\n    display: flex;\n    flex-direction: column;\n  }\n  .alpha-list {\n    overflow-y: auto !important;\n    overflow-x: hidden !important;\n    flex: 1 !important;\n    min-height: 0 !important;\n  }'
)

with open('src/index.css', 'w', encoding='utf-8', newline='\n') as f:
    f.write(css)

print(f"index.css: {original_css} → {len(css)} (+{len(css)-original_css})")
print(f"  {'✅' if '.navbar-ecosystem { display: none !important; }' in css else '❌'} Ecosystem pill hidden on mobile")
print(f"  {'✅' if 'color: var(--neon-green)' in css and 'font-family: var(--font-mono)' in css else '❌'} Ecosystem pill theme styled")
print(f"  {'✅' if 'overflow-y: auto !important' in css else '❌'} alpha-list mobile scroll fixed")
