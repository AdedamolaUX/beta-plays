// ─── LORE MAP + TICKER MORPHOLOGY ENGINE ────────────────────────

// ─── Morphology Pattern Generator ───────────────────────────────
export const generateTickerVariants = (symbol) => {
  const s = symbol.toUpperCase()

  const variants = new Set()

  // Prefix patterns
  const prefixes = ['BABY', 'MINI', 'MIKO', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
    'BASED', 'REAL', 'OG', 'THE', 'RETRO', 'TURBO', 'CHAD', 'DEGEN', 'FAT', 'TINY']
  prefixes.forEach(p => variants.add(`${p}${s}`))

  // Suffix patterns
  const suffixes = ['INU', 'WIF', 'HAT', 'CAT', 'DOG', 'AI', 'GPT',
    'DAO', 'FI', 'X', '2', '3', 'PLUS', 'PRO', 'MOON', 'PUMP']
  suffixes.forEach(sfx => variants.add(`${s}${sfx}`))

  // Compound patterns
  variants.add(`${s}WIF`)
  variants.add(`WIF${s}`)
  variants.add(`${s}CAT`)
  variants.add(`CAT${s}`)
  variants.add(`${s}DOG`)
  variants.add(`DOG${s}`)

  // Opposite / mirror patterns
  const opposites = {
    BULL: ['BEAR'], BEAR: ['BULL'],
    MOON: ['DOOM', 'RUG'], LONG: ['SHORT'],
    UP: ['DOWN'], PUMP: ['DUMP'],
    RICH: ['POOR'], CHAD: ['VIRGIN', 'BETA'],
    DAY: ['NIGHT'], SUN: ['MOON'],
    HOT: ['COLD'], FAST: ['SLOW'],
    BIG: ['SMALL', 'TINY'], GOOD: ['EVIL', 'BAD'],
    LIGHT: ['DARK'],
    TRUMP: ['BIDEN', 'KAMALA', 'BODEN'],
    BIDEN: ['TRUMP'], PEPE: ['WOJAK'], WOJAK: ['PEPE'],
  }
  if (opposites[s]) opposites[s].forEach(o => variants.add(o))

  // Companion / universe patterns
  const companions = {
    TRUMP: ['MELANIA', 'BARRON', 'IVANKA', 'MAGA', 'BARON'],
    MELANIA: ['TRUMP', 'BARRON'],
    BONNIE: ['CLYDE'], CLYDE: ['BONNIE'],
    TOM: ['JERRY'], JERRY: ['TOM'],
    BATMAN: ['ROBIN', 'JOKER', 'GOTHAM'],
    JOKER: ['BATMAN', 'HARLEY'],
    WIF: ['HAT', 'CATWIF', 'WIFCAT', 'BABYWIF'],
    HAT: ['WIF', 'DOGHAT'],
    BONK: ['BABYBONK', 'BONKWIF', 'MEGABONK'],
    PEPE: ['RARE', 'FEELSGOOD', 'PEPEWIF', 'PEEPO'],
    DOGE: ['SHIB', 'FLOKI', 'BABYDOGE'],
    SHIB: ['DOGE', 'LEASH', 'BONE'],
    SOL: ['BONK', 'WIF', 'POPCAT'],
    AI: ['AGI', 'GPT', 'NEURAL', 'ROBOT', 'AGENT'],
    ELON: ['MUSK', 'TESLA', 'SPACEX', 'MARS', 'X'],
    MUSK: ['ELON', 'TESLA', 'DOGE'],
    POPCAT: ['POPDOG', 'POPELON', 'POPWIF'],
    MYRO: ['BABYMYRO', 'MYROCAT', 'MYROWIF'],
    MARIO: ['LUIGI', 'PEACH', 'WARIO', 'BOWSER', 'TOAD'],
    LUIGI: ['MARIO', 'PEACH', 'WARIO'],
    SONIC: ['TAILS', 'KNUCKLES', 'SHADOW', 'AMY'],
    WALTER: ['JESSE', 'HEISENBERG', 'SKYLER'],
    JESSE: ['WALTER', 'HEISENBERG', 'PINKMAN'],
  }
  if (companions[s]) companions[s].forEach(c => variants.add(c))

  // Size variants
  variants.add(`BABY${s}`)
  variants.add(`GIGA${s}`)
  variants.add(`MINI${s}`)
  variants.add(`MEGA${s}`)
  variants.add(`FAT${s}`)
  variants.add(`TINY${s}`)

  // Remove the alpha itself
  variants.delete(s)

  return Array.from(variants)
}

// ─── LORE MAP ────────────────────────────────────────────────────
const LORE_MAP = {
  // ── Dog / Hat narrative ──
  WIF:    { terms: ['catwif','babywif','wifhat','hat','dogwif','wif'], concepts: ['dog','hat','wif','dogwifhat'], category: 'dogs', universe: 'dogwifhat' },
  BONK:   { terms: ['babybonk','bonkwif','megabonk','bonk'], concepts: ['bonk','dog','solana'], category: 'dogs', universe: 'solana-dogs' },
  MYRO:   { terms: ['babymyro','myrowif','myro'], concepts: ['myro','dog','solana'], category: 'dogs', universe: 'solana-dogs' },
  DOGE:   { terms: ['babydoge','dogecoin','doge','shib','elon','floki'], concepts: ['doge','dog','elon'], category: 'dogs', universe: 'doge-ecosystem' },

  // ── Cat narrative ──
  POPCAT: { terms: ['popdog','popelon','pop','cat'], concepts: ['cat','pop','meme'], category: 'cats', universe: 'pop-memes' },
  MEW:    { terms: ['babymew','mewwif','mew','cat'], concepts: ['cat','mew','solana'], category: 'cats', universe: 'solana-cats' },

  // ── Frog narrative ──
  PEPE:   { terms: ['pepe','frog','rare','feels','pepewif','peepo'], concepts: ['pepe','frog','meme'], category: 'frogs', universe: 'pepe' },

  // ── Political narrative ──
  TRUMP:   { terms: ['maga','america','usa','biden','melania','barron','ivanka'], concepts: ['trump','maga','political','usa'], category: 'political', universe: 'trump-family' },
  BODEN:   { terms: ['biden','joe','hunter','kamala','boden'], concepts: ['political','biden','usa'], category: 'political', universe: 'us-politics' },
  MELANIA: { terms: ['trump','barron','melania'], concepts: ['trump','political','usa'], category: 'political', universe: 'trump-family' },

  // ── AI / Tech narrative ──
  AI16Z:  { terms: ['ai','agent','eliza','degenai','vc','a16z'], concepts: ['ai','agent','tech'], category: 'ai', universe: 'ai-agents' },
  GOAT:   { terms: ['goat','ai','terminal','truth'], concepts: ['ai','goat','terminal'], category: 'ai', universe: 'ai-terminal' },
  CLAUDE: { terms: ['claude','anthropic','ai','llm','sonnet'], concepts: ['ai','claude','anthropic'], category: 'ai', universe: 'ai-models' },
  GPT:    { terms: ['gpt','openai','chatgpt','ai','llm'], concepts: ['ai','gpt','openai'], category: 'ai', universe: 'ai-models' },
  VIBE:   { terms: ['vibecode','vibecoding','cursor','devin','coder'], concepts: ['vibe','coding','ai','dev'], category: 'ai', universe: 'vibecoding' },

  // ── Gaming narrative ──
  MARIO:  { terms: ['mario','luigi','peach','wario','bowser','nintendo'], concepts: ['mario','gaming','nintendo'], category: 'gaming', universe: 'mario' },
  LUIGI:  { terms: ['mario','luigi','peach','wario'], concepts: ['luigi','gaming','nintendo'], category: 'gaming', universe: 'mario' },
  SONIC:  { terms: ['sonic','tails','knuckles','shadow','sega'], concepts: ['sonic','gaming','sega'], category: 'gaming', universe: 'sonic' },
  PIKACHU:{ terms: ['pikachu','pokemon','charizard','bulbasaur'], concepts: ['pokemon','gaming','nintendo'], category: 'gaming', universe: 'pokemon' },

  // ── Movies / TV narrative ──
  WALTER: { terms: ['walter','jesse','heisenberg','skyler','breakingbad','bb'], concepts: ['breakingbad','chemistry','tv'], category: 'tv', universe: 'breaking-bad' },
  JESSE:  { terms: ['jesse','walter','heisenberg','pinkman'], concepts: ['breakingbad','chemistry','tv'], category: 'tv', universe: 'breaking-bad' },
  JOKER:  { terms: ['joker','batman','harley','gotham','dc'], concepts: ['joker','comic','dc'], category: 'movies', universe: 'dc' },
  BATMAN: { terms: ['batman','robin','joker','gotham'], concepts: ['batman','comic','dc'], category: 'movies', universe: 'dc' },

  // ── Elon / Space narrative ──
  ELON:   { terms: ['doge','spacex','mars','tesla','musk','x'], concepts: ['elon','space','doge'], category: 'elon', universe: 'elon-musk' },
  MUSK:   { terms: ['elon','tesla','spacex','doge','x'], concepts: ['elon','space'], category: 'elon', universe: 'elon-musk' },

  // ── Peanut / Viral animals ──
  PNUT:   { terms: ['peanut','squirrel','nut','pnut'], concepts: ['peanut','squirrel','viral'], category: 'animals', universe: 'viral-animals' },

  // ── Anime / Waifu ──
  ANIME:  { terms: ['anime','waifu','otaku','manga','kawaii'], concepts: ['anime','waifu','japan'], category: 'anime', universe: 'anime' },

  // ── Food narrative ──
  BURGER: { terms: ['burger','mcdonalds','bigmac','fries','wendys'], concepts: ['burger','food','fast-food'], category: 'food', universe: 'fast-food' },
  PIZZA:  { terms: ['pizza','pepperoni','dominos','slice'], concepts: ['pizza','food'], category: 'food', universe: 'food' },
  RAMEN:  { terms: ['ramen','noodle','soup','anime','japan'], concepts: ['ramen','food','japan'], category: 'food', universe: 'food' },

  // ── Sports narrative ──
  RONALDO:{ terms: ['ronaldo','messi','soccer','football','cr7','siuuu'], concepts: ['ronaldo','soccer','sports'], category: 'sports', universe: 'soccer' },
  MESSI:  { terms: ['messi','ronaldo','soccer','football','goat'], concepts: ['messi','soccer','sports'], category: 'sports', universe: 'soccer' },

  // ── Meme formats ──
  WOJAK:  { terms: ['wojak','pepe','chad','npc','meme'], concepts: ['wojak','meme','feels'], category: 'memes', universe: 'wojak' },
  CHAD:   { terms: ['chad','virgin','gigachad','sigma','alpha'], concepts: ['chad','meme','sigma'], category: 'memes', universe: 'chad' },
  NPC:    { terms: ['npc','wojak','bot','sheep','normie'], concepts: ['npc','meme','social'], category: 'memes', universe: 'wojak' },
}

// ─── Narrative Categories (Vector 16) ───────────────────────────
// Used for meta narrative detection — what's the dominant theme right now?
// ─── Narrative Categories ─────────────────────────────────────────
// ORDERING MATTERS: specific categories first, generic last.
// detectCategory() returns on first match — so 'dogs' must come
// before 'animals', 'frogs' before 'animals', etc.
// priority: 1 = most specific (checked first), 3 = generic fallback.

export const NARRATIVE_CATEGORIES = {
  // ── Tier 1: Highly specific — unique keywords, low overlap ──────
  aliens:    { label: '👽 Alien',    priority: 1, keywords: ['alien','ufo','disclosure','area51','extraterrestrial','greys','abduct','roswell','saucer'] },
  frogs:     { label: '🐸 Frog',     priority: 1, keywords: ['pepe','frog','toad','feels','kek','peepo','ribbit','kermit'] },
  dogs:      { label: '🐕 Dog',      priority: 1, keywords: ['wif','bonk','shib','doge','inu','pup','mutt','puppy','doggo','woofie'] },
  cats:      { label: '🐱 Cat',      priority: 1, keywords: ['cat','mew','nyan','kitty','meow','kitten','purr','whisker'] },
  elon:      { label: '⚡ Elon',      priority: 1, keywords: ['elon','musk','spacex','grok','neuralink','xaei'] },
  trump:     { label: '🇺🇸 Trump',    priority: 1, keywords: ['trump','maga','melania','barron','ivanka','donnie','magahat'] },
  pippin:    { label: '🧙 Fantasy',   priority: 1, keywords: ['pippin','frodo','gandalf','hobbit','lotr','tolkien','shire','sauron','gollum','mordor'] },
  anime:     { label: '⛩️ Anime',     priority: 1, keywords: ['anime','waifu','manga','otaku','kawaii','naruto','goku','dragonball','onepiece','bleach','chainsaw'] },
  gaming:    { label: '🎮 Gaming',    keywords: ['mario','sonic','pokemon','pikachu','luigi','zelda','minecraft','fortnite','roblox','xbox','nintendo','playstation'] },
  bears:     { label: '🐻 Bear',     priority: 1, keywords: ['bear','panda','grizzly','polar','teddy','koala','honey'] },
  nature:    { label: '🌿 Nature',    priority: 1, keywords: ['tree','grass','leaf','flower','forest','jungle','vine','herb','plant','bamboo','moss','fern','oak','pine'] },
  penguins:  { label: '🐧 Penguin',  priority: 1, keywords: ['penguin','waddle','tux','arctic','igloo','pingu'] },

  // ── Tier 2: Moderate specificity ────────────────────────────────
  ai:        { label: '🤖 AI',        priority: 2, keywords: ['ai','gpt','neural','agent','llm','robot','claude','vibe','cursor','devin','copilot','gemini','chatbot'] },
  political: { label: '🏛️ Political', priority: 2, keywords: ['biden','kamala','obama','political','vote','election','senate','congress','democrat','republican','maga','usa'] },
  space:     { label: '🚀 Space',     priority: 2, keywords: ['moon','mars','space','rocket','nasa','galaxy','star','cosmos','astronaut','orbit','saturn','jupiter'] },
  movies:    { label: '🎬 Movies/TV', priority: 2, keywords: ['walter','jesse','joker','batman','breaking','heisenberg','marvel','dc','disney','netflix','hbo','squid'] },
  celebrity: { label: '⭐ Celebrity', priority: 2, keywords: ['kanye','taylor','swift','drake','rihanna','beyonce','mrbeast','pewdiepie','hawk','tuah','diddy','jay','snoop'] },
  sports:    { label: '⚽ Sports',    priority: 2, keywords: ['ronaldo','messi','soccer','football','nba','nfl','nhl','sport','goat','champion','lebron','curry'] },
  food:      { label: '🍔 Food',      priority: 2, keywords: ['burger','pizza','ramen','taco','sushi','noodle','food','eat','cook','chef','hungry','kebab','curry'] },
  crypto:    { label: '₿ Crypto',    priority: 2, keywords: ['bitcoin','btc','eth','sol','satoshi','nakamoto','hodl','blockchain','defi','crypto','layer','protocol'] },
  memes:     { label: '😂 Meme',     priority: 2, keywords: ['wojak','chad','npc','sigma','based','gigachad','virgin','normie','doomer','zoomer','boomer','ratio'] },

  // ── Tier 3: Generic — only match if nothing else does ───────────
  animals:   { label: '🦎 Animals',   priority: 3, keywords: ['bird','fish','bull','ape','monkey','snake','wolf','fox','lion','tiger','rhino','hippo','croc','hamster','rabbit'] },
  holiday:   { label: '🎄 Seasonal',  priority: 3, keywords: ['christmas','halloween','easter','thanksgiving','xmas','santa','pumpkin','turkey','firework','valentine'] },
}

// ─── Exports ─────────────────────────────────────────────────────

export const getSearchTerms = (symbol) => {
  const upper = symbol.toUpperCase()
  const entry = LORE_MAP[upper]
  if (entry) return entry.terms
  return [symbol.toLowerCase()]
}

export const getConcepts = (symbol) => {
  const upper = symbol.toUpperCase()
  return LORE_MAP[upper]?.concepts || [symbol.toLowerCase()]
}

export const getCategory = (symbol) => {
  const upper = symbol.toUpperCase()
  return LORE_MAP[upper]?.category || null
}

export const getUniverse = (symbol) => {
  const upper = symbol.toUpperCase()
  return LORE_MAP[upper]?.universe || null
}

export default LORE_MAP