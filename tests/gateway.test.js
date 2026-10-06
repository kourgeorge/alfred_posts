import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    const command = {id:'request-123',action:'generate',type:'image',caption_style:'funny'};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:command}), env)).status, 204);
    assert.deepEqual(JSON.parse(calls[1].options.body), {ref:'main',inputs:{command:JSON.stringify(command)}});
    const prompt = {id:'prompt-save-123',action:'save_prompt',type:'question',prompt:'Write a short intro. שלום',revision:0};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:prompt}), env)).status, 204);
    assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).options.body).inputs.command), prompt);
    const runDue = {id:'run-due-123',action:'run_due'};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:runDue}), env)).status, 204);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), {ref:'main',inputs:{command:JSON.stringify(runDue)}});
    const recover = {id:'recover-missed-123',action:'recover_missed',missed_id:'missed-run-123'};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:recover}), env)).status, 204);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), {ref:'main',inputs:{command:JSON.stringify(recover)}});
    const uploaded = {id:'upload-generate-123',action:'generate_upload',type:'image',upload_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',description:'Parking practice',caption_style:'professional'};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:uploaded}), env)).status, 204);
    assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).options.body).inputs.command), uploaded);
    const news = {id:'news-generate-123',action:'generate',type:'news',caption_style:'neutral'};
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:news}), env)).status, 204);
    assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).options.body).inputs.command), news);
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:{...prompt,type:'news'}}), env)).status, 204);
    assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:{...prompt,type:'news_selection'}}), env)).status, 204);
    for (const command of [{id:'models-refresh',action:'refresh_models'}, {id:'model-save',action:'save_model',model:'gpt-5-mini',revision:0}]) {
      assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:command}), env)).status, 204);
      assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).options.body).inputs.command),command);
    }
    const status = await worker.fetch(request('/api/secrets', {token}), env);
    assert.deepEqual(await status.json(), {secrets:[{name:'OPENAI_API_KEY'}]});
    assert.equal((await worker.fetch(request('/api/secrets/OPENAI_API_KEY', {method:'PUT',token,value:{key_id:'123',encrypted_value:'YWJjZA=='}}), env)).status, 204);
    assert.equal((await worker.fetch(request('/api/secrets/TAVILY_API_KEY', {method:'PUT',token,value:{key_id:'123',encrypted_value:'YWJjZA=='}}), env)).status, 204);
    const count = calls.length;
    for (const invalid of [{model:''},{model:'../../private'},{model:123},{model:'x'.repeat(151)},{revision:-1},{revision:null}])
      assert.equal((await worker.fetch(request('/api/commands', {method:'POST',token,value:{id:'invalid-model',action:'save_model',model:'gpt-5-mini',revision:0,...invalid}}), env)).status, 400);
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

const uploadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const partPath = `/api/uploads/${uploadId}/parts/0`;
test('uploads require a private repository, persist exact chunks and retry without overwriting', async () => {
  const token = await login();
  const files = new Map(); let conflict = true; let privateRepo = true;
  const upstream = mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname.replace('/repos/kourgeorge/alfred_posts_automation','');
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    if (!path) return Response.json({private:privateRepo});
    if (options.method === 'PUT') {
      const input = JSON.parse(options.body);
      assert.equal(input.branch,'studio-state');
      assert.equal(input.sha,undefined); // Never overwrite existing upload data.
      if (conflict) {conflict=false;return new Response('',{status:409});}
      if (files.has(path)) return new Response('',{status:422});
      const data = Buffer.from(input.content,'base64');
      const sha = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
      files.set(path,{sha,size:data.length,content:input.content,encoding:'base64'});
      return Response.json({content:{sha}},{status:201});
    }
    if (path.startsWith('/git/blobs/')) return Response.json([...files.values()].find(file=>path.endsWith(file.sha)));
    const file = files.get(path);
    return file ? Response.json({...file,encoding:'none',content:''}) : new Response('',{status:404});
  });
  try {
    const payload = {content:Buffer.alloc(2*1024*1024,17).toString('base64')};
    assert.equal((await worker.fetch(request(partPath,{method:'PUT',value:payload}),env)).status,401);
    assert.equal(files.size,0);
    const first = await worker.fetch(request(partPath,{method:'PUT',token,value:payload}),env);
    assert.equal(first.status,200);
    assert.equal((await first.json()).size,2*1024*1024);
    assert.equal((await worker.fetch(request(partPath,{method:'PUT',token,value:payload}),env)).status,200);
    assert.equal((await worker.fetch(request(partPath,{method:'PUT',token,value:{content:'YQ=='}}),env)).status,409);
    assert.equal(files.size,1);
    const read = await worker.fetch(request(partPath,{token}),env);
    assert.equal((await read.json()).content,payload.content);
    const manifest = {name:'שיעור.png',type:'image',mime:'image/png',size:2*1024*1024,parts:1,sha256:'a'.repeat(64)};
    assert.equal((await worker.fetch(request(`/api/uploads/${uploadId}`,{method:'POST',token,value:manifest}),env)).status,201);
    assert.equal(files.size,2);
    privateRepo=false;
    assert.equal((await worker.fetch(request(partPath,{method:'PUT',token,value:payload}),env)).status,403);
  } finally {upstream.mock.restore();}
});

test('upload formats, limits, paths and descriptions are validated before contacting GitHub', async () => {
  const token = await login();
  const upstream = mock.method(globalThis,'fetch',()=>{throw new Error('Must not reach GitHub');});
  const manifest = {name:'photo.png',type:'image',mime:'image/png',size:20,parts:1,sha256:'a'.repeat(64)};
  try {
    for (const invalid of [{name:'../photo.png'},{mime:'image/svg+xml'},{type:'question'},{parts:2},{sha256:'invalid'}])
      assert.equal((await worker.fetch(request(`/api/uploads/${uploadId}`,{method:'POST',token,value:{...manifest,...invalid}}),env)).status,400);
    assert.equal((await worker.fetch(request(`/api/uploads/${uploadId}`,{method:'POST',token,value:{...manifest,size:11*1024*1024}}),env)).status,413);
    assert.equal((await worker.fetch(request(`/api/uploads/${uploadId}/parts/25`,{method:'PUT',token,value:{content:'YQ=='}}),env)).status,400);
    assert.equal((await worker.fetch(request(partPath,{method:'PUT',token,value:{content:'!bad'}}),env)).status,400);
    assert.equal((await worker.fetch(request(partPath,{method:'PUT',token,value:{content:'a'.repeat(3*1024*1024)}}),env)).status,413);
    for (const invalid of [{description:''},{description:'x'.repeat(2001)},{type:'question'},{upload_id:'../../state.json'}])
      assert.equal((await worker.fetch(request('/api/commands',{method:'POST',token,value:{id:'request-upload',action:'generate_upload',type:'image',upload_id:uploadId,description:'Parking practice',...invalid}}),env)).status,400);
    assert.equal(upstream.mock.callCount(),0);
  } finally {upstream.mock.restore();}
});
