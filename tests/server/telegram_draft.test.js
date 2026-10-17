// JavaScript port of tests/test_telegram.py: captions approved in the Telegram bot.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../server/store.js';
import { Studio, CommandFailed } from '../../server/service.js';
import { MediaService } from '../../server/media.js';
import { CHUNK_SIZE } from '../../server/uploads.js';
import { encoder, sha256Hex } from '../../server/util.js';

afterEach(() => mock.restoreAll());

const images = {
  async info(data) { return data[0] === 0x89 && data[1] === 0x50 ? { width: 32, height: 20, format: 'image/png' } : null; },
  async thumbnail(data) { return (await this.info(data)) ? 'data:image/jpeg;base64,/9j/2Q==' : null; },
};
const config = { openai_api_key: 'private-ai-key', openai_model_image: 'photo-model', openai_model_video: 'video-model',
  timezone: 'Asia/Jerusalem', fb_graph_version: 'v23.0', fb_page_id: 'page', fb_page_access_token: 'private-facebook-key' };
const UPLOAD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...Array(17).fill(1),
  0, 0, 0, 1, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0, 0]);

async function setup() {
  const store = new MemoryStore();
  const manifest = { id: UPLOAD_ID, name: 'telegram-photo.png', type: 'image', mime: 'image/png', size: PNG.length,
    parts: Math.ceil(PNG.length / CHUNK_SIZE), sha256: await sha256Hex(PNG) };
  store.files[`uploads/${UPLOAD_ID}/manifest.json`] = encoder.encode(JSON.stringify(manifest));
  store.files[`uploads/${UPLOAD_ID}/part-00.bin`] = PNG;
  const app = new Studio(store, () => new MediaService(config, { store, images }), { clock: () => new Date(Date.UTC(2098, 0, 1)) });
  return { store, app };
}
function network(routes) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [match, reply] of routes) if (String(url).startsWith(match)) return reply();
    throw new Error(`Unexpected request to ${url}`);
  });
  return calls;
}
const command = extra => ({ id: 'telegram-1111-2222', action: 'create_upload_draft', type: 'image', upload_id: UPLOAD_ID,
  text: '  Caption approved in Telegram  ', notify_chat_id: '42', ...extra });

test('an approved caption is saved without the AI, scheduled once, and published from the original upload', async () => {
  const { store, app } = await setup();
  const calls = network([]);
  await app.command(command({ scheduled_at: '2099-01-01T10:00:00Z', description: 'Parking practice' }));
  await app.command(command({ scheduled_at: '2099-01-01T10:00:00Z' }));
  assert.equal(calls.length, 0);
  assert.equal(store.state.drafts.length, 1);
  const draft = store.state.drafts[0];
  assert.deepEqual([draft.status, draft.text, draft.scheduled_at], ['scheduled', 'Caption approved in Telegram', '2099-01-01T10:00:00+00:00']);
  assert.deepEqual([draft.source.origin, draft.source.description], ['telegram', 'Parking practice']);
  const posts = network([['https://graph.facebook.com/v23.0/page/photos', () => Response.json({ id: 'receipt' })]]);
  await app.tick(new Date(Date.UTC(2099, 0, 1, 10, 30)));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.body.get('message'), 'Caption approved in Telegram');
});

test('publish now and save as draft', async () => {
  const { store, app } = await setup();
  await app.command(command({ id: 'telegram-draft-0001' }));
  assert.equal(store.state.drafts[0].status, 'draft');
  network([['https://graph.facebook.com/v23.0/page/photos', () => Response.json({ id: '1_2' })]]);
  await app.command(command({ publish: true }));
  assert.equal(store.state.drafts.find(d => d.id === 'telegram-1111-2222').status, 'published');
});

test('invalid requests and changed uploads are refused before a draft is saved', async () => {
  const { store, app } = await setup();
  let n = 0;
  for (const extra of [{ type: 'question' }, { text: '  ' }, { text: 'x'.repeat(12001) }, { upload_id: '../state.json' },
    { scheduled_at: '2000-01-01T10:00:00Z' }, { scheduled_at: '2099-01-01T10:00:00Z', publish: true }])
    await assert.rejects(app.command(command({ id: `telegram-bad-${++n}-request`, ...extra })), CommandFailed, JSON.stringify(extra));
  store.files[`uploads/${UPLOAD_ID}/part-00.bin`] = new Uint8Array(PNG.length).fill(120);
  await assert.rejects(app.command(command()), CommandFailed);
  assert.deepEqual(store.state.drafts, []);
});
