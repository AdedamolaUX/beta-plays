# BetaPlays — Full Project Brief
> Last updated: Session 10 (March 12, 2026). Update this file at the end of every session and replace the version in the Claude Project.

---

## 🧭 What Is BetaPlays?

BetaPlays is a **Solana-native crypto token discovery app** — similar to DEXScreener but focused on the "beta play" concept: identifying **alpha tokens** (narrative runners/pumpers) and surfacing **beta tokens** (correlated derivative plays) so degens can get exposure to a narrative even after the alpha has already moved.

> **Analogy:** If $WIF pumps hard, certain dog-themed Solana tokens typically follow. BetaPlays maps those relationships automatically so you don't have to find them manually.

**GitHub Repo:** `https://github.com/AdedamolaUX/beta-plays`
**GitHub Username:** `AdedamolaUX`
**OS:** Windows

---

## 🏗️ Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite (JavaScript, not TypeScript) |
| Backend | Node.js + Express v5 |
| Deployment | Render (auto-deploy on GitHub push) |
| Chain | Solana only (MVP scope) |
| Package Manager | npm |
| Node Version | v24.12.0 |

**Local paths:**
- Project root: `C:\Users\USER\beta-plays`
- Frontend: `C:\Users\USER\beta-plays\src`
- Backend: `C:\Users\USER\beta-plays\server\index.js`
- Backend env: `C:\Users\USER\beta-plays\server\.env`

**How to run locally (two PowerShell windows):**
```powershell
# Window 1 — Backend
cd C:\Users\USER\beta-plays
node server/index.js
# Prints: BetaPlays backend on port 3001

# Window 2 — Frontend
cd C:\Users\USER\beta-plays
npm run dev
# App at http://localhost:5173/
```

---

## 🌐 Deployed URLs

| Service | URL | Status (March 12) |
|---|---|---|
| Backend | `https://beta-plays.onrender.com` | ⚠️ SUSPENDED — free tier exceeded |
| Frontend | `https://betaplays-frontend.onrender.com` | May still serve static files |

> Render free tier suspended March 12. Backend works on localhost only until billing resets. Add `OPENROUTER_API_KEY` to Render env vars when backend resumes.

---

## 🔑 API Keys & Environment

**`server/.env` must contain:**
```
GROQ_API_KEY=your_groq_key
GEMINI_API_KEY=your_gemini_key
BIRDEYE_API_KEY=your_birdeye_key
OPENROUTER_API_KEY=your_openrouter_key   ← new Session 10, free at openrouter.ai
PORT=3001
```

**Render env variables (Backend service):**
- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `BIRDEYE_API_KEY`
- `OPENROUTER_API_KEY`

**Render env variables (Frontend Static Site):**
- `VITE_BACKEND_URL` = `https://beta-plays.onrender.com` ← NO trailing slash

---

## 🤖 AI Architecture — Full Fallback Chain

All AI keys are **module-level constants** in `server/index.js` (not local to functions).

### /api/score-betas (Vector 8) and /api/categorize-szn
Both endpoints use the same 6-model fallback chain:

| # | Provider | Model | Daily Limit |
|---|---|---|---|
| 1 | Groq | llama-3.3-70b-versatile | 100K TPD |
| 2 | Groq | meta-llama/llama-4-scout-17b-16e-instruct | separate quota |
| 3 | Groq | llama-3.1-8b-instant | 500K TPD |
| 4 | OpenRouter | meta-llama/llama-3.3-70b-instruct:free | 200 req/day |
| 5 | OpenRouter | deepseek/deepseek-r1:free | 200 req/day |
| 6 | OpenRouter | google/gemini-2.0-flash-exp:free | generous |

On 429: logs warning, tries next model. All exhausted → returns 429 "Resets at midnight UTC".
OpenRouter skipped gracefully if `OPENROUTER_API_KEY` not set.

### /api/analyze-vision
- Primary: Gemini Flash
- Fallback: Groq vision (on 429/RESOURCE_EXHAUSTED)
- Rate limited: 20 req/min (own bucket)

### /api/expand-alpha (Vector 0)
- Vector 0A text: Groq llama-3.1-8b-instant (fast, 500K TPD)
- Vector 0B image: Gemini → Groq vision fallback

---

## 🔍 Beta Detection Engine — 9 Vectors

> ⚠️ **Vector numbers represent signal identity, not execution order.**
> Execution order: 1 → 1b → 2 → 3 → 4 → 5 → 6 → sibling scan → 9 → 8
> Vector 8 (AI classification) runs last despite its lower number because it
> is the most expensive signal — it classifies relationships after all candidates
> are already discovered and pre-enriched by cheaper signals including Vector 9.

| Vector | Signal | Notes |
|---|---|---|
| 0A | Text expansion | Groq 8b-instant → searchTerms + relationshipHints |
| 0B | Image expansion | Gemini → Groq vision → visualTerms + mood |
| 1 | Keyword + name search | DEXScreener search API |
| 1b | Description keyword search | Searches alpha description keywords |
| 2 | Lore map | Hardcoded narrative relationships (lore_map.js) |
| 3 | Morphology/ticker variants | Pattern-based symbol mutations |
| 4 | PumpFun trending | PumpFun API scan |
| 5 | LP pair scraping | Direct liquidity pair detection |
| 6 | OG exact-match scan | 3-pass: symbol search → lowercase name → localStorage recovery. MIN_LIQUIDITY $250. Tags 'og_match' → "OG" signal badge |
| 8 | Relationship classification | 70b → scout-17b → 8b → OpenRouter. Classifies: TWIN/COUNTER/ECHO/UNIVERSE/SECTOR/EVIL_TWIN/SPIN |
| 9 | Bidirectional description match | Checks each beta candidate's OWN description for (1) explicit alpha symbol/name reference and (2) keyword overlap with alpha narrative keywords. Zero API calls, zero AI quota. Tags 'desc_match' → "NAMED" badge. Runs before Vector 8 so AI gets pre-enriched signals. |

**Vector 8 prompt rules (important):**
- No $ prefix on symbols in prompt (causes "monetary concepts" hallucinations)
- No market cap line (another $ source)
- EVIL_TWIN requires explicit dark/evil evidence — name ambiguity alone is NOT sufficient
- Description overrides name inference — friendly description = NOT COUNTER or EVIL_TWIN
- Post-filter blocks: "both are crypto", "dollar sign", "monetary concepts", "meme token", "solana token"

---

## 🧬 Parent Alpha Detection (useParentAlpha.js)

Finds the "origin" token for any derivative runner.

**Quality filters — all must pass:**
1. `cMcap > alpha.mcap * 0.5` (original guard, kept)
2. `cLiq > $10K` (absolute floor)
3. Tiered liq/mcap ratio (dynamic, scales with mcap):
   - < $100K mcap → 1.0% minimum ratio
   - $100K–$1M → 2.0%
   - $1M–$10M → 1.0%
   - $10M–$100M → 0.5%
   - > $100M → 0.2%
   - Catches frozen/rugged tokens like $52M mcap / $19K liq (0.036%) → FAIL
4. Parent mcap > runner mcap is NOT required — derivatives regularly outperform parents

**mcapBoost:** normalized against $1B (prefers large established parents in tiebreaks)

**Parent map storage:**
- Key: `betaplays_parent_map`
- Structure: `{ [derivativeAddress]: { symbol, address } }`
- Written by: `saveParentToHistory` in useParentAlpha
- Read by: AlphaCard (DERIV badge), useBetas (sibling confirmation)

**DERIV badge:** Shows "DERIV of $TRUMP" in AlphaCard sidebar. Falls back to "DERIV" if parent not yet detected. Uses `useMemo` (NOT `React.useMemo` — React is not default imported).

---

## 👥 Sibling Detection Logic

A token qualifies as a sibling of the current alpha if:
1. Not the current alpha itself
2. Not already in the merged beta list
3. **If it IS a live alpha:** must share the same confirmed parent address (co-derivative). Otherwise excluded — independent runners are never siblings.
4. **If it has a parent map entry:** that parent address must match current alpha's parent exactly
5. Must have corroborating signal (keyword/morphology/og_match/lore/description/pumpfun/lp_pair)

**Logs:**
- `[Siblings] Filtered $X — live alpha, unconfirmed co-derivative`
- `[Siblings] Filtered $X — different parent ($Y vs $Z)`
- `[Siblings] Filtered noise $X — sibling-only, no corroborating signal`
- `[Siblings] Kept $X — live alpha but confirmed co-derivative of $Y`

> ⚠️ Old sibling data cached in localStorage. To clear: `Object.keys(localStorage).filter(k=>k.startsWith('betaplays_betas')).forEach(k=>localStorage.removeItem(k))` + `localStorage.removeItem('betaplays_parent_map')`

---

## 💰 Price Refresh Flow

### Alpha prices (useAlphas.js)
1. **freshBonded pass:** catches mcap ≤ $80K + 0% change in freshRaw BEFORE saveToHistory → real price stamped immediately
2. **saveToHistory guard:** blocks stale bonding price if priceRefreshedAt exists and prev mcap > $80K
3. **refreshHistoricalPrices:** catches isStuckAtBonding in localStorage regardless of lastSeen age
4. **patchedLive:** patches live runners from localStorage if priceRefreshedAt stamped
5. **loadHistoricalByPriceAction:** recomputes dexUrl from token address on every load

### Beta prices (useBetas.js)
`isStalePrice` triggers refresh if ANY of:
- Token only came from pumpfun (never confirmed by DEXScreener)
- priceChange24h === 0 AND mcap ≤ $80K (bonding price)
- Last price refresh > 5 minutes ago ← **new Session 10** (fixes $Claw $73K→$18K)

Refresh batches 30 addresses per DEXScreener `/latest/dex/tokens/` call.
Refreshed prices saved back to localStorage immediately.

### DEXScreener links
All use `baseToken.address` (permanent), never `pairAddress` (changes on PumpFun→PumpSwap migration).

---

## ⚡ Race Condition Guard (useBetas.js)

Every `fetchBetas` call gets a unique `fetchId` via `fetchIdRef`.
All `setBetas`, `setError`, `setLoading` calls check `isStale()` before executing.
If alpha changes mid-fetch, the old fetch discards results silently.
Prevents Token A betas appearing on Token B when switching quickly.

---

## 📺 Beta Panel UX

**New alpha selected:** Starts blank immediately — no stale betas from previous alpha flash on screen. `lastAlphaRef` tracks currently displayed alpha address.

**Same alpha re-selected:** Shows stored betas instantly while fresh fetch runs in background.

**Loading skeleton:** Only shows when `betasLoading && filteredBetas.length === 0`. Never hides betas behind skeletons.

---

## 📦 LocalStorage Keys Reference

| Key | Contents | TTL |
|---|---|---|
| `betaplays_seen_alphas` | All historical alpha tokens | 30 days |
| `betaplays_betas_v2` | Stored betas per alpha address | 7 days |
| `betaplays_parent_map` | derivativeAddress → { symbol, address } | permanent |
| `betaplays_v0_cache` | Vector 0 expansion cache | 6h |
| `betaplays_szn_cache_v1` | Narrative categorization | 24h |
| `betaplays_score_cache_v1` | AI beta scoring | 30 min |
| `betaplays_vision_cache_v1` | Logo vision analysis | 24h |
| `betaplays_watchlist_v1` | Starred tokens | permanent |
| `betaplays_beta_spawn_counts` | Beta spawn tracking | permanent |
| `betaplays_flags` | Community flags (rug/honeypot/legit) | permanent |

---

## 🗺️ Signal Tiers & Badges

| Tier | Signals | Badge |
|---|---|---|
| T1 (strongest) | lp_pair | LP PAIR |
| T2 | ai_match + keyword/morphology, desc_match + ai_match/keyword | AI MATCH / CABAL |
| T3 | keyword, lore, morphology, og_match, desc_match | OG / KEYWORD / NAMED etc |
| T4 | pumpfun, sibling, description | CABAL / SIBLING |

**desc_match combos:**
- desc_match + keyword/ai_match/morphology → CABAL (tier 5)
- desc_match alone → NAMED (tier 4)
- matchType 'explicit': beta description directly names the alpha symbol/name
- matchType 'keyword_overlap': beta description shares 2+ narrative keywords with alpha

---

## 📋 Development Roadmap

### Phase 0 — Setup ✅ Complete
### Phase 1 — Core MVP ✅ Complete
### Phase 2 — Enhancement 🔄 In Progress

**Done (Sessions 1–10):**
- 8-vector beta detection engine ✅
- Parent alpha detection with tiered liq/mcap ratio filter ✅
- DERIV badge with parent name ✅
- Sibling detection with two-way parent confirmation ✅
- Race condition guard on fetchBetas ✅
- Beta price 5-min TTL refresh ✅
- Stored betas UX (blank on new alpha, instant on re-select) ✅
- OG scan 3-pass (Vector 6) ✅
- Vector 8 prompt fixes ($ prefix, EVIL_TWIN, hallucination filter) ✅
- 6-model AI fallback chain (Groq × 3 + OpenRouter × 3) ✅
- All API keys at module level (no more "GROQ_KEY is not defined") ✅
- Alpha dexUrl always uses token address (not stale pair address) ✅
- Freshly migrated token price correction (freshBonded pass) ✅
- patchedLive for live runners stuck at bonding price ✅
- Nomination system + admin panel ✅
- Beta ranking system ✅
- FlagButton (rug/honeypot/legit) ✅
- Narrative Szn tab ✅
- Watchlist ✅
- Token detail drawer ✅
- Birdeye intel strip ✅
- Community flagging ✅

**Still to do:**
- Analytics expansion (holder analysis, on-chain wallet, social sentiment)
- Vision "invalid image data" edge cases (low priority)

### Phase 3 — Monetization 📋 Not Started
- 1 SOL listing fee for project teams
- Treasury wallet + Solana wallet adapter

### Phase 4 — Launch 📋 Not Started
- Custom domain, landing page, alpha curation, launchpad badges

### Phase 5 — Scale 📋 Not Started
- Server-side shared AI cache (Supabase or Redis/Upstash)
- Multichain support
- X/Twitter API (post-monetization only — $100/month minimum)

---

## ⚠️ Known Issues

1. **$joy/$mogging sibling:** Old cached sibling data in localStorage. Clear with console command above.
2. **Render backend suspended:** Free tier exceeded March 12. Resets on billing period.
3. **Vector 0 fires 3× for same alpha:** `fetchBetas` called multiple times — noted, not yet fixed.
4. **Vision invalid image edge cases:** Some images pass magic byte check but Groq still rejects.
5. **localStorage is per-user:** At scale, every new user re-burns AI quota on same tokens. Fix: server-side shared cache (Phase 5).

---

## 💻 Ground Rules

1. **No ego massaging** — call out bad ideas directly
2. **Always commit before new features** — `git add . && git commit -m "..." && git push`
3. **Never build on `/mnt/project/` files** — stale as of March 6
4. **Output files (`/mnt/user-data/outputs/`) are latest** — user does not make manual edits
5. **Always ask for current file** if output file might be outdated
6. **One feature at a time**
7. **Explain every decision in plain English** — builder is technically a novice
8. **React imports:** named only — `{ useState, useMemo, useCallback, useRef, useEffect }`. Never `React.useMemo` etc.

---

*Updated end of Session 10 — March 12, 2026. Final feature: Vector 9 bidirectional description match.*
