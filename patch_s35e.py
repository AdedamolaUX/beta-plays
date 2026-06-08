with open('src/index.css', 'r', encoding='utf-8') as f:
    css = f.read()

orig = len(css)

# 1. Remove the global scrollbar killer that breaks tab row + other scroll areas
css = css.replace(
    '/* Hide scrollbars on horizontal scroll containers and modal panels */\n.navbar, nav, [style*="overflow"] {\n  scrollbar-width: none;\n}\n.navbar::-webkit-scrollbar, nav::-webkit-scrollbar { display: none; }\n\n',
    ''
)

# 2. SZN inline labels — hide on desktop (header already labels columns),
#    show on mobile (no header visible on mobile szn rows)
# Add a class-based rule. The spans are inline-styled, so we target them via
# the szn-row context on desktop.
css = css.replace(
    '.beta-table {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding-bottom: 8px;\n}',
    '''.beta-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 8px;
}

/* SZN row metric label spans — hidden on desktop (header covers it) */
.beta-row.szn-row > div > span:first-child {
  display: none;
}'''
)

# 3. Show those labels on mobile (szn-row is flex, no table header visible)
css = css.replace(
    '  /* Metric divs: column layout, centered */\n  .beta-row.szn-row > div:not(.token-info) {',
    '  /* Show szn metric labels on mobile */\n  .beta-row.szn-row > div > span:first-child { display: block !important; }\n\n  /* Metric divs: column layout, centered */\n  .beta-row.szn-row > div:not(.token-info) {'
)

with open('src/index.css', 'w', encoding='utf-8', newline='\n') as f:
    f.write(css)

print(f"index.css: {orig} → {len(css)} (+{len(css)-orig})")
print(f"  {'✅' if '[style*=\"overflow\"]' not in css else '❌'} Global scrollbar killer removed")
print(f"  {'✅' if 'beta-row.szn-row > div > span:first-child' in css else '❌'} SZN labels hidden on desktop")
print(f"  {'✅' if 'display: block !important' in css else '❌'} SZN labels shown on mobile")
