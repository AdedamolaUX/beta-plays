// ─── LORE MAP ───────────────────────────────────────────────────
// Maps alpha token symbols to related search terms the detection
// engine should query. Think of this as the "degen brain" —
// the cultural knowledge of how narratives relate.
//
// Format: { SYMBOL: { terms: [...], concepts: [...] } }
// terms   = exact search strings to query on DEXScreener
// concepts = narrative tags used for PumpFun signal matching

const LORE_MAP = {
  // ── Dog / Hat narrative ──────────────────────────────────────
  WIF: {
    terms: ['catwif', 'babywif', 'wifhat', 'hat', 'dogwif', 'wif'],
    concepts: ['dog', 'hat', 'wif', 'dogwifhat'],
  },
  BONK: {
    terms: ['babybonk', 'bonkwif', 'megabonk', 'bonk'],
    concepts: ['bonk', 'dog', 'solana'],
  },
  MYRO: {
    terms: ['babymyro', 'myrowif', 'myro'],
    concepts: ['myro', 'dog', 'solana'],
  },

  // ── Cat narrative ────────────────────────────────────────────
  POPCAT: {
    terms: ['popdog', 'popelon', 'pop', 'cat'],
    concepts: ['cat', 'pop', 'meme'],
  },
  MEW: {
    terms: ['babymew', 'mewwif', 'mew', 'cat'],
    concepts: ['cat', 'mew', 'solana'],
  },
  NYAN: {
    terms: ['nyancat', 'nyan', 'cat', 'rainbow'],
    concepts: ['cat', 'nyan', 'rainbow'],
  },

  // ── Political narrative ──────────────────────────────────────
  TRUMP: {
    terms: ['maga', 'america', 'usa', 'biden', 'melania', 'baron', 'ivanka'],
    concepts: ['trump', 'maga', 'political', 'usa'],
  },
  BODEN: {
    terms: ['biden', 'joe', 'hunter', 'kamala', 'boden'],
    concepts: ['political', 'biden', 'usa'],
  },
  MAGA: {
    terms: ['trump', 'america', 'usa', 'republican', 'maga'],
    concepts: ['maga', 'trump', 'political'],
  },

  // ── AI / Tech narrative ──────────────────────────────────────
  AI16Z: {
    terms: ['ai', 'agent', 'eliza', 'degenai', 'vc'],
    concepts: ['ai', 'agent', 'tech'],
  },
  GOAT: {
    terms: ['goat', 'ai', 'terminal', 'truth'],
    concepts: ['ai', 'goat', 'terminal'],
  },

  // ── Frog narrative ──────────────────────────────────────────
  PEPE: {
    terms: ['pepe', 'frog', 'rare', 'feels'],
    concepts: ['pepe', 'frog', 'meme'],
  },

  // ── Elon / Space narrative ───────────────────────────────────
  ELON: {
    terms: ['doge', 'spacex', 'mars', 'tesla', 'musk', 'x'],
    concepts: ['elon', 'space', 'doge'],
  },
  DOGE: {
    terms: ['babydoge', 'dogecoin', 'doge', 'shib', 'elon'],
    concepts: ['doge', 'dog', 'elon'],
  },

  // ── Peanut / Squirrel narrative ──────────────────────────────
  PNUT: {
    terms: ['peanut', 'squirrel', 'nut', 'pnut'],
    concepts: ['peanut', 'squirrel', 'viral'],
  },

  // ── Anime narrative ─────────────────────────────────────────
  ANIME: {
    terms: ['anime', 'waifu', 'nft', 'otaku'],
    concepts: ['anime', 'waifu', 'japan'],
  },

  // ── Solana ecosystem ────────────────────────────────────────
  SOL: {
    terms: ['solana', 'sol', 'phantom', 'saga'],
    concepts: ['solana', 'layer1', 'ecosystem'],
  },
}

// Generic fallback: if no lore entry exists, we derive search terms
// from the symbol itself (prefix/suffix pattern matching)
export const getSearchTerms = (symbol) => {
  const upper = symbol.toUpperCase()
  const entry = LORE_MAP[upper]

  if (entry) return entry.terms

  // Fallback: search for the symbol directly
  return [symbol.toLowerCase()]
}

export const getConcepts = (symbol) => {
  const upper = symbol.toUpperCase()
  const entry = LORE_MAP[upper]
  return entry?.concepts || [symbol.toLowerCase()]
}

export default LORE_MAP