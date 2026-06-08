with open('src/index.css', 'r', encoding='utf-8') as f:
    css = f.read()
orig = len(css)

# 1. Remove global scrollbar killer — restores thin scrollbar on alpha-list
#    (both Live and Active Narratives use .alpha-list which has scrollbar-width:thin)
css = css.replace(
    '/* Hide scrollbars on horizontal scroll containers and modal panels */\n.navbar, nav, [style*="overflow"] {\n  scrollbar-width: none;\n}\n.navbar::-webkit-scrollbar, nav::-webkit-scrollbar { display: none; }\n\n',
    ''
)

# 2. Hide szn row inline labels on desktop (header already has column labels)
#    Insert after .beta-table block
css = css.replace(
    '.beta-table {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding-bottom: 8px;\n}',
    '.beta-table {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding-bottom: 8px;\n}\n\n/* SZN row: hide inline metric labels on desktop — header covers them */\n.beta-row.szn-row > div > span:first-child {\n  display: none;\n}'
)

# 3. Show szn labels on mobile (no header visible there)
css = css.replace(
    '  /* Metric divs: column layout, centered */\n  .beta-row.szn-row > div:not(.token-info) {',
    '  /* SZN labels visible on mobile */\n  .beta-row.szn-row > div > span:first-child { display: block !important; }\n\n  /* Metric divs: column layout, centered */\n  .beta-row.szn-row > div:not(.token-info) {'
)

with open('src/index.css', 'w', encoding='utf-8', newline='\n') as f:
    f.write(css)

print(f"index.css: {orig} → {len(css)} (+{len(css)-orig})")
print(f"  {'✅' if '[style*=\"overflow\"]' not in css else '❌'} Global scrollbar killer removed (restores thin scrollbar)")
print(f"  {'✅' if 'szn-row > div > span:first-child' in css else '❌'} SZN labels hidden on desktop")
print(f"  {'✅' if 'display: block !important' in css else '❌'} SZN labels shown on mobile")
