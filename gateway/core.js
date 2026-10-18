// The studio gateway shared by both installations: password sign-in, signed
// sessions, request limits, and validation of every command and upload.
// A backend stores state, uploads and credentials, and runs commands:
//   GitHub (gateway/worker.js):      Git branch + Actions secrets + workflow dispatch
//   Cloudflare (cloudflare/worker.js): R2 + encrypted credentials + Workflows
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY = 65536;
export const UPLOAD_CHUNK = 2 * 1024 * 1024;
export const UPLOAD_ID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const uploadFormats = {'image/jpeg':['image',['jpg','jpeg']], 'image/png':['image',['png']],
  'image/webp':['image',['webp']], 'video/mp4':['video',['mp4']], 'video/quicktime':['video',['mov']]};
export const encoder = new TextEncoder();
export const secrets = new Set(['FB_PAGE_ACCESS_TOKEN', 'FB_PAGE_ID', 'OPENAI_API_KEY',
  'TAVILY_API_KEY',
  'OPENAI_MODEL', 'OPENAI_MODEL_VIDEO', 'OPENAI_MODEL_QUESTION',
  'GOOGLE_SERVICE_ACCOUNT_JSON', 'DRIVE_FOLDER_ID', 'DRIVE_FOLDER_ID_VIDEO', 'DRIVE_FOLDER_ID_QUESTIONS']);
const actions = new Set(['generate', 'generate_upload', 'create_upload_draft', 'replace_media', 'publish', 'save_draft', 'schedule_draft', 'cancel_draft',
  'delete_draft', 'save_schedule', 'toggle_schedule', 'delete_schedule', 'refresh', 'save_prompt', 'refresh_models', 'save_model', 'run_due', 'recover_missed']);
const attempts = new Map();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const base64 = bytes => {
  const view = new Uint8Array(bytes); let text = '';
  for (let i = 0; i < view.length; i += 8192) text += String.fromCharCode(...view.subarray(i, i + 8192));
  return btoa(text);
};
export const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function signingKey(env) {
  return crypto.subtle.importKey('raw', encoder.encode(`${env.SESSION_SECRET}\0${env.STUDIO_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function validPassword(value, env) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const key = await signingKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(env.STUDIO_PASSWORD));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(value));
}
async function session(env) {
  const payload = base64(encoder.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    nonce: crypto.randomUUID() })));
  return `${payload}.${base64(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload)))}`;
}
async function authenticated(request, env) {
  try {
    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Bearer ') || header.length > 1024) return false;
    const parts = header.slice(7).split('.');
    if (parts.length !== 2) return false;
    if (!await crypto.subtle.verify('HMAC', await signingKey(env), unbase64(parts[1]), encoder.encode(parts[0]))) return false;
    const value = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    const now = Math.floor(Date.now() / 1000);
    return Number.isInteger(value.exp) && value.exp > now && value.exp <= now + SESSION_SECONDS;
  } catch { return false; }
}

function throttle(request) {
  // Best-effort protection per running Worker instance; no database is required.
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let entry = attempts.get(ip);
  if (!entry) {
    if (attempts.size >= 2048) throw new HttpError(429, 'Please wait a few minutes before trying again.');
    entry = { count: 0, until: now + 10 * 60 * 1000 };
    attempts.set(ip, entry);
  }
  if (++entry.count > 10) throw new HttpError(429, 'Too many login attempts. Please try again in 10 minutes.');
}

export async function body(request, limit = MAX_BODY) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Use JSON for this request.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A request body is required.');
  let size = 0; const chunks = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'This request is too large.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export function uploadManifest(value, id) {
  const {name, type, mime, size, parts, sha256} = value || {};
  const format = uploadFormats[mime];
  if (!format || type !== format[0] || typeof name !== 'string' || !name.trim() || name.length > 180
    || /[\x00-\x1f/\\]/.test(name) || !format[1].includes(name.split('.').at(-1).toLowerCase()))
    throw new HttpError(400, 'Choose a JPG, PNG, WebP, MP4, or MOV file.');
  if (!Number.isInteger(size) || size < 1 || size > (type === 'image' ? 10 : 50) * 1024 * 1024)
    throw new HttpError(413, 'Images must be under 10 MB and videos under 50 MB.');
  if (!Number.isInteger(parts) || parts !== Math.ceil(size / UPLOAD_CHUNK)
    || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    throw new HttpError(400, 'The upload is incomplete. Choose the file again.');
  return {id, name, type, mime, size, parts, sha256};
}

export function validateCommand(command) {
  if (!command || !actions.has(command.action) || typeof command.id !== 'string' || !/^[\w-]{1,100}$/.test(command.id))
    throw new HttpError(400, 'Invalid studio command.');
  if (command.action === 'generate_upload' && (!['image','video'].includes(command.type)
    || typeof command.upload_id !== 'string' || !new RegExp(`^${UPLOAD_ID}$`).test(command.upload_id)
    || typeof command.description !== 'string' || !command.description.trim() || command.description.trim().length > 2000))
    throw new HttpError(400, 'Choose an uploaded photo or video and add a description of 1–2,000 characters.');
  if (command.action === 'create_upload_draft' && (!['image','video'].includes(command.type)
    || typeof command.upload_id !== 'string' || !new RegExp(`^${UPLOAD_ID}$`).test(command.upload_id)
    || typeof command.text !== 'string' || !command.text.trim() || command.text.length > 12000
    || (command.description !== undefined && (typeof command.description !== 'string' || command.description.length > 2000))
    || (command.scheduled_at !== undefined && (typeof command.scheduled_at !== 'string' || command.scheduled_at.length > 40))
    || (command.publish !== undefined && typeof command.publish !== 'boolean')
    || (command.publish && command.scheduled_at)))
    throw new HttpError(400, 'Invalid post from the Telegram bot.');
  if (command.action === 'replace_media' && (!['image','video'].includes(command.type)
    || typeof command.upload_id !== 'string' || !new RegExp(`^${UPLOAD_ID}$`).test(command.upload_id)
    || typeof command.draft_id !== 'string' || command.draft_id.length > 150
    || !Number.isInteger(command.revision) || typeof command.text !== 'string' || command.text.length > 12000))
    throw new HttpError(400, 'Choose an uploaded photo or video for this draft.');
  // Commands approved in the Telegram bot report back to that chat when they finish.
  if (command.notify_chat_id !== undefined && (typeof command.notify_chat_id !== 'string' || !/^-?\d{1,20}$/.test(command.notify_chat_id)))
    throw new HttpError(400, 'Invalid studio command.');
  if (command.notify_language !== undefined && !['en', 'he'].includes(command.notify_language))
    throw new HttpError(400, 'Invalid studio command.');
  if (command.action === 'save_prompt' && (!['image', 'video', 'question', 'news', 'news_selection'].includes(command.type)
    || typeof command.prompt !== 'string' || !command.prompt.trim() || command.prompt.length > 8000
    || !Number.isInteger(command.revision) || command.revision < 0))
    throw new HttpError(400, 'Choose a post format and enter a prompt of 1–8,000 characters.');
  if (command.action === 'save_model' && (typeof command.model !== 'string'
    || !/^[a-zA-Z0-9._-]{1,150}$/.test(command.model)
    || !Number.isInteger(command.revision) || command.revision < 0))
    throw new HttpError(400, 'Invalid model setting.');
  return command;
}

/**
 * backend: {
 *   name, origins(env, request) → allowed browser origins, configured(env) → bool,
 *   login(env) → extra login fields, readState(env) → state text or object,
 *   dispatch(env, command, ctx), secretNames(env) → names, publicKey(env)?,
 *   putSecret(env, name, value), writeUpload(env, path, bytes) → {sha, size},
 *   readUpload(env, path) → {content (base64), size}
 * }
 */
export function createGateway(backend) {
  return async function handle(request, env, ctx) {
    // Telegram calls this address directly (no browser origin, no studio session);
    // telegram.js checks Telegram's secret header and the sender instead.
    if (new URL(request.url).pathname === '/telegram/webhook') {
      if (!backend.readFile || !backend.configured(env)) return new Response(null, { status: 404 });
      const { handleTelegram } = await import('./telegram.js');
      return handleTelegram(request, env, backend);
    }
    const origin = request.headers.get('Origin');
    const allowed = backend.origins(env, request);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' };
    if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const respond = (data, status = 200) => new Response(data === null ? null
      : typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
    try {
      if (origin && !allowed.includes(origin)) throw new HttpError(403, 'This origin is not allowed.');
      if (request.method === 'OPTIONS') {
        headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        headers['Access-Control-Max-Age'] = '600';
        return respond(null, 204);
      }
      const path = new URL(request.url).pathname;
      if (path === '/' && request.method === 'GET') return respond({ service: 'Alfred Studio', login: backend.loginPage(env, request) });
      if (!env.STUDIO_PASSWORD || !env.SESSION_SECRET || !backend.configured(env)) throw new HttpError(503, 'The studio connection is being configured.');
      if (path === '/api/login' && request.method === 'POST') {
        throttle(request);
        const value = await body(request);
        if (!await validPassword(value?.password, env)) throw new HttpError(401, 'Incorrect password. Please try again.');
        return respond({ token: await session(env), backend: backend.name, ...backend.login(env) });
      }
      if (!await authenticated(request, env)) throw new HttpError(401, 'Your session has ended. Enter your password to open the studio.');
      if (path === '/api/state' && request.method === 'GET') return respond(await backend.readState(env));
      if (path.startsWith('/api/telegram') && backend.readFile) {
        const bot = await import('./telegram-settings.js');
        if (path === '/api/telegram' && request.method === 'GET') return respond(await bot.telegramStatus(request, env, backend));
        if (path === '/api/telegram' && request.method === 'PUT') return respond(await bot.saveTelegram(request, env, backend, await body(request)));
        if (path === '/api/telegram/connect' && request.method === 'POST') return respond(await bot.connectTelegram(request, env, backend));
      }
      const part = path.match(new RegExp(`^/api/uploads/(${UPLOAD_ID})/parts/(\\d{1,2})$`));
      if (part && ['PUT','GET'].includes(request.method)) {
        const index = Number(part[2]);
        if (index >= 25) throw new HttpError(400, 'This upload has too many parts.');
        const file = `uploads/${part[1]}/part-${String(index).padStart(2,'0')}.bin`;
        if (request.method === 'GET') return respond(await backend.readUpload(env, file));
        const value = await body(request, Math.ceil(UPLOAD_CHUNK / 3) * 4 + 128);
        if (typeof value?.content !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.content))
          throw new HttpError(400, 'This upload part is invalid.');
        let bytes;
        try { bytes = unbase64(value.content); } catch { throw new HttpError(400, 'This upload part is invalid.'); }
        if (!bytes.length || bytes.length > UPLOAD_CHUNK || base64(bytes) !== value.content)
          throw new HttpError(400, 'This upload part is invalid.');
        return respond(await backend.writeUpload(env, file, bytes));
      }
      const upload = path.match(new RegExp(`^/api/uploads/(${UPLOAD_ID})$`));
      if (upload && request.method === 'POST') {
        const manifest = uploadManifest(await body(request), upload[1]);
        await backend.writeUpload(env, `uploads/${upload[1]}/manifest.json`, encoder.encode(JSON.stringify(manifest)));
        return respond(manifest, 201);
      }
      if (path === '/api/commands' && request.method === 'POST') {
        await backend.dispatch(env, validateCommand(await body(request)), ctx);
        return respond(null, 204);
      }
      if (path === '/api/secrets' && request.method === 'GET')
        return respond({ secrets: (await backend.secretNames(env)).filter(name => secrets.has(name)).map(name => ({ name })) });
      if (path === '/api/secrets/public-key' && request.method === 'GET' && backend.publicKey)
        return respond(await backend.publicKey(env));
      const name = path.slice('/api/secrets/'.length);
      if (path.startsWith('/api/secrets/') && request.method === 'PUT' && secrets.has(name)) {
        await backend.putSecret(env, name, await body(request));
        return respond(null, 204);
      }
      throw new HttpError(404, 'This studio endpoint does not exist.');
    } catch (error) {
      // Never forward upstream bodies, credentials, or stack traces to clients.
      if (!(error instanceof HttpError)) console.error('Studio request failed', error?.name ?? 'Error');
      return respond({ error: error instanceof HttpError ? error.message : 'The studio could not complete this request.' }, error instanceof HttpError ? error.status : 500);
    }
  };
}
