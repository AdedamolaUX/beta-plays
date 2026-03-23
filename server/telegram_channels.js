// ─── BetaPlays — Telegram Channel Registry ────────────────────────
// Vector 10 — Social Signal Intelligence
//
// Add or remove channels here at any time.
// 'handle' must be the exact @username of the public channel/group.
// 'weight' affects confidence scoring: 1.0 = fully trusted, 0.5 = experimental.
// All channels currently set to 1.0 — tune after observing signal quality.
//
// To add a new channel:
//   { handle: 'channelhandle', name: 'Display Name', weight: 1.0 }
// ──────────────────────────────────────────────────────────────────

const TELEGRAM_CHANNELS = [
  {
    handle: 'charliedegens',
    name:   'Charlie Degens',
    weight: 1.0,
  },
  {
    handle: 'WordsGC',
    name:   "Word's Public Memecoin Chat",
    weight: 1.0,
  },
  {
    handle: 'realsolanahome',
    name:   'Solana Home',
    weight: 1.0,
  },
  {
    handle: 'Blessedmemecalls',
    name:   'Blessed Meme Calls',
    weight: 1.0,
  },
]

module.exports = { TELEGRAM_CHANNELS }