import sodium from 'libsodium-wrappers';

// Credentials exist only in memory. They are never persisted in browser storage.
let accessKey = '';
let repository = '';
let ref = 'main';
export const connected = () => Boolean(accessKey);
export const repoName = () => repository;
export const disconnect = () => { accessKey = ''; repository = ''; };

export async function api(path, options = {}) {
  const result = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: `Bearer ${accessKey}`,
      'X-GitHub-Api-Version': '2022-11-28', ...options.headers },
  });
  if (!result.ok) {
    if (result.status === 401) throw new Error('Your access key is invalid or expired. Sign in with a new key.');
    if (result.status === 403) throw new Error('GitHub denied access. Check the access key’s repository permissions or rate limit.');
    if (result.status === 404) throw Object.assign(new Error('Repository or workflow not found. Check the repository name and access key permissions.'), { status: 404 });
    throw new Error(`GitHub returned ${result.status}. Please try again shortly.`);
  }
  const body = await result.text();
  return body ? JSON.parse(body) : null;
}

export async function connect(repo, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Enter the repository as owner/repository.');
  repository = repo;
  accessKey = token;
  try {
    const info = await api('');
    if (!info.private) throw new Error('Choose a private automation repository to keep drafts and settings private.');
    ref = info.default_branch;
    await api('/actions/workflows/studio.yml');
    return info;
  } catch (error) { disconnect(); throw error; }
}

export async function readState() {
  try {
    return await api(`/contents/state.json?ref=studio-state&t=${Date.now()}`, {
      headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store',
    });
  } catch (error) {
    if (error.status === 404) return { version: 1, drafts: [], schedules: [], operations: [], posted: {image: [], video: [], question: []} };
    throw error;
  }
}

export async function dispatch(command) {
  return api('/actions/workflows/studio.yml/dispatches', {
    method: 'POST', body: JSON.stringify({ ref, inputs: { command: JSON.stringify(command) } }),
  });
}

export async function secretsStatus() {
  const result = await api('/actions/secrets?per_page=100');
  return new Set(result.secrets.map(secret => secret.name));
}

export async function saveSecrets(values) {
  const publicKey = await api('/actions/secrets/public-key');
  await sodium.ready;
  const saved = [];
  for (const [name, value] of Object.entries(values)) {
    const encrypted = sodium.crypto_box_seal(sodium.from_string(value),
      sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL));
    try {
      await api(`/actions/secrets/${name}`, { method: 'PUT', body: JSON.stringify({
        encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL), key_id: publicKey.key_id,
      }) });
      saved.push(name);
    } catch (error) {
      throw new Error(`${saved.length ? `Saved ${saved.join(', ')}. ` : ''}${name} was not saved. ${error.message}`);
    }
  }
  return saved;
}
