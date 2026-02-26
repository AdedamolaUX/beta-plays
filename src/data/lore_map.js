// ─── LORE MAP + TICKER MORPHOLOGY ENGINE ────────────────────────

// ─── Morphology Pattern Generator ───────────────────────────────
// Given an alpha ticker, generates 20-30 candidate beta tickers
// based on patterns observed in degen memecoin culture.

export const generateTickerVariants = (symbol) => {
  const s = symbol.toUpperCase()
  const l = symbol.toLowerCase()

  const variants = new Set()

  // ── Prefix patterns ──
  const prefixes = ['BABY', 'MINI', 'MIKO', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
    'BASED', 'REAL', 'OG', 'THE', 'RETRO', 'TURBO', 'CHAD', 'DEGEN']
  prefixes.forEach(p => variants.add(`${p}${s}`))

  // ── Suffix patterns ──
  const suffixes = ['INU', 'WIF', 'HAT', 'CAT', 'DOG', 'AI', 'GPT',
    'DAO', 'FI', 'X', '2', '3', 'PLUS', 'PRO', 'MOON', 'PUMP']
  suffixes.forEach(sfx => variants.add(`${s}${sfx}`))

  // ── Compound patterns ──
  variants.add(`${s}WIF`)
  variants.add(`WIF${s}`)
  variants.add(`${s}CAT`)
  variants.add(`CAT${s}`)
  variants.add(`${s}DOG`)
  variants.add(`DOG${s}`)

  // ── Opposite / mirror patterns ──
  const opposites = {
    BULL: ['BEAR'],
    BEAR: ['BULL'],
    MOON: ['DOOM', 'RUG'],
    LONG: ['SHORT'],
    UP: ['DOWN'],
    PUMP: ['DUMP'],
    RICH: ['POOR'],
    CHAD: ['VIRGIN', 'BETA'],
    DAY: ['NIGHT'],
    SUN: ['MOON'],
    HOT: ['COLD'],
    FAST: ['SLOW'],
    BIG: ['SMALL', 'TINY'],
    GOOD: ['EVIL', 'BAD'],
    LIGHT: ['DARK'],
    TRUMP: ['BIDEN', 'KAMALA', 'BODEN'],
    BIDEN: ['TRUMP'],
    PEPE: ['WOJAK'],
    WOJAK: ['PEPE'],
  }
  if (opposites[s]) opposites[s].forEach(o => variants.add(o))

  // ── Companion / universe patterns ──
  const companions = {
    TRUMP: ['MELANIA', 'BARRON', 'IVANKA', 'MAGA', 'BARON'],
    MELANIA: ['TRUMP', 'BARRON'],
    BONNIE: ['CLYDE'],
    CLYDE: ['BONNIE'],
    TOM: ['JERRY'],
    JERRY: ['TOM'],
    BATMAN: ['ROBIN', 'JOKER', 'GOTHAM'],
    JOKER: ['BATMAN', 'HARLEY'],
    WIF: ['HAT', 'CATWIF', 'WIFCAT', 'BABYWIF'],
    HAT: ['WIF', 'DOGHAT'],
    BONK: ['BABYBONK', 'BONKWIF', 'MEGABONK'],
    PEPE: ['RARE', 'FEELSGOOD', 'PEPEWIF', 'PEEPO'],
    DOGE: ['SHIB', 'FLOKI', 'BABYDOGE', 'DOGECOIN'],
    SHIB: ['DOGE', 'LEASH', 'BONE'],
    SOL: ['BONK', 'WIF', 'POPCAT'],
    AI: ['AGI', 'GPT', 'NEURAL', 'ROBOT', 'AGENT'],
    ELON: ['MUSK', 'TESLA', 'SPACEX', 'MARS', 'X'],
    MUSK: ['ELON', 'TESLA', 'DOGE'],
    POPCAT: ['POPDOG', 'POPELON', 'POPWIF'],
    MYRO: ['BABYMYRO', 'MYROCAT', 'MYROWIF'],
  }
  if (companions[s]) companions[s].forEach(c => variants.add(c))

  // ── Size variants ──
  variants.add(`BABY${s}`)
  variants.add(`GIGA${s}`)
  variants.add(`MINI${s}`)
  variants.add(`MEGA${s}`)
  variants.add(`FAT${s}`)
  variants.add(`TINY${s}`)

  // ── Remove the alpha itself ──
  variants.delete(s)

  return Array.from(variants)
}

// ─── LORE MAP ────────────────────────────────────────────────────
// Manually curated narrative relationships.
// terms   = exact search strings for DEXScreener
// concepts = narrative tags for PumpFun + category matching

const LORE_MAP = {
  // ── Dog / Hat narrative ──
  WIF: {
    terms: ['catwif', 'babywif', 'wifhat', 'hat', 'dogwif', 'wif'],
    concepts: ['dog', 'hat', 'wif', 'dogwifhat'],
    category: 'dogs',
    universe: 'dogwifhat',
  },
  BONK: {
    terms: ['babybonk', 'bonkwif', 'megabonk', 'bonk'],
    concepts: ['bonk', 'dog', 'solana'],
    category: 'dogs',
    universe: 'solana-dogs',
  },
  MYRO: {
    terms: ['babymyro', 'myrowif', 'myro'],
    concepts: ['myro', 'dog', 'solana'],
    category: 'dogs',
    universe: 'solana-dogs',
  },

  // ── Cat narrative ──
  POPCAT: {
    terms: ['popdog', 'popelon', 'pop', 'cat'],
    concepts: ['cat', 'pop', 'meme'],
    category: 'cats',
    universe: 'pop-memes',
  },
  MEW: {
    terms: ['babymew', 'mewwif', 'mew', 'cat'],
    concepts: ['cat', 'mew', 'solana'],
    category: 'cats',
    universe: 'solana-cats',
  },

  // ── Political narrative ──
  TRUMP: {
    terms: ['maga', 'america', 'usa', 'biden', 'melania', 'barron', 'ivanka'],
    concepts: ['trump', 'maga', 'political', 'usa'],
    category: 'political',
    universe: 'trump-family',
  },
  BODEN: {
    terms: ['biden', 'joe', 'hunter', 'kamala', 'boden'],
    concepts: ['political', 'biden', 'usa'],
    category: 'political',
    universe: 'us-politics',
  },
  MELANIA: {
    terms: ['trump', 'barron', 'melania'],
    concepts: ['trump', 'political', 'usa'],
    category: 'political',
    universe: 'trump-family',
  },

  // ── AI / Tech narrative ──
  AI16Z: {
    terms: ['ai', 'agent', 'eliza', 'degenai', 'vc', 'a16z'],
    concepts: ['ai', 'agent', 'tech'],
    category: 'ai',
    universe: 'ai-agents',
  },
  GOAT: {
    terms: ['goat', 'ai', 'terminal', 'truth'],
    concepts: ['ai', 'goat', 'terminal'],
    category: 'ai',
    universe: 'ai-terminal',
  },
  CLAUDE: {
    terms: ['claude', 'anthropic', 'ai', 'llm', 'sonnet'],
    concepts: ['ai', 'claude', 'anthropic'],
    category: 'ai',
    universe: 'ai-models',
  },
  GPT: {
    terms: ['gpt', 'openai', 'chatgpt', 'ai', 'llm'],
    concepts: ['ai', 'gpt', 'openai'],
    category: 'ai',
    universe: 'ai-models',
  },

  // ── Frog narrative ──
  PEPE: {
    terms: ['pepe', 'frog', 'rare', 'feels', 'pepewif', 'peepo'],
    concepts: ['pepe', 'frog', 'meme'],
    category: 'frogs',
    universe: 'pepe',
  },

  // ── Elon / Space narrative ──
  ELON: {
    terms: ['doge', 'spacex', 'mars', 'tesla', 'musk', 'x'],
    concepts: ['elon', 'space', 'doge'],
    category: 'elon',
    universe: 'elon-musk',
  },
  DOGE: {
    terms: ['babydoge', 'dogecoin', 'doge', 'shib', 'elon', 'floki'],
    concepts: ['doge', 'dog', 'elon'],
    category: 'dogs',
    universe: 'doge-ecosystem',
  },

  // ── Peanut / Squirrel narrative ──
  PNUT: {
    terms: ['peanut', 'squirrel', 'nut', 'pnut'],
    concepts: ['peanut', 'squirrel', 'viral'],
    category: 'animals',
    universe: 'viral-animals',
  },

  // ── Anime / Waifu narrative ──
  ANIME: {
    terms: ['anime', 'waifu', 'otaku', 'manga', 'kawaii'],
    concepts: ['anime', 'waifu', 'japan'],
    category: 'anime',
    universe: 'anime',
  },

  // ── Vibecoding / Dev narrative ──
  VIBE: {
    terms: ['vibecode', 'vibecoding', 'cursor', 'devin', 'coder'],
    concepts: ['vibe', 'coding', 'ai', 'dev'],
    category: 'ai',
    universe: 'vibecoding',
  },
}

// ─── Narrative Categories ────────────────────────────────────────
// Used for Vector 16 — meta narrative detection
export const NARRATIVE_CATEGORIES = {
  dogs:      { label: '🐕 Dogs',          keywords: ['bonk', 'shib', 'doge', 'dogwif', 'doggo', 'puppy', 'hound', 'mutt', 'wifhat', 'inu'] },
  cats:      { label: '🐱 Cats',          keywords: ['popcat', 'nyan', 'kitty', 'meow', 'feline', 'kitten', 'catcoin', 'mew'] },
  frogs:     { label: '🐸 Frogs',         keywords: ['pepe', 'frog', 'toad', 'kek', 'wojak', 'feels', 'peepo'] },
  political: { label: '🇺🇸 Political',    keywords: ['trump', 'biden', 'maga', 'vote', 'election', 'boden', 'kamala', 'republican', 'democrat', 'potus'] },
  ai:        { label: '🤖 AI',            keywords: ['neural', 'agent', 'claude', 'vibecod', 'artificial', 'openai', 'devin', 'cursor', 'llm', 'gpt4', 'chatgpt'] },
  animals:   { label: '🦎 Animals',       keywords: ['bird', 'fish', 'bear', 'bull', 'snake', 'tiger', 'lion', 'wolf', 'hamster', 'penguin', 'gorilla', 'chimp', 'panda'] },
  anime:     { label: '⛩️ Anime',         keywords: ['anime', 'waifu', 'manga', 'otaku', 'kawaii', 'ninja', 'samurai', 'senpai', 'tokyo'] },
  space:     { label: '🚀 Space',         keywords: ['moon', 'mars', 'space', 'rocket', 'nasa', 'galaxy', 'comet', 'orbit', 'astro', 'cosmos'] },
  elon:      { label: '⚡ Elon',          keywords: ['elon', 'musk', 'tesla', 'spacex', 'grok', 'elonmusk'] },
  defi:      { label: '💰 DeFi',          keywords: ['swap', 'yield', 'farm', 'stake', 'vault', 'liquidity', 'protocol', 'finance', 'dao'] },
  gaming:    { label: '🎮 Gaming',        keywords: ['game', 'quest', 'guild', 'arcade', 'pixel', 'level', 'boss', 'loot', 'gamer', 'rpg'] },
  food:      { label: '🍕 Food',          keywords: ['pizza', 'burger', 'taco', 'food', 'cook', 'chef', 'bread', 'cheese', 'donut', 'cake'] },
  degen:     { label: '💀 Degen',         keywords: ['degen', 'chad', 'ngmi', 'wagmi', 'fud', 'hodl', 'rekt', 'fomo', 'trenches'] },
  horror:    { label: '👻 Dark/Horror',   keywords: ['skull', 'death', 'dead', 'ghost', 'demon', 'devil', 'dark', 'shadow', 'evil', 'zombie'] },
  sports:    { label: '🏆 Sports',        keywords: ['sport', 'nba', 'nfl', 'soccer', 'football', 'basketball', 'champion', 'league', 'athlete'] },
  scifi:     { label: '🧪 Sci-Fi/Cyber',  keywords: ['cyber', 'matrix', 'blade', 'future', 'hack', 'neon', 'punk', 'dystopia', 'virtual'] },
  alien:     { label: '👽 Alien/UFO',     keywords: ['alien', 'ufo', 'area51', 'extraterrestrial', 'roswell'] },
  popcult:   { label: '🎭 Pop Culture',   keywords: ['movie', 'film', 'series', 'character', 'netflix', 'disney', 'marvel', 'viral', 'meme'] },
  nature:    { label: '🌿 Nature',        keywords: ['earth', 'water', 'fire', 'wind', 'tree', 'flower', 'ocean', 'forest', 'nature', 'green'] },
  music:     { label: '🎵 Music',         keywords: ['music', 'beat', 'bass', 'song', 'sound', 'tune', 'bop', 'hiphop', 'rap'] },
  monkey:    { label: '🐒 Monkeys',       keywords: ['monkey', 'chimp', 'gorilla', 'orangutan', 'baboon', 'primate', 'kong', 'xingxing', 'punch'] },
}
// ─── Exports ────────────────────────────────────────────────────

export const getSearchTerms = (symbol) => {
  const upper = symbol.toUpperCase()
  const entry = LORE_MAP[upper]
  if (entry) return entry.terms
  return [symbol.toLowerCase()]
}

export const getConcepts = (symbol) => {
  const upper = symbol.toUpperCase()
  const entry = LORE_MAP[upper]
  return entry?.concepts || [symbol.toLowerCase()]
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