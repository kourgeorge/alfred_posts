// The Cloudflare gateway and Workflow runner, with an in-memory R2 bucket.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../../gateway/core.js';
import { cloudflareBackend, runStudio } from '../../cloudflare/backend.js';
import { R2Store } from '../../server/store.js';

afterEach(() => mock.restoreAll());

/** Enough of the R2 API for the studio, including conditional writes. */
class FakeBucket {
  constructor() { this.objects = new Map(); this.version = 0; this.puts = 0; }
  object(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    const bytes = item.bytes;
    return { etag: item.etag, size: bytes.length, text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)), arrayBuffer: async () => bytes.slice().buffer };
  }
  async head(key) { return this.object(key); }
  async get(key) { return this.object(key); }
  async put(key, value, { onlyIf } = {}) {
    this.puts++;
    const current = this.objects.get(key);
    if (onlyIf instanceof Headers && onlyIf.get('If-None-Match') === '*' && current) return null;
    if (onlyIf?.etagMatches && current?.etag !== onlyIf.etagMatches) return null;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, etag: `v${++this.version}` });
    return { etag: `v${this.version}` };
  }
}

function setup() {
  const bucket = new FakeBucket();
  const created = [];
  const env = { STUDIO_PASSWORD: 'test-password', SESSION_SECRET: 'test-signing-secret', CREDENTIALS_KEY: 'k'.repeat(40), STUDIO: bucket,
    STUDIO_WORKFLOW: { async create(options) {
      if (created.some(c => c.id === options.id)) throw new Error('instance.already_exists');
      created.push(options);
    }, async get(id) {
      if (!created.some(c => c.id === id)) throw new Error('instance.not_found');
      return { id };
    } } };
  return { bucket, created, env, handle: createGateway(cloudflareBackend) };
}
const ORIGIN = 'https://alfred-studio.example.workers.dev';
const request = (path, { method = 'GET', value, token, origin = ORIGIN } = {}) => new Request(`${ORIGIN}${path}`, { method,
  headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': `ip-${Math.random()}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
async function login(handle, env) {
  const response = await handle(request('/api/login', { method: 'POST', value: { password: 'test-password' } }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.backend, 'cloudflare');
  return body.token;
}

test('same-origin gateway starts each command once as a Workflow', async () => {
  const { env, handle, created } = setup();
  assert.equal((await handle(request('/api/state'), env)).status, 401);
  assert.equal((await handle(request('/api/state', { origin: 'https://other.example' }), env)).status, 403);
  assert.equal((await handle(request('/api/state'), { ...env, CREDENTIALS_KEY: '' })).status, 503);
  const token = await login(handle, env);
  const state = await (await handle(request('/api/state', { token }), env)).json();
  assert.deepEqual(state.drafts, []);
  const command = { id: 'request-1234', action: 'generate', type: 'image' };
  assert.equal((await handle(request('/api/commands', { method: 'POST', token, value: command }), env)).status, 204);
  assert.equal((await handle(request('/api/commands', { method: 'POST', token, value: command }), env)).status, 204);
  assert.deepEqual(created, [{ id: 'request-1234', params: { command } }]);
  assert.equal((await handle(request('/api/commands', { method: 'POST', token, value: { id: 'x', action: 'run_shell' } }), env)).status, 400);
});

test('credentials are encrypted at rest and only their names are listed', async () => {
  const { env, handle, bucket } = setup();
  const token = await login(handle, env);
  assert.equal((await handle(request('/api/secrets/OPENAI_API_KEY', { method: 'PUT', token, value: { value: 'sk-private-value' } }), env)).status, 204);
  assert.equal((await handle(request('/api/secrets/GITHUB_TOKEN', { method: 'PUT', token, value: { value: 'x' } }), env)).status, 404);
  assert.equal((await handle(request('/api/secrets/OPENAI_API_KEY', { method: 'PUT', token, value: { encrypted_value: 'YQ==' } }), env)).status, 400);
  assert.equal((await handle(request('/api/secrets/public-key', { token }), env)).status, 404);
  const stored = new TextDecoder().decode(bucket.objects.get('secrets.json').bytes);
  assert.ok(!stored.includes('sk-private-value'));
  assert.deepEqual(await (await handle(request('/api/secrets', { token }), env)).json(), { secrets: [{ name: 'OPENAI_API_KEY' }] });
  // A different key cannot read the stored values.
  const { SecretStore } = await import('../../server/settings.js');
  await assert.rejects(new SecretStore(bucket, { CREDENTIALS_KEY: 'z'.repeat(40) }).read());
});

test('uploads are stored once and never overwritten with different bytes', async () => {
  const { env, handle } = setup();
  const token = await login(handle, env);
  const part = '/api/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/parts/0';
  assert.equal((await handle(request(part, { method: 'PUT', token, value: { content: 'aGVsbG8=' } }), env)).status, 200);
  assert.equal((await handle(request(part, { method: 'PUT', token, value: { content: 'aGVsbG8=' } }), env)).status, 200);
  assert.equal((await handle(request(part, { method: 'PUT', token, value: { content: 'd29ybGQ=' } }), env)).status, 409);
  assert.deepEqual(await (await handle(request(part, { token }), env)).json(), { content: 'aGVsbG8=', size: 5 });
});

test('state changes retry when another run saved first, and never lose either change', async () => {
  const bucket = new FakeBucket();
  const store = new R2Store(bucket);
  await store.initialize();
  let interfered = false;
  await store.change(async state => {
    if (!interfered) { interfered = true; await new R2Store(bucket).change(other => { other.schedules.push({ id: 'other' }); }); }
    state.drafts.push({ id: 'mine' });
  });
  const [state] = await store.read();
  assert.deepEqual(state.schedules, [{ id: 'other' }]);
  assert.deepEqual(state.drafts, [{ id: 'mine' }]);
});

test('a Workflow run records the command and replays finished steps without repeating them', async () => {
  const { env } = setup();
  const done = new Map();
  let calls = 0;
  // Like Workflows: a finished step returns its saved result on replay.
  const step = async (name, fn) => {
    if (done.has(name)) return done.get(name);
    calls++;
    const result = await fn();
    done.set(name, structuredClone(result));
    return result;
  };
  const command = { id: 'prompt-save-0001', action: 'save_prompt', type: 'image', prompt: 'Workflow prompt', revision: 0 };
  await runStudio(env, { command }, step, { images: {} });
  const first = calls;
  await runStudio(env, { command }, step, { images: {} });
  assert.equal(calls, first, 'replay repeats no step');
  const [state] = await new R2Store(env.STUDIO).read();
  assert.equal(state.prompts.image, 'Workflow prompt');
  assert.equal(state.operations[0].status, 'complete');
  assert.equal(state.connection_settings.values.OPENAI_MODEL, 'gpt-4.1-mini');
  // A failed command is recorded for the dashboard and does not crash the run.
  await runStudio(env, { command: { id: 'generate-no-key', action: 'generate', type: 'image' } }, (n, fn) => fn(), { images: {} });
  const [after] = await new R2Store(env.STUDIO).read();
  assert.equal(after.operations[0].status, 'failed');
  assert.match(after.operations[0].error, /Check credentials/);
});
