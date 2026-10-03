import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../gateway/worker.js';

const env = { STUDIO_PASSWORD: 'test-password', SESSION_SECRET: 'test-signing-secret', GITHUB_TOKEN: 'server-only-github-key' };
let client = 0;
function request(path, { method = 'GET', value, token, origin = 'https://kourgeorge.github.io', ip = `client-${++client}` } = {}) {
  return new Request(`https://gateway.example${path}`, { method, headers: {
    'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
async function login() {
  const response = await worker.fetch(request('/api/login', { method: 'POST', value: { password: env.STUDIO_PASSWORD } }), env);
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

test('every private route requires authentication; wrong passwords and missing configuration fail closed', async () => {
  const upstream = mock.method(globalThis, 'fetch', () => { throw new Error('Must not contact GitHub'); });
  try {
    for (const path of ['/api/state', '/api/commands', '/api/secrets', '/api/secrets/public-key', '/api/secrets/OPENAI_API_KEY'])
      assert.equal((await worker.fetch(request(path), env)).status, 401);
    assert.equal((await worker.fetch(request('/api/login', { method: 'POST', value: { password: 'wrong' } }), env)).status, 401);
    assert.equal((await worker.fetch(request('/api/state'), {})).status, 503);
    assert.equal(upstream.mock.callCount(), 0);
  } finally { upstream.mock.restore(); }
});

test('signed sessions reject tampering, expiry, and password rotation', async () => {
  const token = await login();
  const altered = token.slice(0, -8) + 'AAAAAAAA';
  for (const invalid of ['invented', altered]) assert.equal((await worker.fetch(request('/api/state', { token: invalid }), env)).status, 401);
  assert.equal((await worker.fetch(request('/api/state', { token }), { ...env, STUDIO_PASSWORD: 'changed' })).status, 401);
  const now = Date.now(); const clock = mock.method(Date, 'now', () => now + 9 * 60 * 60 * 1000);
  try { assert.equal((await worker.fetch(request('/api/state', { token }), env)).status, 401); }
  finally { clock.mock.restore(); }
});

test('only fixed repository endpoints and approved service secrets are available', async () => {
  const token = await login(); const calls = [];
  const upstream = mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url,options});
    if (url.endsWith('/actions/secrets?per_page=100')) return Response.json({ secrets: [{name:'OPENAI_API_KEY'},{name:'UNRELATED_SECRET'}] });
    if (options.method === 'POST' || options.method === 'PUT') return new Response(null, { status: 204 });
    return Response.json({ drafts: [], schedules: [], operations: [] });
  });
  try {
    const response = await worker.fetch(request('/api/state', { token }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://kourgeorge.github.io');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls[0].url, 'https://api.github.com/repos/kourgeorge/alfred_posts_automation/contents/state.json?ref=studio-state');
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    const command = {id:'request-123',action:'generate',type:'image'};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:command}), env)).status, 204);
    assert.deepEqual(JSON.parse(calls[1].options.body), {ref:'main',inputs:{command:JSON.stringify(command)}});
    const prompt = {id:'prompt-save-123',action:'save_prompt',type:'question',prompt:'Write a short intro. שלום',revision:0};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:prompt}), env)).status, 204);
    assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).options.body).inputs.command), prompt);
    const runDue = {id:'run-due-123',action:'run_due'};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:runDue}), env)).status, 204);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), {ref:'main',inputs:{command:JSON.stringify(runDue)}});
    const status = await worker.fetch(request('/api/secrets', {token}), env);
    assert.deepEqual(await status.json(), {secrets:[{name:'OPENAI_API_KEY'}]});
    assert.equal((await worker.fetch(request('/api/secrets/OPENAI_API_KEY', {method:'PUT',token,value:{key_id:'123',encrypted_value:'YWJjZA=='}}), env)).status, 204);
    const count = calls.length;
    for (const path of ['/repos/another/repository', '/api/secrets/GITHUB_TOKEN', '/api/secrets/INITIAL_HISTORY', '/api/secrets/%2e%2e'])
      assert.equal((await worker.fetch(request(path, {method:'PUT',token,value:{}}), env)).status, 404);
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:{id:'123',action:'run_shell'}}), env)).status, 400);
    for (const invalid of [{prompt:''},{prompt:'x'.repeat(8001)},{type:'unknown'},{revision:-1},{revision:null}])
      assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:{...prompt,...invalid}}), env)).status, 400);
    assert.equal(calls.length, count);
  } finally { upstream.mock.restore(); }
});

test('foreign origins, repeated login attempts, and oversized requests are rejected', async () => {
  assert.equal((await worker.fetch(request('/api/login', {method:'POST',origin:'https://other.example',value:{password:env.STUDIO_PASSWORD}}), env)).status, 403);
  const preflight = await worker.fetch(request('/api/state', {method:'OPTIONS'}), env);
  assert.equal(preflight.status, 204);
  for (let i=0;i<10;i++) assert.equal((await worker.fetch(request('/api/login', {method:'POST',ip:'limited',value:{password:'wrong'}}), env)).status, 401);
  assert.equal((await worker.fetch(request('/api/login', {method:'POST',ip:'limited',value:{password:env.STUDIO_PASSWORD}}), env)).status, 429);
  assert.equal((await worker.fetch(request('/api/login', {method:'POST',value:{password:'x'.repeat(70000)}}), env)).status, 413);
});

test('upstream errors never expose credentials or response bodies', async () => {
  const token = await login();
  const upstream = mock.method(globalThis, 'fetch', async () => new Response(`sensitive: ${env.GITHUB_TOKEN}`, {status:403}));
  try {
    const response = await worker.fetch(request('/api/state', {token}), env);
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes(env.GITHUB_TOKEN), false);
  } finally { upstream.mock.restore(); }
});
