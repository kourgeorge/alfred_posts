import { t } from './i18n.js';
import sodium from 'libsodium-wrappers';

// Only a short-lived studio session is held in memory. GitHub credentials stay server-side.
let sessionToken = '';
let gateway = '';
let repository = '';
let generation = 0;
export const connected = () => Boolean(sessionToken);
export const repoName = () => repository;
export const disconnect = () => { sessionToken = ''; repository = ''; generation++; };

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
  try { url = new URL(endpoint); } catch { throw new Error(t("The studio connection has not been configured.")); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error(t("The studio needs a secure connection."));
  gateway = url.href.replace(/\/$/, '');
  try {
    const info = await api('/login', { method: 'POST', body: JSON.stringify({ password }) });
    if (!info?.token || !/^[\w.-]+\/[\w.-]+$/.test(info.repository)) throw new Error(t("The studio connection returned an invalid session."));
    sessionToken = info.token;
    repository = info.repository;
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
  const publicKey = await api('/secrets/public-key');
  await sodium.ready;
  const saved = [];
  for (const [name, value] of Object.entries(values)) {
    const encrypted = sodium.crypto_box_seal(sodium.from_string(value),
      sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL));
    try {
      await api(`/secrets/${name}`, { method: 'PUT', body: JSON.stringify({
        encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL), key_id: publicKey.key_id,
      }) });
      saved.push(name);
    } catch (error) {
      throw new Error(`${saved.length ? t('Saved {names}.',{names:saved.join(', ')})+' ' : ''}${t('{name} was not saved. {error}',{name,error:t(error.message)})}`);
    }
  }
  return saved;
}
