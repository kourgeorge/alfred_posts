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
const call = (name, args) => calls([name, args]);
/** One AI message asking for several tools at once. */
const calls = (...list) => ({ role: 'assistant', content: null, tool_calls: list.map(([name, args], i) => ({ id: `call-${i}-${name}`,
  type: 'function', function: { name, arguments: JSON.stringify(args) } })) });

test('only genuine webhook calls from listed users in private chats are handled', async () => {
  const fake = world();
  assert.equal((await webhook(message({ text: 'hi' }), { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(message({ text: 'hi' }), { secret: null })).status, 401);
  assert.equal((await webhook({}, { method: 'GET' })).status, 404);
  assert.equal((await worker.fetch(new Request('https://gateway.example/telegram/webhook', { method: 'POST' }),
    { ...env, TELEGRAM_WEBHOOK_SECRET: '' })).status, 404);
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

// A state with posts and schedules, as the bot sees it.
const busyState = () => ({ operations: [],
  drafts: [
    { id: 'draft-a', type: 'image', status: 'scheduled', revision: 3, scheduled_at: '2099-03-02T08:00:00+00:00', text: 'Morning post',
      created_at: '2099-01-01T08:00:00+00:00', source: { name: 'lesson.jpg' } },
    { id: 'draft-b', type: 'image', status: 'published', revision: 1, text: 'Old', published_at: '2099-01-01T08:00:00+00:00', source: { name: 'old.jpg' } },
    { id: 'draft-c', type: 'video', status: 'draft', revision: 2, text: 'Saved draft', created_at: '2099-01-02T08:00:00+00:00', source: { name: 'car.mp4' } },
    { id: 'draft-d', type: 'image', status: 'failed', revision: 1, text: 'Broken', error: 'Facebook rejected the request', source: { name: 'x.jpg' } },
    { id: 'draft-e', type: 'news', status: 'draft', revision: 1, text: 'News', source: { name: 'Story' } },
    { id: 'draft-z', type: 'image', status: 'deleted', revision: 4, text: 'Gone', source: { name: 'gone.jpg' } }],
  schedules: [{ id: 'sched-1', name: 'Morning tips', type: 'image', mode: 'draft', days: [0, 2, 4], time: '09:00',
    timezone: 'Asia/Jerusalem', enabled: true }],
  missed_runs: [{ id: 'missed-1', schedule_id: 'sched-1', slot: '2099-01-05@09:00', name: 'Morning tips', type: 'image',
    mode: 'draft', scheduled_at: '2099-01-05T07:00:00+00:00', status: 'missed' }] });
const toolResults = fake => fake.openai.at(-1).messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const shown = fake => fake.sent.filter(m => m.reply_markup).at(-1);
const approve = fake => webhook(button(shown(fake).reply_markup.inline_keyboard[0][0].callback_data));

test('the AI lists posts and schedules, but never deleted posts, and sees full captions on request', async () => {
  const fake = world({ state: busyState(), ai: [calls(['list_posts', {}], ['list_posts', { filter: 'attention' }], ['list_posts', { filter: 'published' }],
    ['get_post', { post_id: 'draft-a' }], ['get_post', { post_id: 'draft-z' }], ['list_schedules', {}]), { role: 'assistant', content: 'Here is everything.' }] });
  await webhook(message({ text: 'what do I have?' }));
  const [open, attention, published, full, gone, schedules] = toolResults(fake);
  assert.deepEqual(open.posts.map(p => p.id), ['draft-a', 'draft-c', 'draft-d', 'draft-e']);
  assert.equal(open.posts[0].scheduled_for, formatted('2099-03-02T08:00:00Z'));
  assert.deepEqual(attention.posts.map(p => p.id), ['draft-d']);
  assert.equal(attention.posts[0].problem, 'Facebook rejected the request');
  assert.deepEqual(attention.missed_runs.map(r => r.missed_id), ['missed-1']);
  assert.deepEqual(published.posts.map(p => p.id), ['draft-b']);
  assert.equal(full.caption, 'Morning post');
  assert.match(gone.error, /no post/);
  assert.deepEqual(schedules.schedules[0], { schedule_id: 'sched-1', name: 'Morning tips', format: 'image', days: ['mon', 'wed', 'fri'],
    time: '09:00', timezone: 'Asia/Jerusalem', mode: 'draft', on: true, next_run: schedules.schedules[0].next_run });
  assert.ok(schedules.schedules[0].next_run);
  assert.equal(fake.dispatched.length, 0);
  assert.ok(!fake.sent.some(m => m.reply_markup));
});
const formatted = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

test('rescheduling a planned post needs no new photo and sends one approved command', async () => {
  const fake = world({ state: busyState(), ai: [call('list_posts', { filter: 'scheduled' }),
    call('propose_edit', { post_id: 'draft-a', when: '2099-03-19T18:00' }), { role: 'assistant', content: '' }] });
  await webhook(message({ text: 'Change the schedule of the previous post to the 19th at 18:00' }));
  assert.match(shown(fake).text, /Change this post\?[\s\S]*New time:[\s\S]*Morning post/);
  assert.equal(fake.dispatched.length, 0);
  await approve(fake);
  assert.deepEqual({ ...fake.dispatched[0], id: undefined }, { id: undefined, action: 'schedule_draft', draft_id: 'draft-a', revision: 3,
    scheduled_at: '2099-03-19T16:00:00.000Z', notify_chat_id: String(OWNER), notify_language: 'en' });
  assert.match(fake.dispatched[0].id, /^telegram-/);
});

test('one edit can change the caption with a new time, publish now, unschedule, or keep the time', async () => {
  const cases = [
    [{ caption: 'Shorter caption', when: 'now' }, { action: 'publish', text: 'Shorter caption' }, /Publish now[\s\S]*New caption:\nShorter caption/],
    [{ when: 'draft' }, { action: 'cancel_draft' }, /Unschedule it/],
    [{ caption: 'Only the words' }, { action: 'save_draft', text: 'Only the words' }, /stays scheduled/],
  ];
  for (const [args, expected, text] of cases) {
    mock.restoreAll();
    const fake = world({ state: busyState(), ai: [call('propose_edit', { post_id: 'draft-a', ...args }), { role: 'assistant', content: '' }] });
    await webhook(message({ text: 'change it' }));
    assert.match(shown(fake).text, text);
    await approve(fake);
    assert.deepEqual({ action: fake.dispatched[0].action, draft_id: fake.dispatched[0].draft_id, ...(expected.text ? { text: fake.dispatched[0].text } : {}) },
      { draft_id: 'draft-a', ...expected });
  }
});

test('edits are refused for published, deleted, unknown or unchanged posts, and media needs a sent photo', async () => {
  const fake = world({ state: busyState(), ai: [calls(['propose_edit', { post_id: 'draft-b', caption: 'x' }], ['propose_edit', { post_id: 'draft-z', caption: 'x' }],
    ['propose_edit', { post_id: 'nope', caption: 'x' }], ['propose_edit', { post_id: 'draft-c' }], ['propose_edit', { post_id: 'draft-c', when: 'draft' }],
    ['propose_edit', { post_id: 'draft-c', replace_media: true }], ['propose_edit', { post_id: 'draft-c', when: '2001-01-01T10:00' }],
    ['propose_delete', { post_id: 'draft-b' }]), { role: 'assistant', content: 'Which post?' }] });
  await webhook(message({ text: 'change it' }));
  const errors = toolResults(fake).map(r => r.error);
  assert.match(errors[0], /published/);
  assert.match(errors[1], /no post/);
  assert.match(errors[2], /no post/);
  assert.match(errors[3], /Nothing would change/);
  assert.match(errors[4], /Nothing would change/);
  assert.match(errors[5], /has not sent a photo/);
  assert.match(errors[6], /passed/);
  assert.match(errors[7], /published/);
  assert.ok(!fake.sent.some(m => m.reply_markup));
});

test('a photo sent in the chat can replace a saved post\'s media, keeping its caption', async () => {
  const fake = world({ state: busyState(), ai: [{ role: 'assistant', content: 'Should I write a new post or use it for a saved one?' },
    call('propose_edit', { post_id: 'draft-e', replace_media: true }), call('propose_edit', { post_id: 'draft-a', replace_media: true, when: '2099-05-01T10:00' }),
    call('propose_edit', { post_id: 'draft-a', replace_media: true }), { role: 'assistant', content: '' }] });
  await webhook(photo());
  const upload = fake.chat().upload.id;
  await webhook(message({ text: 'use this photo for the Monday post' }));
  const errors = toolResults(fake).map(r => r.error);
  assert.match(errors[0], /News posts/);
  assert.match(errors[1], /Replace the photo or video first/);
  assert.match(shown(fake).text, /Replace its photo or video[\s\S]*stays scheduled[\s\S]*Morning post/);
  await approve(fake);
  assert.deepEqual({ ...fake.dispatched[0], id: undefined, notify_chat_id: undefined, notify_language: undefined },
    { id: undefined, notify_chat_id: undefined, notify_language: undefined, action: 'replace_media', draft_id: 'draft-a', revision: 3,
      text: 'Morning post', type: 'image', upload_id: upload });
  assert.equal(fake.chat().upload, null);
});

test('posts can be deleted and new drafts generated from Drive, Forms or the news, after approval', async () => {
  const fake = world({ state: busyState(), ai: [call('propose_delete', { post_id: 'draft-c' }), { role: 'assistant', content: '' },
    call('propose_generate', { format: 'news', style: 'nonsense' }), call('propose_generate', { format: 'news', style: 'funny' }), { role: 'assistant', content: '' }] });
  await webhook(message({ text: 'delete the video draft' }));
  assert.match(shown(fake).text, /Delete this post\?[\s\S]*Saved draft/);
  await approve(fake);
  assert.deepEqual([fake.dispatched[0].action, fake.dispatched[0].draft_id, fake.dispatched[0].revision], ['delete_draft', 'draft-c', 2]);
  await webhook(message({ text: 'make a funny news post' }));
  assert.match(toolResults(fake)[0].error, /Choose a style/);
  assert.match(shown(fake).text, /new news draft in a funny style/);
  await approve(fake);
  assert.deepEqual([fake.dispatched[1].action, fake.dispatched[1].type, fake.dispatched[1].caption_style], ['generate', 'news', 'funny']);
  // The new post's id is remembered, so a later "the previous post" can find it.
  assert.ok(fake.chat().messages.at(-1).content.includes(fake.dispatched[1].id));
});

test('recurring schedules can be created, changed, paused, resumed and deleted after approval', async () => {
  const fake = world({ state: busyState(), ai: [
    call('propose_schedule', { name: 'Evening', format: 'video' }),
    call('propose_schedule', { name: 'Evening', format: 'video', days: ['sun', 'thu'], time: '9:30', mode: 'publish' }), { role: 'assistant', content: '' },
    call('propose_schedule', { schedule_id: 'sched-1', time: '09:00' }), call('propose_schedule', { schedule_id: 'sched-1', time: '10:15', days: ['tue'] }), { role: 'assistant', content: '' },
    call('propose_schedule_switch', { schedule_id: 'sched-1', on: true }), call('propose_schedule_switch', { schedule_id: 'sched-1', on: false }), { role: 'assistant', content: '' },
    call('propose_delete_schedule', { schedule_id: 'sched-1' }), { role: 'assistant', content: '' }] });
  await webhook(message({ text: 'new schedule' }));
  assert.match(toolResults(fake)[0].error, /needs: days, time, mode/);
  assert.match(shown(fake).text, /Create this recurring schedule\?[\s\S]*Days: Thu, Sun[\s\S]*Time: 09:30[\s\S]*without review/);
  await approve(fake);
  assert.deepEqual(fake.dispatched[0].schedule, { name: 'Evening', type: 'video', mode: 'publish', days: [3, 6], time: '09:30',
    timezone: 'Asia/Jerusalem', enabled: true });
  assert.equal(fake.dispatched[0].schedule_id, undefined);
  await webhook(message({ text: 'move morning tips to tuesday 10:15' }));
  assert.match(toolResults(fake)[0].error, /Nothing would change/);
  assert.match(shown(fake).text, /Change the schedule "Morning tips"/);
  await approve(fake);
  assert.deepEqual([fake.dispatched[1].action, fake.dispatched[1].schedule_id, fake.dispatched[1].schedule.time, fake.dispatched[1].schedule.days,
    fake.dispatched[1].schedule.mode], ['save_schedule', 'sched-1', '10:15', [1], 'draft']);
  await webhook(message({ text: 'pause it' }));
  assert.match(toolResults(fake)[0].error, /already on/);
  await approve(fake);
  assert.deepEqual([fake.dispatched[2].action, fake.dispatched[2].enabled], ['toggle_schedule', false]);
  await webhook(message({ text: 'delete it' }));
  await approve(fake);
  assert.deepEqual([fake.dispatched[3].action, fake.dispatched[3].schedule_id], ['delete_schedule', 'sched-1']);
});

test('missed runs can be recovered, due tasks run, and only one change waits at a time', async () => {
  const fake = world({ state: busyState(), ai: [call('propose_missed', { missed_id: 'nope' }), call('propose_missed', { missed_id: 'missed-1' }),
    call('propose_run_due', {}), { role: 'assistant', content: '' }, call('propose_run_due', {}), { role: 'assistant', content: '' }] });
  await webhook(message({ text: 'fix the missed post and run everything' }));
  const results = toolResults(fake);
  assert.match(results[0].error, /no missed run/);
  assert.match(results[2].error, /already waiting/);
  assert.match(shown(fake).text, /missed post from "Morning tips"/);
  await approve(fake);
  assert.deepEqual([fake.dispatched[0].action, fake.dispatched[0].missed_id], ['recover_missed', 'missed-1']);
  await webhook(message({ text: 'now run due tasks' }));
  await approve(fake);
  assert.equal(fake.dispatched[1].action, 'run_due');
});

test('a suggestion saved by the previous bot version cannot be approved', async () => {
  const fake = world();
  await webhook(message({ text: '/reset' }));
  const file = fake.files.get(`telegram/chat-${OWNER}.json`);
  const chat = JSON.parse(Buffer.from(file.bytes).toString());
  chat.pending = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', action: 'unschedule', draft_id: 'draft-a', revision: 3,
    expires_at: new Date(Date.now() + 60000).toISOString() };
  file.bytes = Buffer.from(JSON.stringify(chat));
  await webhook(button('ok:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
  assert.equal(fake.dispatched.length, 0);
  assert.match(fake.sent.at(-1).text, /no longer available/);
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

test('a reasoning model that needs reasoning turned off for tools is retried once with it off', async () => {
  const fake = world({ state: { drafts: [], schedules: [], operations: [], ai_settings: { model: 'reasoning-model' } } });
  const requests = [];
  const telegramFetch = globalThis.fetch;
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url) !== 'https://api.openai.com/v1/chat/completions') return telegramFetch(url, options);
    const body = JSON.parse(options.body); requests.push(body);
    if (body.reasoning_effort !== 'none') return Response.json({ error: { message: "Function tools with reasoning_effort are not supported for reasoning-model in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." } }, { status: 400 });
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello!' } }] });
  });
  await webhook(message({ text: 'hi' }));
  await webhook(message({ text: 'again' }));
  assert.deepEqual(requests.map(r => r.reasoning_effort ?? null), [null, 'none', 'none']);
  assert.ok(requests.every(r => r.model === 'reasoning-model' && r.tools.length === 12));
  // A bot-only model takes priority over the studio's shared model.
  await worker.fetch(new Request('https://gateway.example/telegram/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: ++updateId, ...message({ text: 'third' }) }) }), { ...env, TELEGRAM_OPENAI_MODEL: 'bot-model' });
  assert.equal(requests.at(-1).model, 'bot-model');
  assert.deepEqual(fake.sent.filter(m => m.method === 'sendMessage').map(m => m.text), ['Hello!', 'Hello!', 'Hello!']);
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

// ---- Settings → Telegram bot (dashboard) ----

const SETTINGS_KEY = 'k'.repeat(40);
async function session(extraEnv = {}) {
  const response = await worker.fetch(new Request('https://gateway.example/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://kourgeorge.github.io', 'CF-Connecting-IP': `bot-${++updateId}` },
    body: JSON.stringify({ password: env.STUDIO_PASSWORD }) }), { ...env, ...extraEnv });
  return (await response.json()).token;
}
function api(path, token, { method = 'GET', value, extraEnv = {} } = {}) {
  return worker.fetch(new Request(`https://gateway.example${path}`, { method, headers: { 'Content-Type': 'application/json',
    Origin: 'https://kourgeorge.github.io', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), { ...env, SETTINGS_KEY, ...extraEnv });
}

test('bot settings need a studio session and never return keys', async () => {
  const fake = world();
  for (const [path, method] of [['/api/telegram', 'GET'], ['/api/telegram', 'PUT'], ['/api/telegram/connect', 'POST']])
    assert.equal((await api(path, null, { method, value: method === 'PUT' ? {} : undefined })).status, 401);
  const token = await session();
  const status = await (await api('/api/telegram', token)).json();
  assert.deepEqual([status.enabled, status.users, status.token_set, status.openai_key_set, status.settings_key_set], [true, [String(OWNER), '2002'], true, true, true]);
  const text = JSON.stringify(status);
  assert.ok(!text.includes('secret-bot-token') && !text.includes('private-ai-key') && !text.includes(env.TELEGRAM_WEBHOOK_SECRET));
  void fake;
});

test('saved users, model and pause switch apply to the bot on the next message', async () => {
  const fake = world({ ai: [{ role: 'assistant', content: 'Hi from the new model' }] });
  const token = await session();
  const saved = await api('/api/telegram', token, { method: 'PUT', value: { revision: 0, users: ['3003'], model: 'bot-model' } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).users, ['3003']);
  // The owner from the gateway variable is no longer allowed; the new user is.
  await webhook(message({ text: 'hello' }));
  assert.equal(fake.openai.length, 0);
  const newUser = from(3003);
  await worker.fetch(new Request('https://gateway.example/telegram/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: ++updateId, ...message({ text: 'hello' }, newUser) }) }), { ...env, SETTINGS_KEY });
  assert.equal(fake.openai.at(-1).model, 'bot-model');
  // A second save must start from the latest revision.
  assert.equal((await api('/api/telegram', token, { method: 'PUT', value: { revision: 0, enabled: false } })).status, 409);
  assert.equal((await api('/api/telegram', token, { method: 'PUT', value: { revision: 1, enabled: false } })).status, 200);
  const before = fake.openai.length;
  await worker.fetch(new Request('https://gateway.example/telegram/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: ++updateId, ...message({ text: 'are you there?' }, newUser) }) }), { ...env, SETTINGS_KEY });
  assert.equal(fake.openai.length, before);
  assert.match(fake.sent.at(-1).text, /paused/);
});

test('a new bot token and OpenAI key are checked, encrypted at rest, used by the bot, and connect the webhook', async () => {
  const fake = world({ ai: [{ role: 'assistant', content: 'Using the saved key' }] });
  const token = await session();
  const newToken = '999999:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  // The fake Telegram only answers the original token's URLs, so route the new one too.
  const base = globalThis.fetch; const authorization = [];
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    url = String(url);
    if (url.startsWith(`https://api.telegram.org/bot${newToken}/`)) {
      const method = url.split('/').at(-1); const body = JSON.parse(options.body || '{}');
      fake.sent.push({ method, viaNewToken: true, ...body });
      if (method === 'getMe') return Response.json({ ok: true, result: { username: 'new_bot', first_name: 'New' } });
      if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: 'https://gateway.example/telegram/webhook', pending_update_count: 0 } });
      return Response.json({ ok: true, result: true });
    }
    if (url === 'https://api.openai.com/v1/chat/completions') authorization.push(options.headers.Authorization);
    return base(url, options);
  });
  for (const bad of [{ TELEGRAM_BOT_TOKEN: 'not-a-token' }, { OPENAI_API_KEY: 'short' }, { users: ['abc'] }, { model: 'bad model!' }, { extra: true }])
    assert.equal((await api('/api/telegram', token, { method: 'PUT', value: { revision: 0, ...bad } })).status, 400, JSON.stringify(bad));
  assert.equal((await api('/api/telegram', token, { method: 'PUT', value: { revision: 0, TELEGRAM_BOT_TOKEN: newToken },
    extraEnv: { SETTINGS_KEY: '' } })).status, 503);
  const saved = await api('/api/telegram', token, { method: 'PUT', value: { revision: 0, TELEGRAM_BOT_TOKEN: newToken, OPENAI_API_KEY: 'sk-new-dashboard-key-1234567890' } });
  assert.equal(saved.status, 200);
  const status = await saved.json();
  assert.deepEqual([status.bot.username, status.connected], ['new_bot', true]);
  const hook = fake.sent.find(m => m.method === 'setWebhook' && m.viaNewToken);
  assert.deepEqual([hook.url, hook.secret_token], ['https://gateway.example/telegram/webhook', env.TELEGRAM_WEBHOOK_SECRET]);
  const stored = Buffer.from(fake.files.get('telegram/settings.json').bytes).toString();
  assert.ok(!stored.includes(newToken) && !stored.includes('sk-new-dashboard-key'));
  await worker.fetch(new Request('https://gateway.example/telegram/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: ++updateId, ...message({ text: 'hello' }) }) }), { ...env, SETTINGS_KEY });
  assert.deepEqual(authorization, ['Bearer sk-new-dashboard-key-1234567890']);
  assert.ok(fake.sent.some(m => m.viaNewToken && m.method === 'sendMessage' && m.text === 'Using the saved key'));
});
