with open('src/LandingPage.jsx', 'r', encoding='utf-8') as f:
    jsx = f.read()

orig = len(jsx)

# 1. Hero text change
jsx = jsx.replace(
    'NO CRYING OVER SPILLED MILK.<br />BET ON THE <em>DERIVATIVE.</em>',
    'NO CRYING IN THE CASINO.<br />BET ON THE <em>DERIVATIVE.</em>'
)

# 2. Partnership section — insert before FINAL CTA
jsx = jsx.replace(
    '      {/* ── FINAL CTA ── */}',
    '''      {/* ── PARTNERSHIP ── */}
      <section className="lp-section lp-partner-section" id="partners">
        <div className="lp-projects-intro">
          <div>
            <div className="lp-label">BACK US EARLY</div>
            <h2 className="lp-section-title">BUILD THE EDGE<br />WITH US.</h2>
          </div>
          <p className="lp-section-sub">
            BetaPlays is early. We&apos;re building the narrative intelligence layer
            that every Solana degen will rely on. If you see the vision —
            capital, connections, or strategic partnerships — we want to hear from you.
          </p>
        </div>
        <div className="lp-partner-grid">
          <div className="lp-partner-card">
            <div className="lp-proj-accent lp-acc-purple" />
            <div className="lp-partner-icon">💰</div>
            <div className="lp-proj-title">Invest Capital</div>
            <div className="lp-proj-desc">Back the earliest stage of BetaPlays. Get in before the audience, the revenue, and the moat are fully built.</div>
          </div>
          <div className="lp-partner-card">
            <div className="lp-proj-accent lp-acc-green" />
            <div className="lp-partner-icon">🤝</div>
            <div className="lp-proj-title">Strategic Partner</div>
            <div className="lp-proj-desc">Exchanges, wallets, data providers — if your product serves Solana degens, there&apos;s a deal to be structured.</div>
          </div>
          <div className="lp-partner-card">
            <div className="lp-proj-accent" style={{ background: 'var(--lp-cyan)' }} />
            <div className="lp-partner-icon">🧠</div>
            <div className="lp-proj-title">Advisor</div>
            <div className="lp-proj-desc">Deep in CT, DeFi, or growth? Help shape the product and go-to-market in exchange for early access and upside.</div>
          </div>
        </div>
        <div className="lp-partner-cta">
          <p className="lp-partner-sub">Takes 2 minutes. No commitment — just a conversation.</p>
          <a
            href="https://tally.so/r/NpPgKj"
            target="_blank"
            rel="noreferrer"
            className="lp-btn-primary"
            style={{ display: 'inline-block', textDecoration: 'none' }}
          >
            BACK BETAPLAYS EARLY →
          </a>
        </div>
      </section>

      {/* ── FINAL CTA ── */}'''
)

with open('src/LandingPage.jsx', 'w', encoding='utf-8', newline='\n') as f:
    f.write(jsx)

print(f"LandingPage.jsx: {orig} → {len(jsx)} (+{len(jsx)-orig})")
print(f"  {'✅' if 'NO CRYING IN THE CASINO' in jsx else '❌'} Hero text updated")
print(f"  {'✅' if 'tally.so/r/NpPgKj' in jsx else '❌'} Tally link added")
print(f"  {'✅' if 'lp-partner-section' in jsx else '❌'} Partnership section added")

# CSS for partnership section
with open('src/index.css', 'r', encoding='utf-8') as f:
    css = f.read()

orig_css = len(css)

css = css.replace(
    '.lp-footer { border-top: 1px solid var(--lp-border); padding: 3rem 4rem; }',
    '''/* ── Partnership Section ── */
.lp-partner-section { padding: 6rem 4rem; }
.lp-partner-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1px;
  background: var(--lp-border);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 3rem;
}
.lp-partner-card {
  background: var(--lp-void2);
  padding: 2.5rem;
  transition: background 0.25s;
  position: relative;
  overflow: hidden;
}
.lp-partner-card:hover { background: var(--lp-void3); }
.lp-partner-icon { font-size: 2rem; margin-bottom: 1rem; }
.lp-partner-cta { text-align: center; }
.lp-partner-sub {
  font-family: 'Space Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 2px;
  color: var(--lp-text-dim);
  margin-bottom: 1.5rem;
  text-transform: uppercase;
}

@media (max-width: 768px) {
  .lp-partner-section { padding: 3rem 1.25rem; }
  .lp-partner-grid { grid-template-columns: 1fr; }
}

.lp-footer { border-top: 1px solid var(--lp-border); padding: 3rem 4rem; }'''
)

with open('src/index.css', 'w', encoding='utf-8', newline='\n') as f:
    f.write(css)

print(f"index.css: {orig_css} → {len(css)} (+{len(css)-orig_css})")
print(f"  {'✅' if 'lp-partner-grid' in css else '❌'} Partner CSS added")
