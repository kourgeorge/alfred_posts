// This module runs on the server. Secrets are supplied by the hosting runtime.
const REPOSITORY = 'kourgeorge/alfred_posts_automation';
const ORIGIN = 'https://kourgeorge.github.io';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY = 65536;
const encoder = new TextEncoder();
const secrets = new Set(['FB_PAGE_ACCESS_TOKEN', 'FB_PAGE_ID', 'OPENAI_API_KEY',
  'OPENAI_MODEL', 'OPENAI_MODEL_VIDEO', 'OPENAI_MODEL_QUESTION',
  'GOOGLE_SERVICE_ACCOUNT_JSON', 'DRIVE_FOLDER_ID', 'DRIVE_FOLDER_ID_VIDEO', 'DRIVE_FOLDER_ID_QUESTIONS']);
const actions = new Set(['generate', 'publish', 'save_draft', 'schedule_draft', 'cancel_draft',
  'delete_draft', 'save_schedule', 'toggle_schedule', 'delete_schedule', 'refresh', 'save_prompt', 'run_due', 'recover_missed']);
const attempts = new Map();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
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

async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Use JSON for this request.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A request body is required.');
  let size = 0; const chunks = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'This request is too large.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

async function github(env, path, options = {}) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      ...options, redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Alfred-Studio', ...options.headers },
    });
  } catch (error) {
    console.error('GitHub connection failed', error?.name === 'AbortError' ? 'timeout' : 'network');
    throw new HttpError(502, 'The automation service is unavailable. Please try again shortly.');
  } finally { clearTimeout(timeout); }
  if (!response.ok) {
    if (response.status === 404 && path.startsWith('/contents/state.json'))
      return { version: 1, drafts: [], schedules: [], operations: [], posted: { image: [], video: [], question: [] } };
    throw new HttpError(502, response.status === 401 || response.status === 403
      ? 'The automation connection needs attention. Please contact the site owner.'
      : 'The automation request could not be completed. Please try again shortly.');
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' };
    if (origin === ORIGIN) headers['Access-Control-Allow-Origin'] = ORIGIN;
    const respond = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status, headers });
    try {
      if (origin && origin !== ORIGIN) throw new HttpError(403, 'This origin is not allowed.');
      if (request.method === 'OPTIONS') {
        headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        headers['Access-Control-Max-Age'] = '600';
        return respond(null, 204);
      }
      const path = new URL(request.url).pathname;
      if (path === '/' && request.method === 'GET') return respond({ service: 'Alfred Studio', login: 'https://kourgeorge.github.io/alfred_posts/' });
      if (!env.STUDIO_PASSWORD || !env.SESSION_SECRET || !env.GITHUB_TOKEN) throw new HttpError(503, 'The studio connection is being configured.');
      if (path === '/api/login' && request.method === 'POST') {
        throttle(request);
        const value = await body(request);
        if (!await validPassword(value?.password, env)) throw new HttpError(401, 'Incorrect password. Please try again.');
        return respond({ token: await session(env), repository: REPOSITORY });
      }
      if (!await authenticated(request, env)) throw new HttpError(401, 'Your session has ended. Enter your password to open the studio.');
      if (path === '/api/state' && request.method === 'GET')
        return respond(await github(env, '/contents/state.json?ref=studio-state', { headers: { Accept: 'application/vnd.github.raw+json' } }));
      if (path === '/api/commands' && request.method === 'POST') {
        const command = await body(request);
        if (!command || !actions.has(command.action) || typeof command.id !== 'string' || !/^[\w-]{1,100}$/.test(command.id))
          throw new HttpError(400, 'Invalid studio command.');
        if (command.action === 'save_prompt' && (!['image', 'video', 'question'].includes(command.type)
          || typeof command.prompt !== 'string' || !command.prompt.trim() || command.prompt.length > 8000
          || !Number.isInteger(command.revision) || command.revision < 0))
          throw new HttpError(400, 'Choose a post format and enter a prompt of 1–8,000 characters.');
        await github(env, '/actions/workflows/studio.yml/dispatches', {
          method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { command: JSON.stringify(command) } }),
        });
        return respond(null, 204);
      }
      if (path === '/api/secrets' && request.method === 'GET') {
        const result = await github(env, '/actions/secrets?per_page=100');
        return respond({ secrets: result.secrets.filter(item => secrets.has(item.name)).map(item => ({ name: item.name })) });
      }
      if (path === '/api/secrets/public-key' && request.method === 'GET')
        return respond(await github(env, '/actions/secrets/public-key'));
      const name = path.slice('/api/secrets/'.length);
      if (path.startsWith('/api/secrets/') && request.method === 'PUT' && secrets.has(name)) {
        const value = await body(request);
        if (typeof value?.encrypted_value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encrypted_value)
          || typeof value.key_id !== 'string' || !/^[\w-]{1,100}$/.test(value.key_id)) throw new HttpError(400, 'Invalid encrypted credential.');
        await github(env, `/actions/secrets/${name}`, { method: 'PUT', body: JSON.stringify({ encrypted_value: value.encrypted_value, key_id: value.key_id }) });
        return respond(null, 204);
      }
      throw new HttpError(404, 'This studio endpoint does not exist.');
    } catch (error) {
      // Never forward upstream bodies, credentials, or stack traces to clients.
      return respond({ error: error instanceof HttpError ? error.message : 'The studio could not complete this request.' }, error instanceof HttpError ? error.status : 500);
    }
  },
};
