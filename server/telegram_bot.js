// ─── BetaPlays Telegram Bot ───────────────────────────────────────────────────
// @betaplaysbot — sends alert DMs to users who link their wallet
//
// Flow:
//   1. User taps "Link Telegram" in app → opens t.me/betaplaysbot?start=WALLET
//   2. Bot receives /start WALLET → saves telegram_chat_id to alert_settings
//   3. When alerts fire, sendAlert() looks up chat_id and sends DM
//
// Uses long-polling (no webhook needed — works fine on Render)
// Env: TELEGRAM_BOT_TOKEN

const db = require('./db')

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const BASE_URL  = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null

let offset       = 0
let pollInterval = null
let isRunning    = false

// ─── Send a message to a chat_id ─────────────────────────────────────────────
async function sendMessage (chatId, text) {
  if (!BASE_URL) return
  try {
    await fetch(`${BASE_URL}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
  } catch (err) {
    console.error('[TelegramBot] sendMessage error:', err.message)
  }
}

// ─── Process a single incoming update ────────────────────────────────────────
async function handleUpdate (update) {
  const msg = update.message
  if (!msg?.text) return

  const chatId = msg.chat.id
  const text   = msg.text.trim()

  // /start WALLET — links wallet to this chat
  if (text.startsWith('/start')) {
    const parts  = text.split(' ')
    const wallet = parts[1]?.trim()

    if (!wallet || wallet.length < 32) {
      await sendMessage(chatId,
        '👋 Welcome to <b>BetaPlays</b>!\n\nTo receive alerts, tap <b>Link Telegram</b> inside the app at betaplays.fun — it will generate a unique link for you.'
      )
      return
    }

    // Upsert alert_settings row with this chat_id
    try {
      console.log(`[TelegramBot] Linking wallet ${wallet.slice(0, 8)}… to chat ${chatId}`)
      await db.query(
        `INSERT INTO alert_settings (wallet_address, telegram_chat_id)
         VALUES ($1, $2)
         ON CONFLICT (wallet_address)
         DO UPDATE SET telegram_chat_id = $2, updated_at = now()`,
        [wallet, String(chatId)]
      )
      await sendMessage(chatId,
        `✅ <b>Linked!</b>\n\nYour wallet <code>${wallet.slice(0, 4)}…${wallet.slice(-4)}</code> is now connected.\n\nYou'll get notified here when:\n• New alpha runners appear\n• Beta plays are found for your watchlist\n• Narratives go active\n• Telegram signals hit\n\nManage alerts inside the app under <b>☰ Menu → Alerts</b>.`
      )
      console.log(`[TelegramBot] Successfully linked wallet ${wallet.slice(0, 8)}… to chat ${chatId}`)
    } catch (err) {
      console.error('[TelegramBot] DB link error:', err.message, err.stack)
      await sendMessage(chatId, '⚠️ Something went wrong linking your wallet. Please try again.')
    }
    return
  }

  // /stop — unlink
  if (text === '/stop') {
    try {
      await db.query(
        `UPDATE alert_settings SET telegram_chat_id = NULL, updated_at = now()
         WHERE telegram_chat_id = $1`,
        [String(chatId)]
      )
      await sendMessage(chatId, '🔕 Telegram alerts unlinked. You can re-link anytime from the app.')
    } catch (err) {
      console.error('[TelegramBot] Unlink error:', err.message)
    }
    return
  }

  // Unknown command
  await sendMessage(chatId,
    'BetaPlays bot. Link your wallet via the app at <a href="https://betaplays.fun">betaplays.fun</a>.'
  )
}

// ─── Long-poll loop ───────────────────────────────────────────────────────────
async function poll () {
  if (!BASE_URL) return
  try {
    const res = await fetch(
      `${BASE_URL}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(30_000) }
    )
    if (!res.ok) {
      console.error('[TelegramBot] getUpdates error:', res.status)
      return
    }
    const data = await res.json()
    if (!data.ok || !data.result?.length) return

    for (const update of data.result) {
      offset = update.update_id + 1
      handleUpdate(update).catch(err =>
        console.error('[TelegramBot] handleUpdate error:', err.message)
      )
    }
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
      console.error('[TelegramBot] poll error:', err.message)
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

// sendAlert — called from index.js when an event fires
// wallet: the wallet address to notify
// type: 'new_alpha' | 'new_beta' | 'narrative_active' | 'telegram_signal'
// title + body: human-readable strings
async function sendAlert (wallet, type, title, body) {
  if (!BASE_URL) return
  try {
    const result = await db.query(
      `SELECT telegram_chat_id FROM alert_settings
       WHERE wallet_address = $1 AND telegram_chat_id IS NOT NULL`,
      [wallet]
    )
    if (!result.rows.length) return

    const chatId = result.rows[0].telegram_chat_id
    const icon   = {
      new_alpha:        '🚀',
      new_beta:         '💎',
      narrative_active: '📡',
      telegram_signal:  '📢',
    }[type] || '🔔'

    await sendMessage(chatId,
      `${icon} <b>${title}</b>\n${body}\n\n<a href="https://betaplays.fun/app">Open BetaPlays →</a>`
    )
  } catch (err) {
    console.error('[TelegramBot] sendAlert error:', err.message)
  }
}

function init () {
  if (!BOT_TOKEN) {
    console.log('[TelegramBot] No TELEGRAM_BOT_TOKEN — bot disabled')
    return
  }
  if (isRunning) return
  isRunning = true
  console.log('[TelegramBot] Starting @betaplaysbot long-poll...')
  // Poll immediately then every 3s (long-poll timeout=25s, so gaps are fine)
  poll()
  pollInterval = setInterval(poll, 3_000)
}

function stop () {
  if (pollInterval) clearInterval(pollInterval)
  isRunning = false
}

module.exports = { init, stop, sendAlert }