// Telegram bot settings managed from the dashboard (Settings → Telegram bot).
// Stored in telegram/settings.json on the private state branch. The bot token and
// OpenAI key are encrypted (AES-GCM) with the gateway secret SETTINGS_KEY and are
// never returned to a browser. Saved values take priority over gateway variables
// of the same name, so an installation without saved settings keeps working.
import { HttpError, encoder } from './core.js';

const FILE = 'telegram/settings.json';
const SECRET_FIELDS = ['TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY'];
const decoder = new TextDecoder();
const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function key(env) {
  if (!env.SETTINGS_KEY || env.SETTINGS_KEY.length < 32)
    throw new HttpError(503, 'Saving keys from the dashboard needs the gateway secret SETTINGS_KEY.');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(env.SETTINGS_KEY));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), encoder.encode(value));
  return { iv: toBase64(iv), data: toBase64(data) };
}

async function open(env, sealed) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, await key(env), fromBase64(sealed.data));
  return decoder.decode(plain);
}

async function read(env, backend) {
  const file = await backend.readFile(env, FILE);
  return { saved: file ? JSON.parse(file.text) : {}, sha: file?.sha };
}

const userList = value => String(value ?? '').split(',').map(id => id.trim()).filter(Boolean);

/** The bot's effective settings: saved values first, then gateway variables. */
export async function botSettings(env, backend) {
  const { saved } = await read(env, backend);
  const secrets = {};
  for (const name of SECRET_FIELDS) {
    if (!saved.secrets?.[name]) continue;
    try { secrets[name] = await open(env, saved.secrets[name]); }
    catch { console.error('Telegram setting could not be decrypted', name); }
  }
  return {
    enabled: saved.enabled !== false,
    users: saved.users ? saved.users.map(String) : userList(env.TELEGRAM_ALLOWED_USER_IDS),
    model: saved.model ?? env.TELEGRAM_OPENAI_MODEL ?? '',
    token: secrets.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '',
    openaiKey: secrets.OPENAI_API_KEY || env.OPENAI_API_KEY || '',
    revision: saved.revision ?? 0,
  };
}

async function telegram(token, method, params = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(20000) });
  } catch { throw new HttpError(502, 'Telegram could not be reached. Try again shortly.'); }
  const value = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 404) throw new HttpError(400, 'Telegram did not accept this bot token. Check it in @BotFather.');
  if (!response.ok || !value?.ok) throw new HttpError(502, 'Telegram could not complete this request. Try again shortly.');
  return value.result;
}

const webhookUrl = request => new URL('/telegram/webhook', request.url).href;

/** GET /api/telegram: what the dashboard shows. Never includes keys or tokens. */
export async function telegramStatus(request, env, backend) {
  const settings = await botSettings(env, backend);
  const status = { enabled: settings.enabled, users: settings.users, model: settings.model, revision: settings.revision,
    token_set: Boolean(settings.token), openai_key_set: Boolean(settings.openaiKey),
    webhook_secret_set: Boolean(env.TELEGRAM_WEBHOOK_SECRET), settings_key_set: Boolean(env.SETTINGS_KEY && env.SETTINGS_KEY.length >= 32),
    bot: null, connected: false, pending_updates: 0, last_error: null, last_error_at: null };
  if (!settings.token) return status;
  try {
    const [me, info] = await Promise.all([telegram(settings.token, 'getMe'), telegram(settings.token, 'getWebhookInfo')]);
    Object.assign(status, { bot: { username: me.username, name: me.first_name }, connected: info.url === webhookUrl(request),
      webhook_elsewhere: Boolean(info.url) && info.url !== webhookUrl(request), pending_updates: info.pending_update_count ?? 0,
      last_error: info.last_error_message ?? null,
      last_error_at: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null });
  } catch (error) { status.telegram_error = error.message; }
  return status;
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid Telegram settings.');
  const allowed = new Set(['enabled', 'users', 'model', 'revision', 'TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY']);
  if (Object.keys(value).some(name => !allowed.has(name))) throw new HttpError(400, 'Invalid Telegram settings.');
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new HttpError(400, 'Invalid Telegram settings.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new HttpError(400, 'Invalid Telegram settings.');
  if (value.users !== undefined && (!Array.isArray(value.users) || value.users.length > 20
    || value.users.some(id => typeof id !== 'string' || !/^\d{1,20}$/.test(id))))
    throw new HttpError(400, 'Telegram user IDs contain only numbers. Add up to 20.');
  if (value.model !== undefined && (typeof value.model !== 'string' || !/^[a-zA-Z0-9._-]{0,150}$/.test(value.model)))
    throw new HttpError(400, 'Choose a model from the list.');
  if (value.TELEGRAM_BOT_TOKEN !== undefined && (typeof value.TELEGRAM_BOT_TOKEN !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{30,60}$/.test(value.TELEGRAM_BOT_TOKEN)))
    throw new HttpError(400, 'This does not look like a bot token from @BotFather.');
  if (value.OPENAI_API_KEY !== undefined && (typeof value.OPENAI_API_KEY !== 'string' || !/^\S{20,512}$/.test(value.OPENAI_API_KEY)))
    throw new HttpError(400, 'Enter a valid OpenAI API key.');
  return value;
}

/** PUT /api/telegram: save settings. A new bot token is checked with Telegram and connected. */
export async function saveTelegram(request, env, backend, value) {
  value = validate(value);
  if (value.TELEGRAM_BOT_TOKEN) await telegram(value.TELEGRAM_BOT_TOKEN, 'getMe');
  const sealed = {};
  for (const name of SECRET_FIELDS) if (value[name]) sealed[name] = await seal(env, value[name]);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { saved, sha } = await read(env, backend);
    if ((saved.revision ?? 0) !== value.revision)
      throw new HttpError(409, 'These settings changed in another session. Reload them and try again.');
    const next = { ...saved, revision: value.revision + 1, updated_at: new Date().toISOString(),
      secrets: { ...saved.secrets, ...sealed } };
    for (const name of ['enabled', 'users', 'model']) if (value[name] !== undefined) next[name] = value[name];
    if (await backend.writeFile(env, FILE, JSON.stringify(next), sha)) {
      if (value.TELEGRAM_BOT_TOKEN) await connectTelegram(request, env, backend);
      return telegramStatus(request, env, backend);
    }
  }
  throw new HttpError(503, 'The settings are busy. Try again shortly.');
}

/** POST /api/telegram/connect: point the bot at this gateway. */
export async function connectTelegram(request, env, backend) {
  const settings = await botSettings(env, backend);
  if (!settings.token) throw new HttpError(400, 'Add a bot token first.');
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new HttpError(503, 'The gateway secret TELEGRAM_WEBHOOK_SECRET is not set.');
  await telegram(settings.token, 'setWebhook', { url: webhookUrl(request), secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'], max_connections: 5 });
  await telegram(settings.token, 'setMyCommands', { commands: [{ command: 'start', description: 'How to use this bot' },
    { command: 'reset', description: 'Start a new conversation' }] }).catch(() => {});
  return telegramStatus(request, env, backend);
}
