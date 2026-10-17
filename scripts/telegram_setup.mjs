// Connect the Telegram bot to the gateway, or check its connection.
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:setup -- https://your-gateway.example
// Without a gateway address it only prints the current connection. Never prints the token.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const gateway = process.argv[2];
if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN (from @BotFather).');

async function call(method, params = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  const value = await response.json().catch(() => ({}));
  if (!value.ok) throw new Error(`Telegram ${method} failed: ${value.description ?? response.status}`);
  return value.result;
}

const bot = await call('getMe');
console.log(`Bot: @${bot.username}`);
if (gateway) {
  if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret))
    throw new Error('Set TELEGRAM_WEBHOOK_SECRET to 16–256 letters, digits, _ or - (the same value as in the gateway settings).');
  const url = new URL('/telegram/webhook', gateway);
  if (url.protocol !== 'https:') throw new Error('The gateway address must start with https://');
  await call('setWebhook', { url: url.href, secret_token: secret, allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true, max_connections: 5 });
  await call('setMyCommands', { commands: [{ command: 'start', description: 'How to use this bot' },
    { command: 'reset', description: 'Start a new conversation' }] });
}
const info = await call('getWebhookInfo');
console.log(`Webhook: ${info.url || '(not set)'}`);
console.log(`Waiting updates: ${info.pending_update_count}`);
if (info.last_error_message) console.log(`Last error: ${info.last_error_message}`);
