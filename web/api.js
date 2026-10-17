import { t } from './i18n.js';
import sodium from 'libsodium-wrappers';

// Only a short-lived studio session is held in memory. Service credentials stay server-side.
// The gateway is either the GitHub installation (Actions) or the Cloudflare one (Workers).
let sessionToken = '';
let gateway = '';
let repository = '';
let backend = '';
let generation = 0;
export const connected = () => Boolean(sessionToken);
export const repoName = () => repository;
export const backendName = () => backend;
export const disconnect = () => { sessionToken = ''; repository = ''; backend = ''; generation++; };

export async function api(path, options = {}) {
  const current = generation;
  const result = await fetch(`${gateway}/api${path}`, {
    ...options, cache: 'no-store', credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
  });
  const text = await result.text();
  if (current !== generation) throw new Error(t("The studio was locked. Sign in again to continue."));
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new Error(t("The studio connection is unavailable. Please try again shortly.")); }
  if (!result.ok) {
    if (result.status === 401 && sessionToken) {
      disconnect();
      window.dispatchEvent(new Event('studio-locked'));
    }
    throw new Error(body?.error || t("The studio could not complete this request. Please try again."));
  }
  return body;
}

export async function connect(endpoint, password) {
  disconnect();
  let url;
  // "same-origin": the website and the gateway are the same Cloudflare Worker.
  try { url = new URL(endpoint === 'same-origin' ? location.origin : endpoint); }
  catch { throw new Error(t("The studio connection has not been configured.")); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) && endpoint === 'same-origin';
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash)
    throw new Error(t("The studio needs a secure connection."));
  gateway = url.href.replace(/\/$/, '');
  try {
    const info = await api('/login', { method: 'POST', body: JSON.stringify({ password }) });
    const kind = info?.backend ?? 'github';
    if (!info?.token || !['github', 'cloudflare'].includes(kind)
      || (kind === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(info.repository)))
      throw new Error(t("The studio connection returned an invalid session."));
    sessionToken = info.token;
    repository = kind === 'github' ? info.repository : '';
    backend = kind;
    return info;
  } catch (error) { disconnect(); throw error; }
}

export async function readState() { return api('/state'); }

export async function dispatch(command) {
  return api('/commands', { method: 'POST', body: JSON.stringify(command) });
}

export async function secretsStatus() {
  const result = await api('/secrets');
  return new Set(result.secrets.map(secret => secret.name));
}

export async function saveSecrets(values) {
  // Cloudflare encrypts each value on the server before storing it; GitHub needs a sealed box.
  if (backend === 'cloudflare') return putEach(values, value => ({ value }));
  const publicKey = await api('/secrets/public-key');
  await sodium.ready;
  return putEach(values, value => ({
    encrypted_value: sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value),
      sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL)), sodium.base64_variants.ORIGINAL),
    key_id: publicKey.key_id,
  }));
}

async function putEach(values, payload) {
  const saved = [];
  for (const [name, value] of Object.entries(values)) {
    try {
      await api(`/secrets/${name}`, { method: 'PUT', body: JSON.stringify(payload(value)) });
      saved.push(name);
    } catch (error) {
      throw new Error(`${saved.length ? t('Saved {names}.',{names:saved.join(', ')})+' ' : ''}${t('{name} was not saved. {error}',{name,error:t(error.message)})}`);
    }
  }
  return saved;
}
