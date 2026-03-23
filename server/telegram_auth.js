// ─── BetaPlays — Telegram Auth (run once locally) ─────────────────
// Generates a Telegram session string and saves it to server/.env
//
// Run from project root:
//   node server/telegram_auth.js
//
// What it does:
//   1. Connects to Telegram using your API ID + Hash
//   2. Asks for your phone number + the OTP Telegram sends you
//   3. Generates a persistent session string
//   4. Prints it — you copy it into server/.env as TELEGRAM_SESSION
//
// Only needs to be run ONCE. The session string is permanent
// (until you terminate all sessions from Telegram settings).
//
// Required in server/.env before running:
//   TELEGRAM_API_ID=your_api_id
//   TELEGRAM_API_HASH=your_api_hash
// ──────────────────────────────────────────────────────────────────

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const { TelegramClient } = require('telegram')
const { StringSession }  = require('telegram/sessions')
const input              = require('input')

const API_ID   = parseInt(process.env.TELEGRAM_API_ID,  10)
const API_HASH = process.env.TELEGRAM_API_HASH

// ─── Validate env vars ────────────────────────────────────────────
if (!API_ID || !API_HASH) {
  console.error('\n❌  Missing credentials in server/.env')
  console.error('    Required:')
  console.error('      TELEGRAM_API_ID=your_api_id')
  console.error('      TELEGRAM_API_HASH=your_api_hash')
  console.error('\n    Get these from https://my.telegram.org → API Development Tools\n')
  process.exit(1)
}

// ─── Main ─────────────────────────────────────────────────────────
;(async () => {
  console.log('\n🔐  BetaPlays — Telegram Session Generator')
  console.log('─────────────────────────────────────────────')
  console.log('  API ID   :', API_ID)
  console.log('  API Hash :', API_HASH.slice(0, 6) + '...' + API_HASH.slice(-4))
  console.log('─────────────────────────────────────────────\n')

  const client = new TelegramClient(
    new StringSession(''),   // empty — we're generating it
    API_ID,
    API_HASH,
    {
      connectionRetries: 5,
      useWSS: false,
    }
  )

  await client.start({
    phoneNumber: async () => {
      console.log('📱  Enter your Telegram phone number (with country code, e.g. +2348012345678):')
      return await input.text('Phone: ')
    },

    password: async () => {
      // Only triggered if you have 2FA enabled on your Telegram account
      console.log('\n🔒  2FA is enabled on your account.')
      console.log('    Enter your Telegram 2FA password:')
      return await input.text('2FA Password: ')
    },

    phoneCode: async () => {
      console.log('\n📩  Telegram sent you a code.')
      console.log('    Check your Telegram app (or SMS) and enter it below:')
      return await input.text('Code: ')
    },

    onError: (err) => {
      console.error('\n❌  Auth error:', err.message)
      if (err.message.includes('PHONE_NUMBER_INVALID')) {
        console.error('    Make sure you included the country code (e.g. +234...)')
      }
      if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
        console.error('    Your account has 2FA — you\'ll be prompted for your password.')
      }
    },
  })

  // ─── Success ────────────────────────────────────────────────────
  const sessionString = client.session.save()

  console.log('\n\n✅  Authentication successful!\n')
  console.log('─────────────────────────────────────────────')
  console.log('  Copy the session string below into server/.env')
  console.log('  as:  TELEGRAM_SESSION=<string>')
  console.log('─────────────────────────────────────────────\n')
  console.log('TELEGRAM_SESSION=' + sessionString)
  console.log('\n─────────────────────────────────────────────')
  console.log('  ⚠️   Keep this string secret — it gives read')
  console.log('       access to your Telegram account.')
  console.log('  ⚠️   Never commit it to GitHub.')
  console.log('  ✅   Add server/.env to .gitignore if not already.')
  console.log('─────────────────────────────────────────────\n')

  await client.disconnect()
  process.exit(0)
})()