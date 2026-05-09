// ─── Vector 8: AI Relationship Classification ────────────────────
// Replaced pure scoring with classification — Vector 0 now generates
// semantically targeted search terms, so candidates are already
// relevant. Vector 8's job is to confirm and classify WHY each
// token is a beta, not just whether it is.
//
// Relationship types:
//   TWIN      — synonym/equivalent concept ($SHELTER for $HOUSECOIN)
//   COUNTER   — opposite side of same narrative ($LANDLORD for $HOUSECOIN)
//   ECHO      — narrative consequence ($EVICTION for $HOUSECOIN)
//   UNIVERSE  — same fictional/cultural world ($SASUKE for $NARUTO)
//   SECTOR    — same industry/space peer ($CURSOR for $CLAUDE)
//   EVIL_TWIN — dark/inverted variant ($DARKSHIBA for $SHIBA)
//   SPIN      — general derivative, weaker connection

const BACKEND_URL  = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const MIN_SCORE    = 0.55   // Raised from 0.45 — tighter gate, reduces false positives
const BATCH_SIZE   = 8
const CACHE_TTL_MS = 10 * 60 * 1000  // 10 min — longer than before, results are stable

// In-memory layer — instant repeat lookups within the same session.
// Neon is the durable backing store: one AI call serves ALL users across restarts.
const classifyCache = new Map()

const getCacheKey = (alphaAddress, betaAddresses) =>
  `${alphaAddress}:${[...betaAddresses].sort().join(',')}`

// Check Neon cache first, then in-memory. Returns null if not found/expired.
const getScoreCache = async (key) => {
  // Memory first — instant
  const mem = classifyCache.get(key)
  if (mem && Date.now() - mem.timestamp < CACHE_TTL_MS) return mem

  // Neon fallback — shared across all users and restarts
  try {
    const res = await fetch(`${BACKEND_URL}/api/cache/score?key=${encodeURIComponent(key)}`)
    if (res.ok) {
      const { hit, data } = await res.json()
      if (hit && data) {
        // Promote to memory
        const entry = { results: data.results, rejectedAddresses: new Set(data.rejectedAddresses || []), timestamp: Date.now() }
        classifyCache.set(key, entry)
        return entry
      }
    }
  } catch { /* non-fatal — fall through to AI */ }
  return null
}

// Save to both memory and Neon
const setScoreCache = (key, results, rejectedAddresses) => {
  const entry = { results, rejectedAddresses, timestamp: Date.now() }
  classifyCache.set(key, entry)
  // Persist to Neon — rejectedAddresses is a Set, convert to array for JSON
  fetch(`${BACKEND_URL}/api/cache/score`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ key, data: { results, rejectedAddresses: [...rejectedAddresses] } }),
  }).catch(() => {})
}

// ─── Classification prompt ────────────────────────────────────────
const buildClassificationPrompt = (alpha, candidates, relationshipHints = {}) => {
  // Description is the most reliable signal — it tells us what the token
  // actually IS, not just what its symbol pattern suggests.
  // When present, it becomes the explicit narrative frame: the AI must classify
  // candidates in the context of the DESCRIPTION, not the symbol alone.
  // This prevents hallucination like $LANDLORD scoring as a COUNTER for $HUGH
  // (a raccoon) just because "HUGH" superficially resembles "HOUSE".
  // Add visual context from V0B if available — helps AI understand abstract tokens
  const visualCtxLines = []
  if (alpha.visualTerms?.length) {
    visualCtxLines.push(`Logo depicts: ${alpha.visualTerms.join(', ')}`)
  }
  if (alpha.visualCounters?.length) {
    visualCtxLines.push(`Visual opposites (valid counter-betas): ${alpha.visualCounters.join(', ')}`)
  }
  const visualCtxStr = visualCtxLines.length
    ? '\nVISUAL CONTEXT:\n' + visualCtxLines.map(l => '  ' + l).join('\n')
    : ''

  const alphaContext = alpha.description
    ? [
        `Symbol: ${alpha.symbol}`,
        alpha.name && alpha.name.toLowerCase() !== alpha.symbol.toLowerCase()
          ? `Name: ${alpha.name}` : null,
        visualCtxStr || null,
        `⚠️  NARRATIVE FRAME — evaluate candidates two ways:

1. WORD-BY-WORD: Decompose the description into individual concepts first.
   "${alpha.description}"
   Each word is a separate concept. A candidate matching ANY ONE is a valid beta:
   - Matches all concepts → strong beta (0.8-1.0)
   - Matches one or some concepts → moderate beta (0.5-0.7, classify as UNIVERSE or SECTOR)
   - Matches no concepts at all → reject (0.1)

2. WHOLE PHRASE: Also evaluate the description as a unified concept.
   What does the full phrase mean together? What cultural/thematic world does it reference?
   A candidate fitting that whole-phrase meaning is also a valid beta even if it
   doesn't match any individual word.

Both evaluations run. The higher score wins.`,
      ].filter(Boolean).join('\n')
    : [
        `Symbol: ${alpha.symbol}`,
        alpha.name ? `Name: ${alpha.name}` : null,
        visualCtxStr || null,
      ].filter(Boolean).join('\n')

  // Inject hints from Vector 0 — but only when they don't contradict the description.
  // If a description exists, hints are secondary: the description is ground truth.
  // Mark them clearly so the AI knows they are suggestions, not facts.
  const hintsText = Object.keys(relationshipHints).length > 0
    ? `\n${alpha.description
        ? 'SUPPLEMENTARY HINTS (lower priority than the description above — discard any hint that contradicts the narrative frame):'
        : 'NARRATIVE HINTS from concept expansion:'
      }\n${
        Object.entries(relationshipHints)
          .map(([term, type]) => `  "${term}" → ${type}`)
          .join('\n')
      }`
    : ''

  const candidateList = candidates.map((c, i) => {
    const lines = [
      `[${i}] ${c.symbol}`,
      c.name        ? `    Name: ${c.name}`               : null,
      c.description ? `    Description: ${c.description}` : null,
    ]
    // Show which signals found this candidate — helps AI weight accordingly.
    // e.g. "found by: keyword, lore" vs "found by: og_match" tells the AI
    // whether the match is structural/on-chain or just text-similarity-based.
    if (c.signalSources?.length) {
      const readable = c.signalSources
        .filter(s => !['ai_match','visual_match'].includes(s))  // exclude meta signals
        .join(', ')
      if (readable) lines.push(`    Found by: ${readable}`)
    }
    // Pass visual signal to AI if vision ran on this candidate.
    if (c.visualScore != null) {
      const strength = c.visualScore >= 0.7 ? 'STRONG' : 'MODERATE'
      lines.push(
        `    🔍 VISUAL SIGNAL (${strength}, score: ${c.visualScore.toFixed(2)}): "${c.visualReason || 'logo visually related to alpha'}"`
      )
    }
    return lines.filter(Boolean).join('\n')
  }).join('\n\n')

  return `You are a crypto-native degen analyst on Solana CT (Crypto Twitter).
You know every meme, lore cluster, and narrative trend that moves tokens.
Your job: identify genuine beta plays for the alpha — tokens that degens will ape
into BECAUSE the alpha is running, due to shared lore, universe, or narrative opposition.

Think like a degen: if $HANTA pumps, you immediately think $RAT, $RATWIF, $PFIZER,
$VACCINE — because you know rats carry hantavirus and pharma tokens follow disease narratives.
If $SASUKE pumps, you think $NARUTO, $SAKURA, $ITACHI — same anime universe.
If $PEPE pumps, you think $WOJAK (COUNTER), $BABYPEPE (ECHO), $KERMIT (TWIN).
This is the quality of reasoning required. Superficial connections are rejected.

TASK: You are looking at your wallet right now. The alpha just pumped hard.
You have 60 seconds to find the next token to ape before CT catches on.
Which of these candidates would you immediately buy? Which would any degen on CT
instinctively connect to this alpha when it's running?
That is the quality of reasoning required — not academic narrative connection,
but degen urgency and CT pattern recognition.

ALPHA TOKEN:
${alphaContext}${hintsText}

CANDIDATE TOKENS:
${candidateList}

RELATIONSHIP TYPES — pick the best fit:
  TWIN      = same concept, synonym, or equivalent — different token, same idea
              Examples: $PEPE → $PEEPO, $FROG, $KERMIT | $LOL → $LMAO, $HAHA, $GIGGLE
  COUNTER   = opposite pole of the same narrative — exists BECAUSE the alpha exists
              Examples: $PEPE → $WOJAK, $CHAD | $BULL → $BEAR | $PUMP → $DUMP
              Key test: would traders think of this token WHEN the alpha pumps?
  ECHO      = consequence, child, or continuation of the same narrative
              Examples: $TRUMP → $MAGA, $MELANIA | $PEPE → $PEPEWIF, $BABYPEPE
  UNIVERSE  = same fictional world, franchise, or cultural reference
              Examples: $BATMAN → $JOKER, $ROBIN | $MARIO → $LUIGI, $BOWSER
  SECTOR    = same thematic category but not directly related
              Examples: $WIF → $BONK (both dog coins) | $GPT → $CLAUDE (both AI)
  EVIL_TWIN = explicitly dark/inverted version — description must confirm it
  SPIN      = loose or weak derivative — include if score ≥ 0.45, exclude below

For each candidate:
1. Read the description carefully — it often reveals the exact narrative intent
   ("the laughter token" for $LOL confirms TWIN for other emotion/humor tokens)

2. Apply the 60-SECOND APE TEST before scoring:
   Would a degen scrolling CT right now, seeing the alpha pump, IMMEDIATELY think
   of this candidate and ape it without needing to research the connection?
   - YES, instantly obvious → 0.8–1.0
   - YES, after a second of thought → 0.6–0.79
   - MAYBE, only if they know the lore deeply → 0.45–0.59 (SPIN)
   - NO, they would not connect these → 0.0–0.44 (reject)

   KEY DISTINCTION — quality over connection:
   A token can be narratively connected but NOT a quality beta.
   "Both are meme tokens on Solana" = connected but NOT a beta (0.1).
   "This is the rat token and the alpha is a virus token — rats carry viruses" = quality beta (0.8).
   Score for DEGEN URGENCY, not academic correctness.

3. Score 0.0–1.0:
   0.8–1.0  Instant — CT would ape this immediately, connection is obvious to any degen
   0.6–0.79 Strong — clear thematic link, degen would notice within seconds
   0.45–0.59 Plausible — same space, weaker link, include as SPIN
   0.0–0.44 Reject — CT would not connect these when the alpha pumps
   If a VISUAL SIGNAL is present, raise score by +0.2 (STRONG) or +0.1 (MODERATE)

4. One-sentence reason — write it like a degen explaining to a friend why they're aping:
   BAD: "Meme concept alignment with similar thematic elements"
   GOOD: "Rats carry hantavirus — $RAT is the obvious play when $HANTA pumps"
   GOOD: "Wojak is Pepe's eternal counterpart — always runs when Pepe runs"
   GOOD: "Same Naruto universe — Sakura always follows Sasuke on CT"

CT NAMING PATTERN AWARENESS:
Degens construct token names by combining narrative elements with CT suffixes/prefixes.
When evaluating a candidate, look past the full name to the component parts:
- "[subject]wif[item]" = subject wearing item (ratwifmask = rat wearing mask)
- "baby[subject]" = diminutive/child version of subject
- "evil[subject]" / "dark[subject]" = inverted version
- "[subject]inu" / "[subject]cat" / "[subject]pepe" = cultural crossover
If a candidate's NAME components connect to the alpha's narrative — even if the full
name looks unrelated — it IS a beta. $RATWIFMASK for $HANTA: rat (carrier) + wif (CT
suffix) + mask (pandemic response) = valid ECHO. Score it accordingly.

ADJACENT REAL-WORLD ENTITIES RULE:
When a narrative involves a real-world threat, event, or domain, degens tokenise the
entire ecosystem around it — not just the subject itself. Valid beta types include:
- Disease tokens → carriers, pharma companies, vaccines, government health agencies
- Political tokens → rivals, parties, family members, historical precedents
- Space tokens → agencies (NASA), companies (SpaceX), missions, celestial bodies
- War/conflict tokens → weapons, countries, military branches, historical battles
Score these ECHO or SECTOR (0.6+) when the connection is clear to any degen.
$PFIZER for $HANTA = SECTOR (pharma responds to disease outbreak) — score 0.65+.
$CDC for $HANTA = SECTOR (government response agency) — score 0.65+.
$RAT for $HANTA = TWIN (rats are the primary hantavirus carrier) — score 0.8+.

INVALID REASONS (always score 0.1):
- "Both are cryptocurrencies / meme tokens / Solana tokens"
- "Both reference the dollar sign / monetary concepts"
- "Both have similar market structure"
- "Both relate to finance/currency/wealth" (unless alpha's theme IS explicitly financial)
- "Both are internet slang / humor tokens" when alpha is a CHARACTER, ANIME, GAMING, or SPORTS token
- Internet slang tokens ($LOL, $LMAO, $KEK, $ROFL, $HAHA) are NOT valid betas for character/anime/gaming/sports tokens
- Generic emotion tokens are NOT related to specific narrative tokens unless the alpha IS explicitly humor/meme themed
- "Both are meme tokens" — this alone is never a valid reason

CROSS-UNIVERSE REJECTION RULE:
If the alpha is clearly in one universe (anime, gaming, sports, political, animals) and the candidate
is purely internet slang or humor ($LOL, $KEK, $LMAO, $ROFL, $HAHA, $GG, $AYY) with no connection
to that universe → score 0.1 UNRELATED regardless of thematic stretch.

DESCRIPTION RULE: If a description contradicts a negative name interpretation,
the description wins. "Dark Pepe" + description "wholesome frog art" = UNIVERSE not EVIL_TWIN.

CALIBRATION EXAMPLES — use these to anchor your scoring:

Alpha = $PEPE (Pepe the Frog):
  $WOJAK → 0.9 COUNTER — Pepe's eternal narrative opposite, always runs together on CT
  $KERMIT → 0.75 TWIN — different frog, same frog meme universe, CT treats them as related
  $BABYPEPE → 0.8 ECHO — direct child/derivative of Pepe narrative, CT spins these immediately
  $DOGE → 0.45 SECTOR — both classic memes but different universes, weaker play
  $SOL → 0.1 UNRELATED — just the chain, CT would not ape $SOL when $PEPE pumps

Alpha = $HANTA (Hantavirus):
  $RAT → 0.85 TWIN — rats are the primary hantavirus carrier, instant CT connection
  $RATWIFMASK → 0.75 ECHO — rat (carrier) + wif (CT suffix) + mask (pandemic) = clear degen construction
  $PFIZER → 0.65 SECTOR — pharma response to disease outbreak, CT tokenises the whole ecosystem
  $VIRUS → 0.8 TWIN — direct synonym, CT apes all virus tokens when one runs
  $PEPE → 0.1 UNRELATED — no connection to disease/virus narrative

Alpha = $SASUKE (Naruto anime):
  $NARUTO → 0.9 UNIVERSE — same anime, CT apes the whole cast when one character runs
  $ITACHI → 0.85 UNIVERSE — Sasuke's brother, deeply connected in Naruto lore
  $SAKURA → 0.75 UNIVERSE — same team, CT knows the connection immediately
  $LOL → 0.1 UNRELATED — internet slang, no connection to anime universe
  $NINJA → 0.55 SECTOR — related theme but not specifically Naruto

Respond ONLY with a JSON array, no markdown:
[{"index":0,"score":0.92,"relationshipType":"TWIN","reason":"LMAO is the direct escalation of LOL — same humor/laughter narrative"},{"index":1,"score":0.1,"relationshipType":"UNRELATED","reason":"Internet slang token, alpha is a character token — cross-universe, no connection"}]`
}

// ─── Call backend /api/score-betas ───────────────────────────────
const callBackend = async (prompt) => {
  const response = await fetch(`${BACKEND_URL}/api/score-betas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!response.ok) throw new Error(`Backend error: ${response.status}`)
  const data = await response.json()
  if (!Array.isArray(data)) throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 100)}`)
  return data
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const BATCH_DELAY_MS = 2500

// ─── Process one batch and return results + scores ───────────────
const processBatch = async (alpha, batch, batchNum, relationshipHints) => {
  const prompt  = buildClassificationPrompt(alpha, batch, relationshipHints)
  const results = await callBackend(prompt)

  // Context-aware hallucination filter
  const MONEY_ALPHA_KEYWORDS = [
    'gold','wealth','money','dollar','coin','cash','rich',
    'finance','bank','fund','capital','treasury','yield','profit','buck','dough'
  ]
  const alphaIsMoneyThemed = MONEY_ALPHA_KEYWORDS.some(kw =>
    alpha.symbol?.toLowerCase().includes(kw) ||
    alpha.name?.toLowerCase().includes(kw)
  )
  const ALWAYS_INVALID = [
    'dollar sign','both are crypto','both tokens are',
    'cryptocurrency','meme token','solana token','similar concept',
    // Generic emotion/humor rationalisations — these fire when MetaSeed
    // accidentally feeds humor candidates into non-humor alphas.
    // The AI invents a TWIN relationship ("both are emotion tokens") that
    // has nothing to do with the alpha's actual narrative.
    'emotion token','humor token','laughter token','comedy token',
    'both represent','both are emotion','both express','reaction token',
  ]
  const MONETARY_IF_NOT_THEMED = ['monetary','dollar','currency','financial']
  const isHallucination = (reason = '') => {
    const lower = reason.toLowerCase()
    if (ALWAYS_INVALID.some(p => lower.includes(p))) return true
    if (!alphaIsMoneyThemed && MONETARY_IF_NOT_THEMED.some(p => lower.includes(p))) return true
    return false
  }

  const classified      = []
  const rejectedInBatch = []

  // Log ALL scores for tuning — not just passing ones
  console.log(`[Vector8] Batch ${batchNum} scores for $${alpha.symbol}:`)
  results.forEach(r => {
    const candidate = batch[r.index]
    if (!candidate) return
    const pass = r.score >= MIN_SCORE && !isHallucination(r.reason)
    if (!pass && r.score >= MIN_SCORE) {
      console.log(`  🚫 $${candidate.symbol} — blocked hallucination: "${r.reason}"`)
    }
    console.log(
      `  ${pass ? '✅' : '❌'} $${candidate.symbol} — score: ${r.score} | type: ${r.relationshipType} | ${r.reason}`
    )
    if (pass) {
      classified.push({
        ...candidate,
        aiScore:          r.score,
        relationshipType: r.relationshipType || 'SPIN',
        aiReason:         r.reason,
        signalSources:    [...(candidate.signalSources || []), 'ai_match'],
      })
    } else {
      rejectedInBatch.push(candidate.address)
    }
  })

  // Any candidate not mentioned in results = AI skipped it = treat as rejected
  const mentionedIndices = new Set(results.map(r => r.index))
  batch.forEach((c, i) => {
    if (!mentionedIndices.has(i)) {
      console.log(`  ⚠️  $${c.symbol} — not scored by AI (skipped)`)
      rejectedInBatch.push(c.address)
    }
  })

  return { classified, rejectedInBatch }
}

// ─── Main classification function ────────────────────────────────
// Returns { results, rejectedAddresses } — caller uses rejectedAddresses
// to remove confirmed-noise tokens from the beta list.
export const classifyRelationships = async (alpha, candidates, relationshipHints = {}) => {
  if (!alpha || !candidates?.length) return { results: [], rejectedAddresses: new Set() }

  const cacheKey = getCacheKey(
    alpha.address,
    candidates.map(c => c.address || c.id)
  )

  const cached = await getScoreCache(cacheKey)
  if (cached) {
    console.log(`[Vector8] Cache hit for $${alpha.symbol} — ${cached.results.length} classified, ${cached.rejectedAddresses.size} rejected`)
    return { results: cached.results, rejectedAddresses: cached.rejectedAddresses }
  }

  console.log(`[Vector8] Classifying ${candidates.length} candidates for $${alpha.symbol}...`)

  const allClassified      = []
  const allRejectedAddrs   = new Set()

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch    = candidates.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    if (i > 0) {
      console.log(`[Vector8] Throttling — waiting ${BATCH_DELAY_MS / 1000}s before batch ${batchNum}...`)
      await sleep(BATCH_DELAY_MS)
    }

    try {
      const { classified, rejectedInBatch } = await processBatch(alpha, batch, batchNum, relationshipHints)
      allClassified.push(...classified)
      rejectedInBatch.forEach(addr => allRejectedAddrs.add(addr))
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('rate')) {
        console.warn(`[Vector8] Rate limited on batch ${batchNum} — backing off 10s`)
        await sleep(10000)
        try {
          const { classified, rejectedInBatch } = await processBatch(alpha, batch, batchNum, relationshipHints)
          allClassified.push(...classified)
          rejectedInBatch.forEach(addr => allRejectedAddrs.add(addr))
        } catch (retryErr) {
          console.warn(`[Vector8] Retry failed for batch ${batchNum}:`, retryErr.message)
          // Batch failed entirely — don't add to rejected (we simply don't know)
        }
      } else {
        console.warn(`[Vector8] Batch ${batchNum} failed:`, err.message)
        // Batch failed entirely — don't add to rejected (we simply don't know)
      }
    }
  }

  const sorted = allClassified.sort((a, b) => b.aiScore - a.aiScore)
  setScoreCache(cacheKey, sorted, allRejectedAddrs)
  console.log(`[Vector8] $${alpha.symbol} — ✅ ${sorted.length} confirmed, ❌ ${allRejectedAddrs.size} rejected`)

  // Silent failure detection — 0 confirmed AND 0 rejected from a non-empty
  // candidate set means every batch threw an error and was swallowed silently.
  // This is the "0/0" problem that makes V8 invisible when Groq Scout times out.
  if (sorted.length === 0 && allRejectedAddrs.size === 0 && candidates.length > 0) {
    console.warn(
      `[Vector8] ⚠️  $${alpha.symbol} — ALL ${candidates.length} candidates unscored. ` +
      `Every batch failed silently (Groq timeout / malformed JSON). ` +
      `Betas will show as unclassified with no aiReason.`
    )
  }

  return { results: sorted, rejectedAddresses: allRejectedAddrs }
}

// ─── Backward compat alias ────────────────────────────────────────
export const scoreWithAI = (alpha, candidates) =>
  classifyRelationships(alpha, candidates, {})

export default classifyRelationships