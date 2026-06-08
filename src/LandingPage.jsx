import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const LandingPage = () => {
  const navigate = useNavigate()

  // Scroll to anchor on hash nav
  useEffect(() => {
    if (window.location.hash) {
      const el = document.getElementById(window.location.hash.slice(1))
      if (el) el.scrollIntoView({ behavior: 'smooth' })
    }
  }, [])

  return (
    <div className="lp-root">
      {/* ── NAV ── */}
      <nav className="lp-nav">
        <a href="#" className="lp-nav-logo">
          <img src="/betaplays-logo.png" alt="BetaPlays" className="lp-nav-logo-img" />
          <span className="lp-nav-logo-text">BETA<span>PLAYS</span></span>
        </a>
        <div className="lp-nav-links">
          <a href="#how">HOW IT WORKS</a>
          <a href="#vectors">SIGNALS</a>
          <a href="#projects">FOR PROJECTS</a>
          <a href="https://twitter.com/betaplaysai" target="_blank" rel="noreferrer">TWITTER</a>
          <a href="https://t.me/betaplays" target="_blank" rel="noreferrer">TELEGRAM</a>
          <button className="lp-nav-cta" onClick={() => navigate('/app')}>LAUNCH APP</button>
        </div>
      </nav>

      {/* ── HERO ── */}
      <div className="lp-hero">
        <div className="lp-grid-bg" />
        <div className="lp-orb lp-orb-1" />
        <div className="lp-orb lp-orb-2" />

        <div className="lp-hero-left">

          <h1 className="lp-h1">
            <span className="lp-h1-solid">ALPHA</span>
            <span className="lp-h1-outline">ALREADY</span>
            <span className="lp-h1-gradient">PUMPED.</span>
          </h1>
          <div className="lp-h1-divider" />
          <span className="lp-h1-sub">
            NO CRYING IN THE CASINO.<br />BET ON THE <em>DERIVATIVE.</em>
          </span>
          <p className="lp-hero-desc">
            BetaPlays maps narrative correlations in real time. Find the{' '}
            <strong>derivative plays</strong> before CT does. 11 detection vectors
            across AI, Telegram, X, news and on-chain data. Zero alpha required.{' '}
            <strong>Free to explore — unlock the full signal stack.</strong>
          </p>
          <div className="lp-cta-row">
            <button className="lp-btn-primary" onClick={() => navigate('/app')}>
              LAUNCH APP →
            </button>
            <a href="#how" className="lp-btn-ghost">HOW IT WORKS ↓</a>
          </div>
        </div>

        <div className="lp-hero-right">
          {[
            { sym: '$MYRO',   badge: '📡 TELEGRAM', cls: 'b-tg',   pct: '+892%', meta: 'BETA TO $WIF · DOG LORE',    soon: false },
            { sym: '$POPDOG', badge: '🤖 AI MATCH',  cls: 'b-ai',   pct: '+567%', meta: 'BETA TO $POPCAT · TWIN',      soon: false },
            { sym: '$DAWG',   badge: '𝕏 TWITTER',   cls: 'b-x',    pct: '+467%', meta: 'BETA TO $WIF · MORPHOLOGY',   soon: true  },
            { sym: '$MAYA',   badge: '📰 NEWS',      cls: 'b-news', pct: '+234%', meta: 'BETA TO $BONK · NEWS',        soon: true  },
          ].map((c, i) => (
            <div className="lp-fcard" key={i}>
              <div className="lp-fcard-top">
                <div className="lp-fcard-sym">{c.sym}</div>
                <div className={`lp-fcard-badge ${c.cls}`}>
                  {c.badge}{c.soon && <span className="lp-soon-tag">SOON</span>}
                </div>
              </div>
              <div className="lp-fcard-pct">{c.pct}</div>
              <div className="lp-fcard-meta">{c.meta}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── TICKER ── */}
      <div className="lp-ticker-wrap">
        <div className="lp-ticker-inner">
          {['$WIF +892%','$POPCAT +634%','$MEW +1240%','$BONK +445%','$MYRO +389%','$CHIBI +567%','$BOME +2100%','$MOODENG +3400%',
            '$WIF +892%','$POPCAT +634%','$MEW +1240%','$BONK +445%','$MYRO +389%','$CHIBI +567%','$BOME +2100%','$MOODENG +3400%'].map((item, i) => {
            const [sym, pct] = item.split(' ')
            return (
              <span className="lp-ticker-item" key={i}>
                {sym} <span className="lp-ticker-up">{pct}</span>
              </span>
            )
          })}
        </div>
      </div>

      {/* ── SIGNALS STRIP ── */}
      <div className="lp-signals-strip">
        <div className="lp-signals-label">BETA DISCOVERY SOURCES</div>
        <div className="lp-signals-row">
          {[
            { label: 'TELEGRAM',         live: true  },
            { label: 'AI CLASSIFICATION',live: true  },
            { label: 'ON-CHAIN LP PAIRS',live: true  },
            { label: 'LOGO VISION',      live: true  },
            { label: 'LORE MAP',         live: true  },
            { label: 'TWITTER / X',      live: false },
            { label: 'NEWS SIGNALS',     live: false },
          ].map((s, i) => (
            <div className={`lp-signal-pill ${s.live ? 'live' : 'soon'}`} key={i}>
              <div className="lp-sdot" />
              {s.label}
              <span className={`lp-stag ${s.live ? 'stag-live' : 'stag-soon'}`}>
                {s.live ? 'LIVE' : 'SOON'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── PROBLEM ── */}
      <section className="lp-section lp-problem">
        <div className="lp-problem-grid">
          <div>
            <div className="lp-label">THE PROBLEM</div>
            <h2 className="lp-section-title">
              YOU&apos;RE ALWAYS LATE TO THE{' '}
              <del className="lp-del">PARTY</del> ALPHA
            </h2>
            <p className="lp-section-sub">
              By the time $WIF is trending, it&apos;s already 10x&apos;d. But the narrative is just
              getting started. CT doesn&apos;t stop at one token — it hunts the entire cluster.
              Dog tokens run together because degens see shared lore. Cat tokens follow dogs
              because they&apos;re the natural opposite — CT loves a rivalry narrative. Evil twins,
              spinoffs, and thematic echoes all catch bids as liquidity flows through the story.
              BetaPlays maps every one of those relationships automatically — lore, opposition,
              morphology, on-chain pairs, AI classification — so you catch the wave before the
              crowd figures out why it&apos;s happening.
            </p>
          </div>
          <div className="lp-problem-visual">
            <div className="lp-p-row active">
              <div className="lp-p-icon">🐕</div>
              <div className="lp-p-text">
                <div className="lp-p-sym">$WIF</div>
                <div className="lp-p-label">ALPHA RUNNER · LIVE</div>
              </div>
              <div className="lp-p-change up">+892%</div>
            </div>
            <div className="lp-arrow-down" />
            <div className="lp-p-row active">
              <div className="lp-p-icon">⚡</div>
              <div className="lp-p-text">
                <div className="lp-p-sym">$MYRO — TELEGRAM</div>
                <div className="lp-p-label">BETA DETECTED · DOG LORE</div>
              </div>
              <div className="lp-p-change up">+467%</div>
            </div>
            <div className="lp-arrow-down" />
            <div className="lp-p-row active">
              <div className="lp-p-icon">🤖</div>
              <div className="lp-p-text">
                <div className="lp-p-sym">$DAWG — AI MATCH</div>
                <div className="lp-p-label">BETA DETECTED · CT SIGNAL</div>
              </div>
              <div className="lp-p-change up">+234%</div>
            </div>
            <div className="lp-arrow-down" />
            <div className="lp-p-row rekt">
              <div className="lp-p-icon">👀</div>
              <div className="lp-p-text">
                <div className="lp-p-sym rekt-sym">YOU — FOMO BUYING TOP</div>
                <div className="lp-p-label rekt-label">WITHOUT BETAPLAYS</div>
              </div>
              <div className="lp-p-change rekt-val">REKT</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="lp-section lp-dark-section" id="how">
        <div className="lp-label">HOW IT WORKS</div>
        <h2 className="lp-section-title">THREE STEPS.<br />INFINITE EDGE.</h2>
        <div className="lp-steps-grid">
          {[
            { num: '01 / DETECT', title: 'Alpha hits the feed',         desc: '5 live sources scan Solana around the clock. DEXScreener, Birdeye, PumpFun graduates, new pairs. When a token starts running, BetaPlays locks it immediately.' },
            { num: '02 / SCAN',   title: '11 vectors fire in parallel', desc: 'AI classification, Telegram CT signal, logo vision, lore mapping, LP pairs, morphology — all running simultaneously. Every relationship scored and ranked.' },
            { num: '03 / APE',    title: 'Ranked betas, ready to trade',desc: 'STRONG → AI MATCH → TELEGRAM. Swap directly in-app via Jupiter. No tab-switching. No guesswork. Just signal and execution.' },
          ].map((s, i) => (
            <div className="lp-step" key={i}>
              <div className="lp-step-num">{s.num}</div>
              <div className="lp-step-title">{s.title}</div>
              <div className="lp-step-desc">{s.desc}</div>
              <div className="lp-step-bar" />
            </div>
          ))}
        </div>
      </section>

      {/* ── VECTORS ── */}
      <section className="lp-section" id="vectors">
        <div className="lp-label">DETECTION ENGINE</div>
        <h2 className="lp-section-title">WHAT RUNS<br />UNDER THE HOOD</h2>
        <div className="lp-vec-grid">
          {[
            { id: 'V.08 — AI',       name: 'AI Scoring',         desc: '11-model fallback chain. TWIN, ECHO, COUNTER, EVIL_TWIN, SECTOR classification. Description-first framing.',                                          soon: false },
            { id: 'V.10 — SOCIAL',   name: 'Telegram Intel',     desc: 'Live CT groupings from curated alpha channels. Human signal extracted from real degen conversation.',                                                   soon: false },
            { id: 'V.00 — VISION',   name: 'Logo Vision',        desc: 'Computer vision logo comparison runs before AI scoring. Visual correlation as a dedicated signal layer.',                                               soon: false },
            { id: 'V.05 — ON-CHAIN', name: 'LP Pair Detection',  desc: 'Direct on-chain liquidity pair relationships. Unambiguous. No noise. On-chain truth only.',                                                            soon: false },
            { id: 'V.02 — LORE',     name: 'Narrative Lore Map', desc: 'Deep meme culture mapping. Dog clusters, frog clusters, degen archetypes — all pre-catalogued.',                                                        soon: false },
            { id: 'V.03 — MORPH',    name: 'Morphology',         desc: 'Ticker variant detection. ETTE, GIRL, LADY, QUEEN, WIFE suffix patterns. Derivative naming caught every time.',                                         soon: false },
            { id: 'V.11 — X',        name: 'Twitter / X Signal', desc: 'Real-time CT groupings from X alpha accounts. Same extraction logic as Telegram — but from the loudest room in crypto.',                               soon: true  },
            { id: 'V.12 — NEWS',     name: 'News Signals',       desc: 'Crypto news correlation engine. When a narrative hits the press, BetaPlays finds the on-chain plays before the crowd.',                                soon: true  },
          ].map((v, i) => (
            <div className="lp-vec" key={i}>
              <div className="lp-vec-id">{v.id}</div>
              <div className="lp-vec-name">{v.name}</div>
              <div className="lp-vec-desc">{v.desc}</div>
              {v.soon && <span className="lp-vec-soon">COMING SOON</span>}
            </div>
          ))}
        </div>
      </section>

      {/* ── STATS ── */}
      <div className="lp-stats-band">
        <div className="lp-label">BY THE NUMBERS</div>
        <h2 className="lp-section-title">BUILT TO<br />NEVER MISS.</h2>
        <div className="lp-stats-grid">
          {[
            { num: '11', suf: '×', label: 'DETECTION VECTORS'  },
            { num: '5',  suf: '+', label: 'LIVE ALPHA SOURCES'  },
            { num: '24', suf: '/7',label: 'ALWAYS SCANNING'     },
            { num: '0',  suf: '$', label: 'TO START EXPLORING'  },
          ].map((s, i) => (
            <div className="lp-stat-box" key={i}>
              <div className="lp-stat-num">{s.num}<em>{s.suf}</em></div>
              <div className="lp-stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── FOR PROJECTS ── */}
      <section className="lp-section" id="projects">
        <div className="lp-projects-intro">
          <div>
            <div className="lp-label">FOR PROJECTS</div>
            <h2 className="lp-section-title">GET YOUR BETA<br />DISCOVERED.</h2>
          </div>
          <p className="lp-section-sub">
            BetaPlays surfaces betas organically — but if you want guaranteed placement
            in front of degens already hunting the narrative, we have two options.
            Transparent. On-chain verified.
          </p>
        </div>
        <div className="lp-projects-grid">
          <div className="lp-proj-card">
            <div className="lp-proj-accent lp-acc-purple" />
            <div className="lp-proj-tag lp-tag-boost">⚡ BOOSTED</div>
            <div className="lp-proj-title">Already on the list?<br />Rank higher.</div>
            <div className="lp-proj-desc">
              Your token was organically detected by our engine. Pay to pin it at the top
              of its alpha&apos;s beta row — AND get injected as a standalone card in the main
              alpha feed for maximum visibility. You keep your organic badge. Transparency
              is a trust feature.
            </div>
            <div className="lp-proj-price">1 SOL / 24 HOURS · <strong>3 SLOTS MAX FEED-WIDE</strong></div>
          </div>
          <div className="lp-proj-card">
            <div className="lp-proj-accent lp-acc-green" />
            <div className="lp-proj-tag lp-tag-list">📋 LISTED</div>
            <div className="lp-proj-title">New token?<br />Buy your placement.</div>
            <div className="lp-proj-desc">
              Your token doesn&apos;t need to be organically detected. Pay to place it as a beta
              under a specific alpha you choose. Reach degens already in the narrative and
              actively looking for plays. Self-serve. Instant.
            </div>
            <div className="lp-proj-price">1 SOL / 24 HOURS · <strong>2 SLOTS MAX PER ALPHA</strong></div>
          </div>
        </div>
      </section>

      {/* ── PARTNERSHIP ── */}
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

      {/* ── FINAL CTA ── */}
      <section className="lp-cta-section">
        <div className="lp-cta-inner">
          <div className="lp-cta-orb" />
          <div className="lp-cta-text">
            <h2>READY TO FIND<br />YOUR BETA?</h2>
            <p>FREE TO EXPLORE · SOLANA · NO SIGNUP · FULL SIGNAL STACK UNLOCKABLE</p>
          </div>
          <button className="lp-btn-large" onClick={() => navigate('/app')}>
            LAUNCH APP →
          </button>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="lp-footer">
        <div className="lp-footer-top">
          <div className="lp-footer-brand">
            <a href="#" className="lp-footer-brand-logo">
              <img src="/betaplays-logo.png" alt="BetaPlays" />
              <span>BETA<em>PLAYS</em></span>
            </a>
            <p className="lp-footer-tagline">
              The first discovery tool that finds and matches betas to alphas.
              Miss runners, bet on derivatives, ride the wave.
            </p>
          </div>
          <div className="lp-footer-cols-row">
            <div className="lp-footer-col">
              <h4>PRODUCT</h4>
              <button onClick={() => navigate('/app')}>Launch App</button>
              <a href="#how">How It Works</a>
              <a href="#vectors">Detection Signals</a>
              <a href="#projects">For Projects</a>
            </div>
            <div className="lp-footer-col">
              <h4>COMMUNITY</h4>
              <a href="https://twitter.com/betaplaysai" target="_blank" rel="noreferrer">Twitter / X</a>
              <a href="https://t.me/betaplays" target="_blank" rel="noreferrer">Telegram</a>
              <a href="https://github.com/AdedamolaUX/beta-plays" target="_blank" rel="noreferrer">GitHub</a>
            </div>
            <div className="lp-footer-col">
              <h4>ECOSYSTEM</h4>
              <a href="https://solana.com" target="_blank" rel="noreferrer">Solana</a>
              <a href="https://jup.ag" target="_blank" rel="noreferrer">Jupiter Swap</a>
              <a href="https://dexscreener.com" target="_blank" rel="noreferrer">DEXScreener</a>
              <a href="https://birdeye.so" target="_blank" rel="noreferrer">Birdeye</a>
            </div>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <div className="lp-footer-copy">© 2026 BETAPLAYS · BETAPLAYS.FUN</div>
          <div className="lp-footer-legal">NOT FINANCIAL ADVICE · DYOR · ALL TRADING CARRIES RISK</div>
        </div>
      </footer>
    </div>
  )
}

export default LandingPage