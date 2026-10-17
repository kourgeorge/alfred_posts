// JavaScript port of tests/test_news.py and tests/test_uploads.py.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../server/store.js';
import { Studio, CommandFailed } from '../../server/service.js';
import { MediaService } from '../../server/media.js';
import { NewsService, articleKey, fetchPublic, mediaPreview, publicUrl } from '../../server/news.js';
import { validateSchedule } from '../../server/scheduler.js';
import { CHUNK_SIZE, readUpload, validateManifest } from '../../server/uploads.js';
import { encoder, sha256Hex, toBase64 } from '../../server/util.js';

afterEach(() => mock.restoreAll());

/** Stands in for the Cloudflare Images binding: "decodes" JPEG/PNG magic bytes. */
const images = {
  async info(data) {
    if (data[0] === 0xff && data[1] === 0xd8) return { width: 640, height: 360, format: 'image/jpeg' };
    if (data[0] === 0x89 && data[1] === 0x50) return { width: 32, height: 20, format: 'image/png' };
    return null;
  },
  async thumbnail(data) { return (await this.info(data)) ? 'data:image/jpeg;base64,/9j/2Q==' : null; },
};
const config = { tavily_api_key: 'private-tavily-key', openai_api_key: 'private-ai-key', openai_model_image: 'photo-model',
  openai_model_video: 'video-model', openai_model_question: 'question-model', timezone: 'Asia/Jerusalem',
  fb_graph_version: 'v23.0', fb_page_id: 'page', fb_page_access_token: 'private-facebook-key' };
const story = { title: 'New bus service announced', url: 'https://www.ynet.co.il/transport/article/test',
  published_date: new Date().toISOString(), content: 'The transport authority announced a new bus service today. '.repeat(5),
  images: [{ url: 'https://images.example.com/bus.jpg', description: 'A bus at a stop' }] };
const preview = { preview: 'data:image/jpeg;base64,/9j/2Q==', image_url: 'https://images.example.com/bus.jpg',
  image_description: 'A bus at a stop', media_kind: 'image' };
const ai = text => Response.json({ choices: [{ message: { content: text } }] });

/** Routes every outside request; anything unexpected fails the test. */
function network(routes) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const call = { url: String(url), options, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body };
    calls.push(call);
    for (const [match, reply] of routes) if (call.url.startsWith(match)) return reply(call);
    throw new Error(`Unexpected request to ${call.url}`);
  });
  return calls;
}
const tavily = (results = null) => ['https://api.tavily.com/search', call => {
  assert.equal(call.options.headers.Authorization, 'Bearer private-tavily-key');
  assert.equal(call.body.time_range, 'week');
  assert.ok(call.body.include_images && call.body.filter_by_published_date);
  const result = { ...story, url: call.body.include_domains.includes('reuters.com') ? 'https://www.reuters.com/world/new-bus-service' : story.url };
  return Response.json({ results: results ? results(result) : [result] });
}];

test('searches both regions, filters old, untrusted, and repeated articles', async () => {
  network([tavily(good => [good, { ...good, url: `${good.url}?utm_source=email#top` },
    { ...good, url: `${good.url}-old`, published_date: new Date(Date.now() - 12 * 86400000).toISOString() },
    { ...good, url: `${good.url}-undated`, published_date: null },
    { ...good, url: 'https://127.0.0.1/private' }, { ...good, url: 'https://untrusted.example/news' }])]);
  const candidates = await new NewsService(config, { images }).candidates([]);
  assert.equal(globalThis.fetch.mock.callCount(), 4);
  assert.deepEqual(new Set(candidates.map(c => c.region)), new Set(['israel', 'world']));
  assert.equal(candidates.length, 2);
  assert.deepEqual(await new NewsService(config, { images }).candidates(candidates.map(c => c.key)), []);
});

test('news draft is grounded, attributed, styled, and publishes only the reviewed link', async () => {
  const store = new MemoryStore();
  delete store.state.posted.news; // Existing installations have only the older formats.
  store.state.prompts = { news: 'My saved news voice, in Hebrew.' };
  const media = new MediaService(config, { images });
  const app = new Studio(store, () => media);
  await app.command({ id: 'save-news-selection', action: 'save_prompt', type: 'news_selection', prompt: 'Prioritize public transport in Israel.', revision: 0 });
  const replies = ['{"ranked_ids":[0,1]}', 'דיווח חדש על קו אוטובוס'];
  const calls = network([tavily(), ['https://api.openai.com/v1/chat/completions', () => ai(replies.shift())],
    ['https://www.ynet.co.il/', () => new Response('<meta property="og:image" content="https://images.example.com/bus.jpg">', { headers: { 'Content-Type': 'text/html' } })],
    ['https://images.example.com/', () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'Content-Type': 'image/jpeg' } })]]);
  const command = { id: 'news-generation-001', action: 'generate', type: 'news', caption_style: 'funny' };
  await app.command(command);
  await app.command(command);
  const openai = calls.filter(c => c.url.includes('openai'));
  assert.equal(openai.length, 2);
  const ranking = openai[0].body.messages[0].content;
  assert.ok(ranking.startsWith('Prioritize public transport in Israel.'));
  assert.ok(ranking.includes('"ranked_ids"') && !ranking.includes('Caption style for this draft'));
  assert.ok(openai[0].body.messages[1].content.startsWith('{"today": "'), 'Python json.dumps spacing');
  const messages = openai[1].body.messages;
  assert.ok(messages[0].content.includes('My saved news voice'));
  assert.ok(messages[0].content.includes('Caption style for this draft: Funny'));
  assert.ok(messages[0].content.includes('NEWS ACCURACY RULES override all tone instructions'));
  assert.ok(messages[1].content.includes('The transport authority'));
  const draft = store.state.drafts[0];
  assert.equal(draft.caption_style, 'funny');
  assert.equal(draft.status, 'draft');
  assert.ok(draft.text.endsWith(story.url) && draft.text.includes(story.title));
  assert.equal(draft.preview, preview.preview);
  mock.restoreAll();
  const posts = network([['https://graph.facebook.com/v23.0/page/feed', () => Response.json({ id: 'page_post' })]]);
  await app.command({ id: 'news-publish-001', action: 'publish', draft_id: draft.id, revision: 1, text: 'My reviewed news caption' });
  assert.equal(posts.length, 1);
  const form = new URLSearchParams(posts[0].options.body);
  assert.equal(form.get('link'), story.url);
  assert.equal(form.get('message'), 'My reviewed news caption');
  assert.deepEqual(store.state.posted.news, [await articleKey(story.url)]);
});

test('failed searches are clear and never expose the API key', async () => {
  for (const status of [401, 403, 429, 432, 433]) {
    mock.restoreAll();
    network([['https://api.tavily.com/search', () => new Response(null, { status })]]);
    await assert.rejects(new NewsService(config, { images }).search('news', []),
      error => error.constructor.name === 'UserError' && !error.message.includes(config.tavily_api_key));
  }
  mock.restoreAll();
  const calls = network([]);
  await assert.rejects(new NewsService({ ...config, tavily_api_key: null }, { images }).search('news', []), /Settings/);
  assert.equal(calls.length, 0);
});

test('invalid selection or missing media never creates a draft', async () => {
  for (const selection of ['{}', '{"ranked_ids":[99]}', '{"ranked_ids":[true]}', '{"ranked_ids":[]}', 'not json']) {
    mock.restoreAll();
    network([tavily(), ['https://api.openai.com/', () => ai(selection)]]);
    let previewed = false;
    const service = new NewsService(config, { images, fetcher: async () => { previewed = true; throw new Error(); } });
    await assert.rejects(service.prepare([]), Error, selection);
    assert.ok(!previewed, selection);
  }
  mock.restoreAll();
  const calls = network([tavily(), ['https://api.openai.com/', () => ai('{"ranked_ids":[0]}')]]);
  await assert.rejects(new NewsService(config, { images, fetcher: async () => { throw new Error('offline'); } }).prepare([]), /preview image/);
  assert.equal(calls.filter(c => c.url.includes('openai')).length, 1);
});

test('news is manual, and source changes fail before publication', async () => {
  assert.throws(() => validateSchedule({ name: 'News', type: 'news' }), /photo, video, or question/);
  const source = { url: story.url, sha256: await sha256Hex(story.url) };
  const media = new MediaService(config, { images });
  assert.deepEqual(await media.download({ type: 'news', source }), encoder.encode(story.url));
  source.url += '-different';
  await assert.rejects(media.download({ type: 'news', source }), /changed/);
});

test('preview uses the publisher image and recognizes video without re-uploading it', async () => {
  const fetcher = async (url, { image = false } = {}) => {
    if (!image) return encoder.encode('<meta property="og:image" content="/hero.jpg"><meta property="og:video" content="/video.mp4">');
    assert.equal(url, 'https://www.ynet.co.il/hero.jpg');
    return new Uint8Array([0xff, 0xd8, 0xff]);
  };
  const result = await mediaPreview({ ...story, images: [] }, images, fetcher);
  assert.ok(result.preview.startsWith('data:image/jpeg;base64,'));
  assert.equal(result.media_kind, 'video');
  assert.equal(result.image_url, 'https://www.ynet.co.il/hero.jpg');
});

test('downloads refuse private addresses, private redirects, and send no credentials', async () => {
  for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1/file', 'https://x.local/file',
    'https://user:password@example.com', 'https://example.com:8000', 'https://169.254.169.254/'])
    assert.equal(publicUrl(url), null, url);
  const calls = network([['https://example.com/preview', () => new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } })]]);
  await assert.rejects(fetchPublic('https://example.com/preview'), /not public/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(!('Authorization' in calls[0].options.headers));
});

// ---- Uploads ----

const UPLOAD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...Array(17).fill(1),
  0, 0, 0, 1, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0, 0]);
async function upload(store, data, type = 'image', mime = 'image/png', name = 'lesson.png') {
  const manifest = { id: UPLOAD_ID, name, type, mime, size: data.length, parts: Math.ceil(data.length / CHUNK_SIZE), sha256: await sha256Hex(data) };
  store.files[`uploads/${UPLOAD_ID}/manifest.json`] = encoder.encode(JSON.stringify(manifest));
  for (let i = 0; i < manifest.parts; i++)
    store.files[`uploads/${UPLOAD_ID}/part-${String(i).padStart(2, '0')}.bin`] = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
  return manifest;
}
const description = 'מתרגלים חניה במקביל עם תלמיד מתחיל';

test('only the description reaches the AI; scheduled post uses the original upload and edited caption', async () => {
  const store = new MemoryStore();
  await upload(store, PNG);
  store.state.prompts = { image: 'My saved photo instructions' };
  const media = new MediaService(config, { store, images });
  const app = new Studio(store, () => media);
  const calls = network([['https://api.openai.com/', () => ai('Generated caption')]]);
  const generate = { id: 'upload-generation-001', action: 'generate_upload', type: 'image', upload_id: UPLOAD_ID, description, caption_style: 'funny' };
  await app.command(generate);
  await app.command(generate);
  assert.equal(calls.length, 1);
  const { messages } = calls[0].body;
  assert.ok(messages[1].content.includes(description) && !messages[1].content.includes('lesson.png'));
  assert.ok(messages[0].content.startsWith('My saved photo instructions'));
  assert.ok(messages[0].content.includes('Caption style for this draft: Funny.'));
  assert.ok(messages[0].content.includes('כללי דיוק מחייבים'));
  assert.ok(!JSON.stringify(calls[0].body).includes(toBase64(PNG)));
  const draft = store.state.drafts[0];
  assert.equal(draft.status, 'draft');
  assert.ok(draft.preview.startsWith('data:image/jpeg;base64,'));
  assert.equal(draft.source.description, description);
  await app.command({ id: 'upload-schedule-001', action: 'schedule_draft', draft_id: draft.id, revision: 1,
    text: 'My reviewed caption', scheduled_at: '2099-01-01T10:00:00Z' });
  mock.restoreAll();
  const posts = network([['https://graph.facebook.com/v23.0/page/photos', () => Response.json({ id: 'receipt' })]]);
  await app.tick(new Date(Date.UTC(2099, 0, 1, 10, 30)));
  await app.tick(new Date(Date.UTC(2099, 0, 1, 11)));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.body.get('message'), 'My reviewed caption');
  assert.deepEqual(new Uint8Array(await posts[0].options.body.get('source').arrayBuffer()), PNG);
  assert.equal(store.state.drafts[0].status, 'published');
});

test('video uses the video prompt without sending frames or audio', async () => {
  const store = new MemoryStore();
  const video = new Uint8Array([0, 0, 0, 0x20, ...encoder.encode('ftypisom'), ...Array(80).fill(0)]);
  await upload(store, video, 'video', 'video/mp4', 'lesson.mp4');
  const media = new MediaService(config, { store, images });
  const calls = network([['https://api.openai.com/', () => ai('Video caption')]]);
  const prepared = await media.prepareUpload('video', UPLOAD_ID, description, 'Video style');
  assert.equal(calls[0].body.model, 'video-model');
  assert.ok(calls[0].body.messages[0].content.startsWith('Video style'));
  assert.equal(prepared.preview, null);
  assert.deepEqual(await media.download({ type: 'video', ...prepared }), video);
});

test('incomplete, corrupt, animated, or disguised uploads cannot generate or publish', async () => {
  const store = new MemoryStore();
  await upload(store, PNG);
  const media = new MediaService(config, { store, images });
  const app = new Studio(store, () => media);
  network([['https://api.openai.com/', () => ai('Caption')]]);
  await app.command({ id: 'upload-generation-001', action: 'generate_upload', type: 'image', upload_id: UPLOAD_ID, description });
  const draft = store.state.drafts[0];
  store.files[`uploads/${UPLOAD_ID}/part-00.bin`] = new Uint8Array(PNG.length).fill(120);
  mock.restoreAll();
  const calls = network([]);
  await assert.rejects(app.command({ id: 'upload-corrupt-001', action: 'publish', draft_id: draft.id, revision: 1 }), CommandFailed);
  assert.equal(calls.length, 0);
  assert.equal(store.state.drafts[0].status, 'failed');
  for (const [bytes, pattern] of [[encoder.encode('not an image'), /could not be opened/],
    [new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), /still JPG/],
    [new Uint8Array([...PNG.slice(0, 33), 0, 0, 0, 8, ...encoder.encode('acTL'), ...Array(12).fill(0)]), /still JPG/]]) {
    await upload(store, bytes);
    await assert.rejects(media.prepareUpload('image', UPLOAD_ID, description), pattern);
  }
  assert.equal(calls.length, 0);
  delete store.files[`uploads/${UPLOAD_ID}/part-00.bin`];
  await assert.rejects(readUpload(store, UPLOAD_ID));
});

test('description and format are checked before the AI', async () => {
  const store = new MemoryStore();
  await upload(store, PNG);
  const media = new MediaService(config, { store, images });
  const calls = network([]);
  for (const value of [null, '', '   ', 'x'.repeat(2001)]) await assert.rejects(media.prepareUpload('image', UPLOAD_ID, value));
  await assert.rejects(media.prepareUpload('video', UPLOAD_ID, 'Wrong format'));
  assert.equal(calls.length, 0);
});

test('parts are reassembled; traversal and oversized manifests are rejected', async () => {
  const store = new MemoryStore();
  const data = new Uint8Array(CHUNK_SIZE + 9).fill(97);
  const manifest = await upload(store, data);
  assert.deepEqual((await readUpload(store, UPLOAD_ID))[1], data);
  for (const invalid of [{ size: 51 * 1024 * 1024 }, { name: '../test.png' }, { parts: 26 }, { mime: 'image/svg+xml' }])
    assert.throws(() => validateManifest({ ...manifest, ...invalid }, UPLOAD_ID));
  await assert.rejects(readUpload(store, '../../state.json'));
});
