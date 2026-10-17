// The Telegram bot in the GitHub gateway, with Telegram, OpenAI and GitHub replaced by fakes.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../gateway/worker.js';

afterEach(() => mock.restoreAll());

const OWNER = 1001;
const env = { STUDIO_PASSWORD: 'test-password', SESSION_SECRET: 'test-signing-secret', GITHUB_TOKEN: 'server-only-github-key',
  TELEGRAM_BOT_TOKEN: '123:secret-bot-token', TELEGRAM_WEBHOOK_SECRET: 'webhook-secret', TELEGRAM_ALLOWED_USER_IDS: ` ${OWNER} ,2002`,
  OPENAI_API_KEY: 'private-ai-key' };
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array(60).fill(7)]);
const THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 1, 2, 3]);
const REPO = 'https://api.github.com/repos/kourgeorge/alfred_posts_automation';

/** A fake GitHub repository (state branch files), Telegram and OpenAI. `ai` returns the next OpenAI message. */
function world({ ai = [], state = { drafts: [], schedules: [], operations: [] } } = {}) {
  const files = new Map(); const sent = []; const dispatched = []; const openai = []; const all = [];
  let sha = 0;
  const replies = [...ai];
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    url = String(url); all.push({ url, options });
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    if (url.startsWith('https://api.telegram.org/file/bot123:secret-bot-token/')) {
      return new Response(url.endsWith('thumb.jpg') ? THUMB : PHOTO);
    }
    if (url.startsWith('https://api.telegram.org/bot123:secret-bot-token/')) {
      const method = url.split('/').at(-1);
      if (method === 'getFile') return Response.json({ ok: true, result: { file_path: body.file_id === 'thumb' ? 'thumb.jpg' : 'photo.jpg',
        file_size: body.file_id === 'big' ? 25 * 1024 * 1024 : PHOTO.length } });
      sent.push({ method, ...body });
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    if (url === 'https://api.openai.com/v1/chat/completions') {
      openai.push(body);
      const next = replies.shift();
      if (!next) return new Response('provider body with private-ai-key', { status: 500 });
      return Response.json({ choices: [{ message: next }] });
    }
    if (url === REPO) return Response.json({ private: true });
    if (url === `${REPO}/contents/state.json?ref=studio-state`) return Response.json(state);
    if (url === `${REPO}/actions/workflows/studio.yml/dispatches`) {
      dispatched.push(JSON.parse(body.inputs.command));
      return new Response(null, { status: 204 });
    }
    const read = url.match(/\/contents\/(.+)\?ref=studio-state$/);
    if (read) {
      const file = files.get(read[1]);
      return file ? Response.json({ sha: file.sha, size: file.bytes.length, encoding: 'base64',
        content: Buffer.from(file.bytes).toString('base64') }) : new Response('{}', { status: 404 });
    }
    const write = url.match(/\/contents\/(.+)$/);
    if (write && options.method === 'PUT') {
      const path = write[1]; const existing = files.get(path);
      const bytes = Buffer.from(body.content, 'base64');
      if (path.startsWith('uploads/')) {
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (existing) return new Response('{}', { status: 422 });
        files.set(path, { bytes, sha: blob });
        return Response.json({ content: { sha: blob } });
      }
      if ((existing?.sha ?? undefined) !== body.sha) return new Response('{}', { status: 409 });
      files.set(path, { bytes, sha: `v${++sha}` });
      return Response.json({ content: { sha: `v${sha}` } });
    }
    throw new Error(`Unexpected request to ${url}`);
  });
  const chat = () => JSON.parse(Buffer.from(files.get(`telegram/chat-${OWNER}.json`).bytes).toString());
  return { files, sent, dispatched, openai, all, chat };
}

let updateId = 0;
function webhook(update, { secret = env.TELEGRAM_WEBHOOK_SECRET, method = 'POST' } = {}) {
  return worker.fetch(new Request('https://gateway.example/telegram/webhook', { method,
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ update_id: ++updateId, ...update }) } : {}) }), env);
}
const from = (id = OWNER, language_code = 'en') => ({ id, is_bot: false, first_name: 'Alfred', language_code });
const message = (fields, user = from()) => ({ message: { message_id: 1, from: user, chat: { id: user.id, type: 'private' }, ...fields } });
const photo = caption => message({ caption, photo: [{ file_id: 'small', width: 320, height: 240 }, { file_id: 'thumb', width: 800, height: 600 },
  { file_id: 'large', width: 2000, height: 1500 }] });
const button = data => ({ callback_query: { id: 'q1', from: from(), data, message: { message_id: 5, chat: { id: OWNER, type: 'private' } } } });
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call-${name}`, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] });

test('only genuine webhook calls from listed users in private chats are handled', async () => {
  const fake = world();
  assert.equal((await webhook(message({ text: 'hi' }), { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(message({ text: 'hi' }), { secret: null })).status, 401);
  assert.equal((await webhook({}, { method: 'GET' })).status, 404);
  assert.equal((await worker.fetch(new Request('https://gateway.example/telegram/webhook', { method: 'POST' }),
    { ...env, TELEGRAM_BOT_TOKEN: '' })).status, 404);
  assert.equal(fake.all.length, 0);
  // A stranger only learns their own user ID (to help with setup); nothing is read or stored.
  assert.equal((await webhook(message({ text: '/start' }, from(3003)))).status, 200);
  assert.equal((await webhook(message({ text: 'publish everything' }, from(3003)))).status, 200);
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].text, /3003/);
  assert.equal(fake.openai.length, 0);
  assert.equal(fake.files.size, 0);
  // Group chats are ignored, even for the owner.
  await webhook({ message: { message_id: 2, from: from(), chat: { id: -5, type: 'group' }, text: 'hi' } });
  assert.equal(fake.sent.length, 1);
});

test('a photo is saved as a studio upload, the AI sees it, and Approve schedules the post', async () => {
  const fake = world({ ai: [call('propose_post', { caption: 'Congratulations on passing!', when: '2099-03-01T18:00' }), { role: 'assistant', content: '' }] });
  assert.equal((await webhook(photo('Student passed her test, post tomorrow at 18:00'))).status, 200);
  // The original (largest) photo is stored exactly, in the studio's upload format.
  const manifestPath = [...fake.files.keys()].find(p => p.endsWith('manifest.json'));
  const manifest = JSON.parse(Buffer.from(fake.files.get(manifestPath).bytes).toString());
  assert.deepEqual([manifest.type, manifest.mime, manifest.size, manifest.parts], ['image', 'image/jpeg', PHOTO.length, 1]);
  assert.equal(manifest.sha256, createHash('sha256').update(PHOTO).digest('hex'));
  assert.deepEqual(new Uint8Array(fake.files.get(manifestPath.replace('manifest.json', 'part-00.bin')).bytes), PHOTO);
  // The AI receives the medium-size image (not a URL with the bot token) and the saved writing instructions.
  const request = fake.openai[0];
  const user = request.messages.at(-1).content;
  assert.match(user[0].text, /Student passed her test/);
  assert.equal(user[1].image_url.url, `data:image/jpeg;base64,${Buffer.from(THUMB).toString('base64')}`);
  assert.ok(request.messages[0].content.includes('כללי דיוק מחייבים'));
  assert.equal(request.model, 'gpt-4.1-mini');
  assert.ok(!JSON.stringify(fake.openai).includes('secret-bot-token'));
  // The proposal is shown with buttons; nothing has been dispatched yet.
  const shown = fake.sent.find(m => m.reply_markup);
  assert.match(shown.text, /Congratulations on passing!/);
  assert.match(shown.text, /Schedule for/);
  assert.equal(fake.dispatched.length, 0);
  const [ok, no] = shown.reply_markup.inline_keyboard[0].map(b => b.callback_data);
  assert.match(no, /^no:/);
  await webhook(button(ok));
  assert.equal(fake.dispatched.length, 1);
  const command = fake.dispatched[0];
  assert.deepEqual({ ...command, id: undefined }, { id: undefined, action: 'create_upload_draft', type: 'image', upload_id: manifest.id,
    text: 'Congratulations on passing!', description: 'Student passed her test, post tomorrow at 18:00',
    scheduled_at: '2099-03-01T16:00:00.000Z', notify_chat_id: String(OWNER), notify_language: 'en' });
  // A second tap (or Telegram repeating the tap) cannot post twice.
  await webhook(button(ok));
  assert.equal(fake.dispatched.length, 1);
  assert.match(fake.sent.at(-1).text, /no longer available/);
  assert.equal(fake.chat().upload, null);
});

test('chat history lets the owner revise; Cancel and expired suggestions change nothing', async () => {
  const fake = world({ ai: [call('propose_post', { caption: 'First caption', when: 'draft' }), { role: 'assistant', content: 'Here you go.' },
    call('propose_post', { caption: 'Funnier caption', when: 'now' }), { role: 'assistant', content: '' }] });
  await webhook(photo());
  const first = fake.sent.find(m => m.reply_markup).reply_markup.inline_keyboard[0][0].callback_data;
  await webhook(message({ text: 'make it funnier and post it now' }));
  const second = fake.openai.at(-2);
  assert.ok(second.messages.some(m => m.role === 'assistant' && String(m.content).includes('First caption')));
  assert.ok(second.messages[0].content.includes('First caption'));
  // Only the newest suggestion can be approved.
  await webhook(button(first));
  assert.equal(fake.dispatched.length, 0);
  const latest = fake.sent.filter(m => m.method === 'sendMessage' && m.reply_markup).at(-1);
  assert.match(latest.text, /Funnier caption[\s\S]*Publish now/);
  const [ok, no] = latest.reply_markup.inline_keyboard[0].map(b => b.callback_data);
  await webhook(button(no));
  assert.match(fake.sent.at(-1).text, /Cancelled/);
  await webhook(button(ok));
  assert.equal(fake.dispatched.length, 0);
});

test('an expired suggestion cannot be approved', async () => {
  const fake = world({ ai: [call('propose_post', { caption: 'Caption', when: 'draft' }), { role: 'assistant', content: '' }] });
  await webhook(photo());
  const ok = fake.sent.find(m => m.reply_markup).reply_markup.inline_keyboard[0][0].callback_data;
  const now = Date.now();
  const clock = mock.method(Date, 'now', () => now + 25 * 60 * 60 * 1000);
  try { await webhook(button(ok)); } finally { clock.mock.restore(); }
  assert.equal(fake.dispatched.length, 0);
});

test('the AI can list and unschedule posts, but only real scheduled ones, after approval', async () => {
  const state = { drafts: [{ id: 'draft-a', type: 'image', status: 'scheduled', revision: 3, scheduled_at: '2099-03-02T08:00:00+00:00', text: 'Morning post' },
    { id: 'draft-b', type: 'image', status: 'published', revision: 1, text: 'Old' }], schedules: [], operations: [] };
  const fake = world({ state, ai: [call('list_scheduled', {}), call('propose_cancel', { draft_id: 'draft-b' }),
    call('propose_cancel', { draft_id: 'draft-a' }), { role: 'assistant', content: '' }] });
  await webhook(message({ text: 'cancel the post on Monday' }));
  const results = fake.openai.at(-1).messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.deepEqual(results[0].scheduled.map(d => d.id), ['draft-a']);
  assert.match(results[1].error, /no scheduled post/);
  const shown = fake.sent.find(m => m.reply_markup);
  assert.match(shown.text, /Unschedule[\s\S]*Morning post/);
  await webhook(button(shown.reply_markup.inline_keyboard[0][0].callback_data));
  assert.equal(fake.dispatched[0].action, 'cancel_draft');
  assert.deepEqual([fake.dispatched[0].draft_id, fake.dispatched[0].revision], ['draft-a', 3]);
});

test('posting needs a photo or video, and past times are refused', async () => {
  const fake = world({ ai: [call('propose_post', { caption: 'No media', when: 'now' }), { role: 'assistant', content: 'Please send a photo first.' }] });
  await webhook(message({ text: 'write a post' }));
  assert.match(JSON.parse(fake.openai[0].messages.at(-1).content ? fake.openai[1].messages.at(-1).content : '{}').error, /no photo/);
  assert.ok(!fake.sent.some(m => m.reply_markup));
  assert.equal(fake.sent.at(-1).text, 'Please send a photo first.');
  mock.restoreAll();
  const later = world({ ai: [call('propose_post', { caption: 'Late', when: '2001-01-01T10:00' }), { role: 'assistant', content: 'When?' }] });
  await webhook(photo());
  assert.match(JSON.parse(later.openai[1].messages.at(-1).content).error, /passed/);
  assert.ok(!later.sent.some(m => m.reply_markup));
});

test('repeated updates, large files, unsupported files and AI failures are handled safely', async () => {
  const fake = world();
  const update = { update_id: 99999, ...message({ text: '/start' }) };
  for (let i = 0; i < 2; i++) await worker.fetch(new Request('https://gateway.example/telegram/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify(update) }), env);
  assert.equal(fake.sent.length, 1);
  await webhook(message({ video: { file_id: 'big', mime_type: 'video/mp4', file_size: 25 * 1024 * 1024 } }));
  assert.match(fake.sent.at(-1).text, /too large/);
  await webhook(message({ document: { file_id: 'doc', mime_type: 'application/pdf', file_name: 'notes.pdf' } }));
  assert.match(fake.sent.at(-1).text, /JPG, PNG or WebP/);
  assert.ok(![...fake.files.keys()].some(p => p.startsWith('uploads/')));
  await webhook(message({ text: 'hello' }));
  assert.match(fake.sent.at(-1).text, /could not reach the AI/);
  assert.ok(!fake.sent.some(m => /private-ai-key|provider body/.test(m.text)));
  await webhook(message({ text: '/reset' }));
  assert.deepEqual(fake.chat().messages, []);
});

test('Hebrew users get Hebrew bot messages', async () => {
  const fake = world();
  await webhook(message({ text: '/start' }, from(OWNER, 'he')));
  assert.match(fake.sent[0].text, /שלום/);
});

test('the dashboard command check accepts bot commands and rejects malformed ones', async () => {
  const { validateCommand } = await import('../gateway/core.js');
  const good = { id: 'telegram-1', action: 'create_upload_draft', type: 'video', upload_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    text: 'Caption', publish: true, notify_chat_id: '1001', notify_language: 'he' };
  assert.deepEqual(validateCommand(good), good);
  for (const bad of [{ type: 'news' }, { text: '' }, { upload_id: '../x' }, { publish: 'yes' }, { scheduled_at: '2099-01-01T00:00:00Z' },
    { notify_chat_id: 'abc' }, { notify_language: 'fr' }])
    assert.throws(() => validateCommand({ ...good, ...bad }), JSON.stringify(bad));
});
