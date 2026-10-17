// JavaScript port of tests/test_studio.py: both servers must behave the same.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../server/store.js';
import { Studio, CommandFailed } from '../../server/service.js';
import { captureMissed } from '../../server/missed.js';
import { dueSlot, parseFuture, validateSchedule } from '../../server/scheduler.js';
import { questionText } from '../../server/content.js';
import { MediaService } from '../../server/media.js';
import { sha256Hex, clone, encoder } from '../../server/util.js';

const utc = (...args) => new Date(Date.UTC(args[0], args[1] - 1, ...args.slice(2)));
const ORIGINAL = encoder.encode('original');

class FakeMedia {
  constructor() { Object.assign(this, { posts: [], fail: false, changed: false, ready: false, prepareError: null }); }
  async prepare(kind, used, prompt) {
    if (this.prepareError) return this.prepareError();
    this.last_prompt = prompt;
    return { text: 'Original caption', source: { key: `${kind}-source`, name: 'A source', sha256: await sha256Hex(ORIGINAL) }, preview: 'sample' };
  }
  async download() { if (this.changed) throw new Error('Source changed'); return ORIGINAL; }
  async publish(draft, data) {
    this.posts.push([clone(draft), data]);
    if (this.fail) throw new Error('Ambiguous result');
    return { id: '12345', post_id: draft.type === 'video' ? null : 'page_12345' };
  }
  async videoStatus(id) {
    return { status: { publishing_phase: { publish_status: this.ready ? 'published' : 'pending' } }, permalink_url: `/reel/${id}/` };
  }
}

let store, media, app, clock;
beforeEach(() => {
  store = new MemoryStore();
  media = new FakeMedia();
  clock = { now: new Date() };
  app = new Studio(store, () => media, { clock: () => clock.now });
});

async function generate(kind = 'image', id = 'generate-001') {
  await app.command({ action: 'generate', type: kind, id });
  return store.state.drafts[0];
}
const publish = (draft, id = 'publish-001', extra = {}) =>
  app.command({ id, action: 'publish', draft_id: draft.id, revision: draft.revision, ...extra });
const rejects = (promise, pattern) => assert.rejects(promise, error => error instanceof CommandFailed && (!pattern || pattern.test(error.message)));

test('preview creates a draft without publishing or marking history', async () => {
  const d = await generate();
  assert.equal(d.status, 'draft');
  assert.deepEqual(media.posts, []);
  assert.deepEqual(store.state.posted.image, []);
});

test('all three formats generate', async () => {
  for (const kind of ['image', 'video', 'question']) assert.equal((await generate(kind, `generate-${kind}`)).type, kind);
});

test('saved prompts are independent and only change future generation', async () => {
  const existing = clone(await generate());
  for (const kind of ['image', 'video', 'question']) {
    const prompt = `Custom ${kind} instructions בעברית`;
    await app.command({ id: `save-prompt-${kind}`, action: 'save_prompt', type: kind, prompt, revision: 0 });
    await generate(kind, `custom-${kind}`);
    assert.equal(media.last_prompt, prompt);
  }
  assert.deepEqual(store.state.drafts.find(d => d.id === existing.id), existing);
  assert.deepEqual(store.state.prompt_revisions, { image: 1, video: 1, question: 1 });
});

test('stale prompt edit is rejected without overwriting saved instructions', async () => {
  await app.command({ id: 'prompt-save-1', action: 'save_prompt', type: 'image', prompt: 'First save', revision: 0 });
  await rejects(app.command({ id: 'prompt-save-2', action: 'save_prompt', type: 'image', prompt: 'Stale save', revision: 0 }), /another session/);
  assert.equal(store.state.prompts.image, 'First save');
});

test('news prompt stages have independent revisions', async () => {
  for (const kind of ['news', 'news_selection'])
    await app.command({ id: `save-stage-${kind}`, action: 'save_prompt', type: kind, prompt: `Custom ${kind}`, revision: 0 });
  await rejects(app.command({ id: 'stale-news', action: 'save_prompt', type: 'news_selection', prompt: 'Stale', revision: 0 }), /another session/);
  assert.deepEqual(store.state.prompt_revisions, { news: 1, news_selection: 1 });
  assert.deepEqual(store.state.prompts, { news: 'Custom news', news_selection: 'Custom news_selection' });
});

test('bad prompt settings do not save or require provider credentials', async () => {
  const strict = new Studio(store, () => assert.fail('Saving prompts must not initialize provider clients'));
  for (const [i, prompt] of [null, 123, '  ', 'x'.repeat(8001)].entries())
    await rejects(strict.command({ id: `invalid-prompt-${i}`, action: 'save_prompt', type: 'image', prompt, revision: 0 }));
  assert.ok(!('prompts' in store.state));
  await strict.command({ id: 'valid-prompt-1', action: 'save_prompt', type: 'video', prompt: '  Write clearly.  ', revision: 0 });
  assert.equal(store.state.prompts.video, 'Write clearly.');
});

test('recurring generation uses latest saved prompt', async () => {
  store.state.schedules = [{ id: 'scheduled-prompt', name: 'Morning', type: 'image', mode: 'draft', days: [4], time: '09:00', timezone: 'Asia/Jerusalem', enabled: true }];
  await app.command({ id: 'scheduled-prompt-save', action: 'save_prompt', type: 'image', prompt: 'Scheduled instructions', revision: 0 });
  await app.command({ id: 'manual-funny-draft', action: 'generate', type: 'image', caption_style: 'funny' });
  assert.match(media.last_prompt, /Funny/);
  await app.tick(utc(2026, 10, 2, 6, 37));
  assert.equal(media.last_prompt, 'Scheduled instructions');
  assert.equal(store.state.drafts[0].caption_style, 'default');
  assert.deepEqual(media.posts, []);
});

test('publish uses edited caption and same source', async () => {
  const d = await generate();
  await publish(d, 'publish-001', { text: 'My edited Hebrew caption שלום' });
  const [sent, data] = media.posts[0];
  assert.equal(sent.text, 'My edited Hebrew caption שלום');
  assert.deepEqual(sent.source, d.source);
  assert.deepEqual(data, ORIGINAL);
  assert.deepEqual(store.state.posted.image, ['image-source']);
  assert.equal(store.state.drafts[0].preview, d.preview);
  assert.equal(store.state.drafts[0].facebook_url, 'https://www.facebook.com/page_12345');
});

test('replayed request does not publish twice; a new request cannot republish', async () => {
  const d = await generate();
  await publish(d);
  await publish(d);
  assert.equal(media.posts.length, 1);
  await rejects(publish(d, 'publish-002'));
  assert.equal(media.posts.length, 1);
});

test('stale edits and empty captions are rejected', async () => {
  const d = await generate();
  await app.command({ id: 'save-00001', action: 'save_draft', draft_id: d.id, revision: 1, text: 'Changed' });
  await rejects(publish(d), /changed in another session/);
  await rejects(publish(store.state.drafts[0], 'publish-empty', { text: '  ' }), /1–12,000/);
  assert.deepEqual(media.posts, []);
});

test('timeout is uncertain and never retried', async () => {
  const d = await generate();
  media.fail = true;
  await rejects(publish(d), /The operation failed/);
  assert.equal(store.state.drafts[0].status, 'uncertain');
  await rejects(publish(store.state.drafts[0], 'retry-00001'));
  assert.equal(media.posts.length, 1);
});

test('source change fails before the Facebook call', async () => {
  const d = await generate();
  media.changed = true;
  await rejects(publish(d));
  assert.deepEqual(media.posts, []);
  assert.equal(store.state.drafts[0].status, 'failed');
});

test('media checksum verification', async () => {
  const service = new MediaService({}, { google: { download: async () => encoder.encode('changed') } });
  const draft = { type: 'image', source: { id: 'source', sha256: await sha256Hex(encoder.encode('old')) } };
  await assert.rejects(service.download(draft), /changed after preview/);
});

test('video status is not published until confirmed', async () => {
  const d = await generate('video');
  await publish(d);
  assert.equal(store.state.drafts[0].status, 'processing');
  media.ready = true;
  await app.refreshVideos();
  assert.equal(store.state.drafts[0].status, 'published');
  assert.equal(store.state.drafts[0].facebook_url, 'https://www.facebook.com/reel/12345/');
});

test('one-time schedule survives ticks and publishes once', async () => {
  const d = await generate();
  await app.command({ id: 'schedule-001', action: 'schedule_draft', draft_id: d.id, revision: 1,
    scheduled_at: '2099-01-05T07:00:00+00:00', text: 'Scheduled caption' });
  await app.tick(utc(2099, 1, 5, 7, 30));
  await app.tick(utc(2099, 1, 5, 8, 0));
  assert.equal(media.posts.length, 1);
  assert.equal(media.posts[0][0].text, 'Scheduled caption');
});

test('cancel schedule returns post to drafts', async () => {
  const d = await generate();
  await app.command({ id: 'schedule-001', action: 'schedule_draft', draft_id: d.id, revision: 1, scheduled_at: '2099-01-05T07:00:00+00:00' });
  await app.command({ id: 'cancel-00001', action: 'cancel_draft', draft_id: d.id, revision: 2 });
  await app.tick(utc(2099, 1, 5, 7, 30));
  assert.deepEqual(media.posts, []);
  assert.equal(store.state.drafts[0].status, 'draft');
});

test('saving caption preserves scheduled publication', async () => {
  const d = await generate();
  const date = '2099-01-05T07:00:00+00:00';
  await app.command({ id: 'schedule-001', action: 'schedule_draft', draft_id: d.id, revision: 1, scheduled_at: date });
  await app.command({ id: 'save-edit-001', action: 'save_draft', draft_id: d.id, revision: 2, text: 'Updated caption' });
  const saved = store.state.drafts[0];
  assert.deepEqual([saved.status, saved.scheduled_at], ['scheduled', date]);
  await app.tick(utc(2099, 1, 5, 7, 30));
  assert.equal(media.posts[0][0].text, 'Updated caption');
});

test('recurring schedule only claims a slot once; draft schedules never publish', async () => {
  store.state.schedules = [{ id: 'schedule-one', name: 'Morning', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Jerusalem', type: 'question', mode: 'publish', enabled: true }];
  await app.tick(utc(2026, 10, 2, 6, 10));
  await app.tick(utc(2026, 10, 2, 6, 40));
  assert.equal(media.posts.length, 1);
  assert.equal(media.posts[0][0].type, 'question');
  store.state = new MemoryStore().state;
  media.posts = [];
  store.state.schedules = [{ id: 'schedule-one', name: 'Morning', time: '09:00', days: [4], timezone: 'Asia/Jerusalem', type: 'video', mode: 'draft', enabled: true }];
  await app.tick(utc(2026, 10, 2, 6, 10));
  assert.equal(store.state.drafts.length, 1);
  assert.deepEqual(media.posts, []);
});

function saturdaySchedule(extra = {}) {
  const schedule = { id: 'saturday-1010', name: 'sat', time: '10:10', days: [5], timezone: 'Asia/Jerusalem', type: 'image',
    mode: 'publish', enabled: true, starts_at: '2026-10-03T07:06:46+00:00', ...extra };
  store.state.schedules = [schedule];
  return schedule;
}

test('delayed check catches up a Saturday post once', async () => {
  saturdaySchedule();
  await app.tick(utc(2026, 10, 3, 10, 19));
  assert.equal(media.posts.length, 1);
  assert.equal(media.posts[0][0].schedule_id, 'saturday-1010');
  assert.equal(store.state.schedules[0].last_status, 'published');
  assert.ok('last_finished_at' in store.state.scheduler);
});

test('delayed draft-only schedule still requires review', async () => {
  saturdaySchedule({ mode: 'draft' });
  await app.tick(utc(2026, 10, 3, 10, 19));
  assert.equal(store.state.drafts.length, 1);
  assert.deepEqual(media.posts, []);
  assert.equal(store.state.schedules[0].last_status, 'draft');
});

test('expired recurring run is reported once without publishing', async () => {
  saturdaySchedule();
  await app.tick(utc(2026, 10, 4, 7, 11));
  assert.deepEqual(media.posts, []);
  const issues = store.state.operations.filter(op => op.action === 'missed_schedule');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].slot, '2026-10-03@10:10');
  assert.match(issues[0].error, /Needs attention/);
});

test('long outage only publishes the latest daily slot', async () => {
  saturdaySchedule({ days: [0, 1, 2, 3, 4, 5, 6] });
  await app.tick(utc(2026, 10, 6, 7, 30));
  assert.equal(media.posts.length, 1);
  const schedule = store.state.schedules[0];
  assert.equal(schedule.last_slot, '2026-10-06@10:10');
  assert.equal(schedule.last_missed_slot, '2026-10-05@10:10');
});

test('failed catch-up is visible and ambiguous posts are not retried', async () => {
  saturdaySchedule();
  media.fail = true;
  await app.tick(utc(2026, 10, 3, 10, 19));
  assert.equal(media.posts.length, 1);
  assert.equal(store.state.schedules[0].last_status, 'uncertain');
  assert.ok(store.state.schedules[0].last_error);
});

test('paused or resumed schedule does not catch up old slots', async () => {
  for (const extra of [{ enabled: false }, { starts_at: '2026-10-03T11:00:00+00:00' }]) {
    saturdaySchedule(extra);
    await app.tick(utc(2026, 10, 3, 11, 30));
  }
  assert.deepEqual(media.posts, []);
  assert.ok(!store.state.operations.some(op => op.action === 'missed_schedule'));
});

test('manual check runs due saved and recurring posts once', async () => {
  clock.now = utc(2026, 10, 3, 10, 19);
  saturdaySchedule();
  const saved = await generate();
  Object.assign(store.state.drafts[0], { status: 'scheduled', scheduled_at: '2026-10-03T07:00:00+00:00', text: 'Reviewed caption' });
  const future = await generate('image', 'future-post');
  Object.assign(store.state.drafts[0], { status: 'scheduled', scheduled_at: '2026-10-04T07:00:00+00:00' });
  await generate('image', 'unscheduled-draft');
  await app.command({ id: 'manual-run-001', action: 'run_due' });
  await app.command({ id: 'manual-run-002', action: 'run_due' });
  await app.tick(clock.now);
  assert.equal(media.posts.length, 2);
  assert.equal(media.posts.find(([d]) => d.id === saved.id)[0].text, 'Reviewed caption');
  assert.equal(store.state.drafts.find(d => d.id === future.id).status, 'scheduled');
  assert.equal(store.state.drafts.find(d => d.id === 'unscheduled-draft').status, 'draft');
  assert.equal(store.state.operations.find(op => op.id === 'manual-run-001').status, 'complete');
});

test('manual check respects draft-only, paused, and expired schedules', async () => {
  clock.now = utc(2026, 10, 3, 10, 19);
  const original = saturdaySchedule({ mode: 'draft' });
  store.state.schedules.push({ ...original, id: 'paused-run', enabled: false },
    { ...original, id: 'expired-run', days: [4], starts_at: '2026-10-01T00:00:00+00:00' });
  await app.command({ id: 'manual-modes-001', action: 'run_due', force: true });
  assert.deepEqual(media.posts, []);
  assert.equal(store.state.drafts.length, 1);
  assert.equal(store.state.drafts[0].status, 'draft');
  assert.ok(store.state.operations.some(op => op.action === 'missed_schedule'));
});

test('manual check failure is recorded', async () => {
  app.tick = async () => { throw new Error('Unavailable'); };
  await rejects(app.command({ id: 'manual-failed-001', action: 'run_due' }));
  assert.equal(store.state.operations[0].status, 'failed');
});

test('missed runs survive operation history and schedule removal', async () => {
  saturdaySchedule();
  await app.tick(utc(2026, 10, 4, 7, 11));
  const missed = clone(store.state.missed_runs[0]);
  store.state.operations = [];
  store.state.schedules = [];
  await app.command({ id: 'recover-missed-001', action: 'recover_missed', missed_id: missed.id });
  await app.command({ id: 'recover-missed-002', action: 'recover_missed', missed_id: missed.id });
  assert.equal(store.state.drafts.length, 1);
  assert.deepEqual(media.posts, []);
  assert.equal(store.state.drafts[0].status, 'draft');
  assert.equal(store.state.missed_runs[0].draft_id, store.state.drafts[0].id);
  await publish(store.state.drafts[0], 'publish-recovery-001');
  assert.equal(store.state.missed_runs[0].status, 'published');
});

test('every expired slot is kept after an outage longer than a week', async () => {
  saturdaySchedule({ days: [0, 1, 2, 3, 4, 5, 6] });
  await app.tick(utc(2026, 10, 20, 7, 30));
  assert.equal(store.state.missed_runs.length, 17);
  assert.equal(new Set(store.state.missed_runs.map(r => r.slot)).size, 17);
  assert.equal(media.posts.length, 1);
  await app.tick(utc(2026, 10, 20, 8, 0));
  assert.equal(store.state.missed_runs.length, 17);
});

test('legacy missed receipt is imported without publishing', async () => {
  saturdaySchedule();
  store.state.schedules[0].last_missed_slot = '2026-10-03@10:10';
  await store.change(state => captureMissed(state, utc(2026, 10, 4, 8)));
  assert.equal(store.state.missed_runs.length, 1);
  assert.deepEqual(media.posts, []);
});

test('previous daily slot is saved at exactly 24 hours', async () => {
  saturdaySchedule({ days: [0, 1, 2, 3, 4, 5, 6] });
  await app.tick(utc(2026, 10, 4, 7, 10));
  assert.deepEqual(store.state.missed_runs.map(r => r.slot), ['2026-10-03@10:10']);
  assert.equal(media.posts.length, 1);
});

test('failed generation survives the next run and history rotation', async () => {
  saturdaySchedule({ days: [0, 1, 2, 3, 4, 5, 6] });
  const { UserError } = await import('../../server/util.js');
  media.prepareError = () => { throw new UserError('Source unavailable'); };
  await app.tick(utc(2026, 10, 3, 8));
  media.prepareError = null;
  const missed = clone(store.state.missed_runs[0]);
  assert.equal(missed.status, 'failed');
  assert.equal(missed.error, 'Source unavailable');
  await app.tick(utc(2026, 10, 4, 8));
  store.state.operations = [];
  store.state.schedules = [];
  await app.command({ id: 'recover-failed-001', action: 'recover_missed', missed_id: missed.id });
  assert.equal(media.posts.length, 1);
  assert.equal(store.state.drafts[0].status, 'draft');
});

test('schedule changes preserve an unclaimed run within the catch-up window', async () => {
  saturdaySchedule();
  clock.now = utc(2026, 10, 3, 8);
  await app.command({ id: 'pause-pending-001', action: 'toggle_schedule', schedule_id: 'saturday-1010', enabled: false });
  assert.deepEqual(store.state.missed_runs.map(r => r.slot), ['2026-10-03@10:10']);
  assert.deepEqual(media.posts, []);
});

test('generation failure is kept if the schedule is deleted during generation', async () => {
  saturdaySchedule();
  media.prepareError = () => { store.state.schedules = []; throw new Error('Source unavailable'); };
  await app.tick(utc(2026, 10, 3, 8));
  assert.equal(store.state.missed_runs[0].status, 'failed');
  assert.deepEqual(media.posts, []);
});

test('unconfirmed recovery cannot publish again', async () => {
  saturdaySchedule();
  await app.tick(utc(2026, 10, 4, 7, 11));
  const key = store.state.missed_runs[0].id;
  await app.command({ id: 'recover-once-001', action: 'recover_missed', missed_id: key });
  store.state.drafts[0].status = 'uncertain';
  await rejects(app.command({ id: 'recover-once-002', action: 'recover_missed', missed_id: key }), /existing post/);
  assert.deepEqual(media.posts, []);
});

test('recovery cannot force a future slot', async () => {
  saturdaySchedule();
  await rejects(app.command({ id: 'recover-future-001', action: 'recover_missed', schedule_id: 'saturday-1010', slot: '2099-10-03@10:10' }), /not available/);
  assert.deepEqual(media.posts, []);
  assert.deepEqual(store.state.drafts, []);
});

// ---- Schedules ----

const morning = () => ({ name: 'Morning', time: '09:00', days: [0, 1, 2, 3, 4], timezone: 'Asia/Jerusalem', type: 'image', mode: 'draft', enabled: true });

test('Israel summer and winter offsets', () => {
  const s = morning();
  s.days = [4];
  assert.ok(dueSlot(s, utc(2026, 10, 2, 6, 10)));
  s.days = [2];
  assert.equal(dueSlot(s, utc(2026, 12, 2, 6, 10)), null);
  assert.ok(dueSlot(s, utc(2026, 12, 2, 7, 10)));
});

test('weekend, disabled, and late runs', () => {
  const s = morning();
  assert.equal(dueSlot(s, utc(2026, 10, 3, 6, 10)), null);
  assert.equal(dueSlot(s, utc(2026, 10, 2, 8, 1)), '2026-10-02@09:00');
  s.enabled = false;
  assert.equal(dueSlot(s, utc(2026, 10, 2, 6, 10)), null);
});

test('catch-up window is inclusive at 24 hours', () => {
  const s = { ...morning(), days: [4] };
  assert.equal(dueSlot(s, utc(2026, 10, 3, 6, 0)), '2026-10-02@09:00');
  assert.equal(dueSlot(s, utc(2026, 10, 3, 6, 0, 1)), null);
});

test('an out-of-order check does not revisit an older slot, or a claimed one', () => {
  const s = { ...morning(), last_slot: '2026-10-02@09:00' };
  assert.equal(dueSlot(s, utc(2026, 10, 1, 7, 0)), null);
  assert.equal(dueSlot(s, utc(2026, 10, 2, 6, 10)), null);
});

test('DST gap is skipped and the repeated hour runs only once', () => {
  const s = { ...morning(), timezone: 'America/New_York', days: [6], time: '02:30' };
  assert.equal(dueSlot(s, utc(2026, 3, 8, 8, 0)), null);
  s.time = '01:30';
  assert.equal(dueSlot(s, utc(2026, 11, 1, 5, 35)), '2026-11-01@01:30');
  s.last_slot = '2026-11-01@01:30';
  assert.equal(dueSlot(s, utc(2026, 11, 1, 6, 35)), null);
});

test('a new schedule does not publish a past slot', () => {
  assert.equal(dueSlot({ ...morning(), starts_at: '2026-10-02T06:05:00+00:00' }, utc(2026, 10, 2, 6, 10)), null);
});

test('late-night slot runs after midnight UTC on the original weekday', () => {
  const s = { ...morning(), time: '23:55', days: [4] };
  assert.equal(dueSlot(s, utc(2026, 10, 2, 21, 7)), '2026-10-02@23:55');
  s.last_slot = '2026-10-02@23:55';
  assert.equal(dueSlot(s, utc(2026, 10, 2, 21, 37)), null);
});

test('invalid weekdays, ambiguous and past one-time dates are rejected', () => {
  assert.throws(() => validateSchedule({ ...morning(), days: [true, 8] }), /weekday/);
  assert.throws(() => validateSchedule({ ...morning(), time: 'x' }), /time data 'x' does not match format '%H:%M'/);
  for (const value of ['2020-01-01T09:00:00Z', '2099-01-01T09:00', 'invalid'])
    assert.throws(() => parseFuture(value, new Date()));
  assert.equal(parseFuture('2099-01-01T09:00:00+02:00', new Date()), '2099-01-01T07:00:00+00:00');
});

test('every original quiz choice is preserved without model rewriting', async () => {
  const question = { form_title: 'Traffic signs', question: { text: 'מה פירוש התמרור?' },
    answers: ['תשובה ראשונה.', 'תשובה שנייה.', 'תשובה שלישית.', 'תשובה רביעית.'] };
  let prompt;
  const text = await questionText({ openai_model_question: 'test-model', timezone: 'Asia/Jerusalem' }, question, null,
    async (config, model, system, user) => { prompt = user; return 'בואו נתרגל יחד.'; });
  assert.ok(text.includes(question.question.text));
  for (const [i, answer] of question.answers.entries()) {
    assert.ok(text.includes(`${i + 1}. ${answer}`));
    assert.equal(text.split(answer).length - 1, 1);
  }
  assert.ok(!prompt.includes(question.answers[0]));
});
