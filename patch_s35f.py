import os

# ── index.css ──────────────────────────────────────────────────────
with open('src/index.css', 'r', encoding='utf-8') as f:
    css = f.read()

orig_css = len(css)

# 1. Remove global scrollbar killer (nav + [style*="overflow"])
css = css.replace(
    '/* Hide scrollbars on horizontal scroll containers and modal panels */\n.navbar, nav, [style*="overflow"] {\n  scrollbar-width: none;\n}\n.navbar::-webkit-scrollbar, nav::-webkit-scrollbar { display: none; }\n\n',
    ''
)

# 2. Show navbar-ecosystem on mobile (remove the hide rule we added)
css = css.replace(
    '  .navbar-ecosystem { display: none !important; }\n',
    ''
)

# 3. SZN row metric labels — hide on desktop, shown on mobile
css = css.replace(
    '.beta-table {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding-bottom: 8px;\n}',
    '''.beta-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 8px;
}

/* SZN row inline metric labels hidden on desktop (header covers them) */
.beta-row.szn-row > div > span:first-child {
  display: none;
}'''
)

# 4. Show szn metric labels on mobile
css = css.replace(
    '  /* Metric divs: column layout, centered */\n  .beta-row.szn-row > div:not(.token-info) {',
    '  /* SZN labels visible on mobile (no table header) */\n  .beta-row.szn-row > div > span:first-child { display: block !important; }\n\n  /* Metric divs: column layout, centered */\n  .beta-row.szn-row > div:not(.token-info) {'
)

with open('src/index.css', 'w', encoding='utf-8', newline='\n') as f:
    f.write(css)

print(f"index.css: {orig_css} → {len(css)} (+{len(css)-orig_css})")
print(f"  {'✅' if '[style*=\"overflow\"]' not in css else '❌'} Global scrollbar killer removed")
print(f"  {'✅' if '.navbar-ecosystem { display: none !important; }' not in css else '❌'} Ecosystem pill restored on mobile")
print(f"  {'✅' if 'beta-row.szn-row > div > span:first-child' in css else '❌'} SZN labels hidden desktop / shown mobile")

# ── App.jsx ────────────────────────────────────────────────────────
with open('src/App.jsx', 'r', encoding='utf-8') as f:
    jsx = f.read()

orig_jsx = len(jsx)

# 5. Move CopyAddress to immediately after $SYMBOL on desktop beta row
#    Currently it's on the second line (marginTop:1 div). Move to first line after symbol.
jsx = jsx.replace(
    '''          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
              ${beta.symbol}
            </span>''',
    '''          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
              ${beta.symbol}
            </span>
            <CopyAddress address={beta.address} />'''
)

# Remove CopyAddress from the second line (where it currently lives)
jsx = jsx.replace(
    '''          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
            <CopyAddress address={beta.address} />
            {beta.isHistorical && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '1px 3px' }}>📦</span>}
            <WaveBadge phase={wave} />
          </div>''',
    '''          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
            {beta.isHistorical && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '1px 3px' }}>📦</span>}
            <WaveBadge phase={wave} />
          </div>'''
)

with open('src/App.jsx', 'w', encoding='utf-8', newline='\n') as f:
    f.write(jsx)

print(f"App.jsx: {orig_jsx} → {len(jsx)} (+{len(jsx)-orig_jsx})")
print(f"  {'✅' if 'beta.symbol}\n            </span>\n            <CopyAddress address={beta.address} />' in jsx else '❌'} CopyAddress moved next to symbol")

# ── public/_redirects (fix "Not Found" on refresh) ─────────────────
os.makedirs('public', exist_ok=True)
with open('public/_redirects', 'w', encoding='utf-8') as f:
    f.write('/* /index.html 200\n')
print("✅ public/_redirects created (fixes Not Found on refresh)")
