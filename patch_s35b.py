import subprocess, sys

# ── 1. App.jsx — wrap SZN badge in a SIGNAL metric div ────────────
with open('src/App.jsx', 'r', encoding='utf-8') as f:
    jsx = f.read()

original_jsx = len(jsx)

jsx = jsx.replace(
    '              <span className="badge badge-strong" style={{ fontSize: 8, padding: \'2px 6px\' }}>🌊 SZN</span>',
    '''              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center', flexShrink: 0 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 7, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>SIGNAL</span>
                <span className="badge badge-strong" style={{ fontSize: 8, padding: '2px 6px' }}>🌊 SZN</span>
              </div>'''
)

with open('src/App.jsx', 'w', encoding='utf-8', newline='\n') as f:
    f.write(jsx)

print(f"App.jsx: {original_jsx} → {len(jsx)} chars (+{len(jsx)-original_jsx})")
print(f"  {'✅' if 'SIGNAL' in jsx and 'flexDirection: \'column\'' in jsx else '❌'} SZN Signal column div")

# ── 2. index.css — better scrollbar hiding attempts ───────────────
with open('src/index.css', 'r', encoding='utf-8') as f:
    css = f.read()

original_css = len(css)

# More aggressive: hide ALL scrollbars globally, then re-enable where needed
# Add after the existing ::-webkit-scrollbar rules (around line 250)
css = css.replace(
    '::-webkit-scrollbar { width: 4px; }\n::-webkit-scrollbar-track { background: transparent; }\n::-webkit-scrollbar-thumb { background: var(--neon-dim); border-radius: 2px; }',
    '::-webkit-scrollbar { width: 4px; }\n::-webkit-scrollbar-track { background: transparent; }\n::-webkit-scrollbar-thumb { background: var(--neon-dim); border-radius: 2px; }\n\n/* Hide scrollbars on horizontal scroll containers and modal panels */\n.navbar, nav, [style*="overflow"] {\n  scrollbar-width: none;\n}\n.navbar::-webkit-scrollbar, nav::-webkit-scrollbar { display: none; }'
)

with open('src/index.css', 'w', encoding='utf-8', newline='\n') as f:
    f.write(css)

print(f"index.css: {original_css} → {len(css)} chars (+{len(css)-original_css})")

# ── 3. index.html — add theme-color meta tag ─────────────────────
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

original_html = len(html)

if 'theme-color' not in html:
    html = html.replace(
        '<meta charset="UTF-8" />',
        '<meta charset="UTF-8" />\n    <meta name="theme-color" content="#0a0a0f" />\n    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />'
    )
    with open('index.html', 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print(f"index.html: {original_html} → {len(html)} chars")
    print(f"  {'✅' if 'theme-color' in html else '❌'} theme-color meta added")
else:
    print("  ℹ️  theme-color already present in index.html")
