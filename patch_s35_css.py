with open('src/index.css', 'r', encoding='utf-8') as f:
    css = f.read()

original_len = len(css)

# ─── 1. Hide scrollbar on Menu/settings modal panel ───────────────
# The inner panel is a div with maxHeight:85dvh inline style.
# Target via the fixed overlay → flex child pattern.
# Also hide scrollbar on the tab row (inline overflowX: auto, no class).
css = css.replace(
    '''  /* Menu/settings panel scrollable on mobile */
  .settings-panel-inner,
  [class*="settings"] > div > div {
    overflow-y: auto !important;
    max-height: 85vh !important;
  }''',
    '''  /* Menu/settings panel scrollable on mobile — scrollbar hidden */
  .settings-panel-inner,
  [class*="settings"] > div > div {
    overflow-y: auto !important;
    max-height: 85vh !important;
  }
  /* Hide scrollbar on fixed overlay modal inner panel (Menu) */
  [style*="position: fixed"][style*="zIndex: 9999"] > div {
    scrollbar-width: none !important;
  }
  [style*="position: fixed"][style*="zIndex: 9999"] > div::-webkit-scrollbar {
    display: none !important;
  }'''
)

# ─── 2. Hide scrollbar on inline tab row (overflowX auto, no class) ───
# Add a global rule that hides scrollbars on any div with overflow-x:auto
# inside .alpha-board (scoped to avoid affecting other elements)
css = css.replace(
    '  .tab-row, .filter-tabs, .alpha-tabs, .source-filter-row {',
    '  /* Hide scrollbar on inline-styled tab row */\n  .alpha-board > div[style*="overflowX"],\n  .alpha-board > div > div[style*="overflowX"] {\n    scrollbar-width: none !important;\n  }\n  .alpha-board > div[style*="overflowX"]::-webkit-scrollbar,\n  .alpha-board > div > div[style*="overflowX"]::-webkit-scrollbar {\n    display: none !important;\n  }\n  .tab-row, .filter-tabs, .alpha-tabs, .source-filter-row {'
)

# ─── 3. Szn row metric divs: center-align labels + values ─────────
css = css.replace(
    '  /* Metric divs: column layout */\n  .beta-row.szn-row > div:not(.token-info) {\n    flex-direction: column !important;\n    gap: 1px !important;\n    flex-shrink: 0 !important;\n  }',
    '  /* Metric divs: column layout, centered */\n  .beta-row.szn-row > div:not(.token-info) {\n    flex-direction: column !important;\n    gap: 1px !important;\n    flex-shrink: 0 !important;\n    align-items: center !important;\n  }'
)

# ─── 4. Szn Signal badge: don't shrink, align right ───────────────
css = css.replace(
    '  .beta-row.szn-row .beta-card-top,\n  .beta-row.szn-row .beta-row-metrics { display: none !important; }',
    '  .beta-row.szn-row .beta-card-top,\n  .beta-row.szn-row .beta-row-metrics { display: none !important; }\n  /* Signal badge (SZN) in szn rows — keep visible, no shrink */\n  .beta-row.szn-row > span.badge {\n    flex-shrink: 0 !important;\n    margin-left: auto !important;\n  }'
)

with open('src/index.css', 'w', encoding='utf-8', newline='\n') as f:
    f.write(css)

new_len = len(css)
print(f"Done. Chars: {original_len} → {new_len} (+{new_len - original_len})")

checks = [
    ('Menu scrollbar hidden', 'zIndex: 9999"] > div {'),
    ('Tab row scrollbar hidden', 'overflowX"]::-webkit-scrollbar'),
    ('Szn metrics centered', 'align-items: center !important;\n  }'),
    ('Signal badge no shrink', 'flex-shrink: 0 !important;\n    margin-left: auto'),
]
for name, needle in checks:
    print(f"  {'✅' if needle in css else '❌'} {name}")
