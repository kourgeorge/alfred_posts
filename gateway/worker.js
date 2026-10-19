// This module runs on the server. Secrets are supplied by the hosting runtime.
// GitHub installation: state and uploads live on the private repository's
// studio-state branch, credentials are Actions secrets, and commands run in
// GitHub Actions (deployment/studio.yml). The shared logic is in core.js.
import { HttpError, base64, createGateway, encoder } from './core.js';

const REPOSITORY = 'kourgeorge/alfred_posts_automation';
// The studio's own address, and the GitHub Pages address it replaced (kept working).
const ORIGINS = ['https://alfstudio.kour.me', 'https://kourgeorge.github.io'];
const UPLOAD_CHUNK = 2 * 1024 * 1024;

async function github(env, path, options = {}) {
  const {allowMissing, allowConflict, ...fetchOptions} = options;
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      ...fetchOptions, redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Alfred-Studio', ...options.headers },
    });
  } catch (error) {
    console.error('GitHub connection failed', error?.name === 'AbortError' ? 'timeout' : 'network');
    throw new HttpError(502, 'The automation service is unavailable. Please try again shortly.');
  } finally { clearTimeout(timeout); }
  if (!response.ok) {
    if (allowMissing && response.status === 404) return null;
    if (allowConflict && [409, 422].includes(response.status)) return {conflict:true};
    if (response.status === 404 && path.startsWith('/contents/state.json'))
      return { version: 1, drafts: [], schedules: [], operations: [], posted: { image: [], video: [], question: [] } };
    throw new HttpError(502, response.status === 401 || response.status === 403
      ? 'The automation connection needs attention. Please contact the site owner.'
      : 'The automation request could not be completed. Please try again shortly.');
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function saveUploadFile(env, path, bytes) {
  if (!(await github(env, '')).private) throw new HttpError(403, 'Uploads require a private automation repository.');
  const prefix = encoder.encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(prefix.length + bytes.length); object.set(prefix); object.set(bytes, prefix.length);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-1', object))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const content = base64(bytes);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await github(env, `/contents/${path}`, {method:'PUT', allowConflict:true,
      body:JSON.stringify({branch:'studio-state', message:'Save private Studio upload', content})});
    if (result?.content?.sha === sha) return {sha, size:bytes.length};
    if (!result?.conflict) throw new HttpError(502, 'The upload could not be saved. Try again.');
    const existing = await github(env, `/contents/${path}?ref=studio-state`, {allowMissing:true});
    if (existing?.sha === sha) return {sha, size:bytes.length};
    if (existing) throw new HttpError(409, 'This upload already contains a different file. Choose the file again.');
  }
  throw new HttpError(503, 'The upload storage is busy. Try again shortly.');
}

async function readUploadPart(env, path) {
  let entry = await github(env, `/contents/${path}?ref=studio-state`, {allowMissing:true});
  if (!entry) throw new HttpError(404, 'This uploaded file is unavailable.');
  if (!Number.isInteger(entry.size) || entry.size < 1 || entry.size > UPLOAD_CHUNK)
    throw new HttpError(502, 'This uploaded file could not be opened.');
  if (entry.encoding !== 'base64') entry = await github(env, `/git/blobs/${entry.sha}`);
  return {content:entry.content.replace(/\s/g,''), size:entry.size};
}

// Small private files on the state branch (the Telegram conversation), saved with compare-and-swap.
async function readFile(env, path) {
  const entry = await github(env, `/contents/${path}?ref=studio-state`, {allowMissing:true});
  if (!entry) return null;
  const bytes = Uint8Array.from(atob(entry.content.replace(/\s/g,'')), c => c.charCodeAt(0));
  return {text:new TextDecoder().decode(bytes), sha:entry.sha};
}

async function writeFile(env, path, text, sha) {
  const result = await github(env, `/contents/${path}`, {method:'PUT', allowConflict:true, body:JSON.stringify({
    branch:'studio-state', message:'Update Telegram conversation', content:base64(encoder.encode(text)), ...(sha ? {sha} : {})})});
  return !result?.conflict;
}

export const githubBackend = {
  name: 'github',
  origins: () => ORIGINS,
  loginPage: () => 'https://alfstudio.kour.me/',
  configured: env => Boolean(env.GITHUB_TOKEN),
  login: () => ({ repository: REPOSITORY }),
  readState: env => github(env, '/contents/state.json?ref=studio-state', { headers: { Accept: 'application/vnd.github.raw+json' } }),
  dispatch: (env, command) => github(env, '/actions/workflows/studio.yml/dispatches', {
    method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { command: JSON.stringify(command) } }),
  }),
  async secretNames(env) {
    return (await github(env, '/actions/secrets?per_page=100')).secrets.map(item => item.name);
  },
  publicKey: env => github(env, '/actions/secrets/public-key'),
  async putSecret(env, name, value) {
    if (typeof value?.encrypted_value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encrypted_value)
      || typeof value.key_id !== 'string' || !/^[\w-]{1,100}$/.test(value.key_id)) throw new HttpError(400, 'Invalid encrypted credential.');
    await github(env, `/actions/secrets/${name}`, { method: 'PUT', body: JSON.stringify({ encrypted_value: value.encrypted_value, key_id: value.key_id }) });
  },
  writeUpload: saveUploadFile,
  readUpload: readUploadPart,
  readFile,
  writeFile,
};

const handle = createGateway(githubBackend);
export default { fetch: (request, env, ctx) => handle(request, env, ctx) };
