// Checks the Cloudflare (JavaScript) worker against the Python worker's answers
// in tests/parity/cases.json (verified on the Python side by tests/test_parity.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { articleKey, publicUrl } from '../../server/news.js';
import { dueSlot, recentSlots, validateSchedule } from '../../server/scheduler.js';
import { safeError } from '../../server/service.js';
import { captionPrompt } from '../../server/content.js';
import { isoUtc, parseIso } from '../../server/util.js';

const CASES = JSON.parse(readFileSync(new URL('../parity/cases.json', import.meta.url), 'utf8'));

test('public URLs and article keys match Python', async () => {
  for (const c of CASES.urls) {
    assert.equal(publicUrl(c.url), c.public_url, c.url);
    if (c.public_url) assert.equal(await articleKey(c.public_url), c.article_key, c.url);
  }
});

test('schedule slots and due slots match Python, including daylight-saving changes', () => {
  for (const c of CASES.schedules) {
    const now = parseIso(c.now).date;
    assert.equal(dueSlot(c.schedule, now), c.due_slot, JSON.stringify(c));
    assert.deepEqual(recentSlots(c.schedule, now, 9).map(([slot, t]) => [slot, isoUtc(t)]), c.slots, JSON.stringify(c));
  }
});

test('schedule validation messages match Python', () => {
  for (const c of CASES.validate_schedule) {
    if ('error' in c) assert.throws(() => validateSchedule(c.input), error => error.message === c.error, JSON.stringify(c));
    else assert.deepEqual(validateSchedule(c.input), c.value);
  }
});

test('caption styles and safe error messages match Python', () => {
  for (const c of CASES.caption_prompt) assert.equal(captionPrompt(c.type, c.prompt, c.style), c.result);
  for (const c of CASES.safe_error) assert.equal(safeError(new Error(c.message)), c.result);
});
