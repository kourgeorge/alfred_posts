// Commands shared by dashboard requests and the scheduled check. Mirrors studio/service.py.
//
// Every state mutation uses compare-and-swap. A publication is reserved durably
// before sending bytes to Facebook; an ambiguous result is never retried blindly.
//
// On Cloudflare each external call or state change runs as one Workflow step, so a
// restarted run replays finished steps instead of repeating them. Step results
// must stay small (≤1 MiB), so steps return only what the next step needs.
import { captionPrompt } from './content.js';
import { WorkflowError } from './drive.js';
import { captureMissed, findMissed, remember, runId } from './missed.js';
import { fetchModels, saveModel } from './models.js';
import { TYPES, dueSlot, parseFuture, validateSchedule } from './scheduler.js';
import { nowIso } from './store.js';
import { validateDescription, validateId } from './uploads.js';
import { UserError, clone, isInt, isoUtc, parseIso, pyLen, pyStr, pyStrip } from './util.js';

export const POST_TYPES = [...TYPES, 'news'];
export const PROMPT_TYPES = [...POST_TYPES, 'news_selection'];

/** A command that ran and failed; its safe message is already recorded (Python's RuntimeError). */
export class CommandFailed extends Error {}

export function safeError(error) {
  if (error instanceof UserError) return error.message;
  // The Facebook wrapper embeds the provider response in its error. Extract a
  // numeric provider code only, never persist the raw response or authenticated URLs.
  const text = String(error?.message ?? error);
  const match = text.match(/"code"\s*:\s*(\d+)/);
  if (match && text.includes('Facebook')) {
    if (match[1] === '190') return 'Facebook access token is invalid or expired. Update it in Settings.';
    return `Facebook rejected the request (code ${match[1]}). Check page permissions and credentials.`;
  }
  return 'The operation failed. Check credentials and the workflow log, then refresh the dashboard.';
}

export function findDraft(state, draftId) {
  const draft = state.drafts.find(d => d.id === draftId);
  if (!draft) throw new UserError('This draft no longer exists.');
  return draft;
}

export function editDraft(state, command) {
  if (!Object.hasOwn(command, 'draft_id')) throw new Error('KeyError: draft_id');
  const draft = findDraft(state, command.draft_id);
  if (!['draft', 'scheduled', 'failed'].includes(draft.status))
    throw new UserError('This post is already being published or has been published.');
  if (command.revision !== draft.revision) throw new UserError('This draft changed in another session. Refresh before editing.');
  const text = pyStrip(pyStr(Object.hasOwn(command, 'text') ? command.text : draft.text));
  if (!text || pyLen(text) > 12000) throw new UserError('The caption must contain 1–12,000 characters.');
  Object.assign(draft, { text, revision: draft.revision + 1, error: null });
  return draft;
}

const KINDS = { user: UserError, workflow: WorkflowError, failed: CommandFailed };
const kindOf = error => error instanceof UserError ? 'user' : error instanceof WorkflowError ? 'workflow'
  : error instanceof CommandFailed ? 'failed' : 'other';

/**
 * Runs labelled units of work. `impl(name, fn)` is Workflow step.do on Cloudflare
 * and a direct call in tests. Errors cross the step boundary as data, so the
 * dashboard message (UserError vs. generic) survives a replay.
 */
export class Steps {
  constructor(impl = (_, fn) => fn()) { this.impl = impl; this.count = 0; }

  async run(label, fn) {
    const name = `${++this.count}. ${label}`.slice(0, 256);
    const outcome = await this.impl(name, async () => {
      try { return { ok: (await fn()) ?? null }; }
      catch (error) { return { error: { kind: kindOf(error), message: String(error?.message ?? error) } }; }
    });
    if (outcome.error) throw new (KINDS[outcome.error.kind] ?? Error)(outcome.error.message);
    return outcome.ok;
  }
}

export class Studio {
  /**
   * store: R2Store or MemoryStore. mediaFactory: async () => MediaService (built
   * lazily, so commands without provider calls work without credentials).
   * openaiKey: async () => the OpenAI key, for model discovery.
   */
  constructor(store, mediaFactory, { steps = new Steps(), openaiKey = async () => '', clock = () => new Date() } = {}) {
    Object.assign(this, { store, mediaFactory, steps, openaiKey, clock });
    this.mediaPromise = null;
  }

  step(label, fn) { return this.steps.run(label, fn); }

  media() {
    this.mediaPromise ??= Promise.resolve(this.mediaFactory()).catch(error => { this.mediaPromise = null; throw error; });
    return this.mediaPromise;
  }

  async generate(postType, draftId, { scheduleId = null, uploadId = null, description = null, captionStyle = 'default' } = {}) {
    if (!POST_TYPES.includes(postType)) throw new UserError('Unknown post type.');
    const plan = await this.step(`check drafts for ${draftId}`, async () => {
      const [state] = await this.store.read();
      const existing = state.drafts.find(d => d.id === draftId);
      if (existing) return { existing: existing.id };
      if (state.drafts.filter(d => ['draft', 'scheduled', 'failed'].includes(d.status)).length >= 30)
        throw new UserError('You have 30 unfinished drafts. Publish or delete some before creating more.');
      const used = [...(state.posted[postType] ?? []), ...state.drafts
        .filter(d => d.type === postType && d.status !== 'deleted').map(d => d.source.key)];
      const prompt = captionPrompt(postType, state.prompts?.[postType], captionStyle);
      return { used, prompt, selection: state.prompts?.news_selection ?? null };
    });
    if (plan.existing) return plan.existing;
    let prepared;
    if (uploadId) {
      validateId(uploadId);
      description = validateDescription(description);
      if (!['image', 'video'].includes(postType)) throw new UserError('Choose a photo or video for your upload.');
      prepared = await this.step('prepare upload', async () =>
        (await this.media()).prepareUpload(postType, uploadId, description, plan.prompt));
    } else if (postType === 'news') {
      // News runs its search, ranking, previews, and caption as separate steps.
      prepared = await (await this.media()).prepare(postType, plan.used, plan.prompt, plan.selection);
    } else {
      prepared = await this.step(`prepare ${postType}`, async () => (await this.media()).prepare(postType, plan.used, plan.prompt));
    }
    return this.step('save draft', () => this.store.change(state => {
      if (!state.drafts.some(d => d.id === draftId))
        state.drafts.unshift({ id: draftId, type: postType, status: 'draft', revision: 1, created_at: nowIso(),
          schedule_id: scheduleId, caption_style: captionStyle, ...prepared });
      return draftId;
    }));
  }

  /** Save a caption approved in the Telegram bot, then schedule or publish it. */
  async createUploadDraft(command) {
    const { type: postType, id: draftId } = command;
    if (!['image', 'video'].includes(postType)) throw new UserError('Choose a photo or video for your upload.');
    const uploadId = validateId(command.upload_id);
    const text = pyStrip(pyStr(Object.hasOwn(command, 'text') ? command.text : ''));
    if (!text || pyLen(text) > 12000) throw new UserError('The caption must contain 1–12,000 characters.');
    if (command.publish && command.scheduled_at) throw new UserError('Choose either to publish now or a publication time.');
    const { exists, date } = await this.step(`check drafts for ${draftId}`, async () => {
      const date = command.scheduled_at ? parseFuture(command.scheduled_at, this.clock()) : null;
      const [state] = await this.store.read();
      if (state.drafts.some(d => d.id === draftId)) return { exists: true, date };
      if (state.drafts.filter(d => ['draft', 'scheduled', 'failed'].includes(d.status)).length >= 30)
        throw new UserError('You have 30 unfinished drafts. Publish or delete some before creating more.');
      return { exists: false, date };
    });
    if (!exists) {
      const prepared = await this.step('prepare upload', async () =>
        (await this.media()).prepareUploadText(postType, uploadId, text, command.description));
      await this.step('save draft', () => this.store.change(state => {
        if (!state.drafts.some(d => d.id === draftId))
          state.drafts.unshift({ id: draftId, type: postType, status: date ? 'scheduled' : 'draft', revision: 1,
            created_at: nowIso(), schedule_id: null, caption_style: 'default', scheduled_at: date, ...prepared });
      }));
    }
    if (command.publish) await this.publish({ id: `publish-${draftId}`, draft_id: draftId, revision: 1 });
    return draftId;
  }

  async publish(command) {
    const draft = await this.step('reserve publication', () => this.store.change(state => {
      const item = editDraft(state, command);
      Object.assign(item, { status: 'preparing', scheduled_at: null, attempt_id: command.id });
      return clone(item);
    }));
    // Verify, then send, in one step: the media bytes are too large to pass between steps.
    const outcome = await this.step('verify and send to Facebook', async () => {
      const media = await this.media();
      let data;
      // Download and verify before entering the potentially ambiguous API phase.
      try { data = await media.download(draft); }
      catch (error) { return { phase: 'verify', kind: kindOf(error), message: String(error?.message ?? error) }; }
      await this.store.change(state => { findDraft(state, draft.id).status = 'publishing'; });
      try {
        const result = await media.publish(draft, data);
        if (!result?.id) throw new Error('Facebook did not return a post ID.');
        // Include the receipt in the log even if the state write later fails.
        console.log(`Facebook receipt for draft ${draft.id}: ${JSON.stringify(result)}`);
        return { result };
      } catch (error) { return { phase: 'send', kind: kindOf(error), message: String(error?.message ?? error) }; }
    });
    if (outcome.phase === 'verify') {
      await this.step('mark verification failed', () => this.store.change(state => Object.assign(findDraft(state, draft.id), {
        status: 'failed', error: 'Could not verify the source media. Check the original file and generate a fresh draft if it changed.' })));
      throw new (KINDS[outcome.kind] ?? Error)(outcome.message);
    }
    if (outcome.phase === 'send') {
      await this.step('mark result uncertain', () => this.store.change(state => Object.assign(findDraft(state, draft.id), {
        status: 'uncertain', error: 'Facebook did not return a confirmed result. Check the Facebook page before taking any further action. This post will not be retried automatically.' })));
      throw new (KINDS[outcome.kind] ?? Error)(outcome.message);
    }
    const { result } = outcome;
    const url = `https://www.facebook.com/${String(result.post_id || result.id)}`;
    await this.step('record publication', () => this.store.change(state => {
      const item = findDraft(state, draft.id);
      Object.assign(item, { status: item.type === 'video' ? 'processing' : 'published', published_at: nowIso(),
        facebook_id: String(result.id), facebook_url: url });
      for (const missed of state.missed_runs ?? [])
        if (missed.draft_id === item.id) Object.assign(missed, { status: item.status, resolved_at: nowIso() });
      const posted = state.posted[item.type] ??= [];
      if (!posted.includes(item.source.key)) posted.push(item.source.key);
    }));
    if (draft.type === 'video') await this.refreshVideos();
    return draft.id;
  }

  async refreshVideos() {
    const processing = await this.step('find processing videos', async () => {
      const [state] = await this.store.read();
      return state.drafts.filter(d => d.status === 'processing').map(d => ({ id: d.id, facebook_id: d.facebook_id }));
    });
    for (const draft of processing) {
      await this.step(`check video ${draft.id}`, async () => {
        try {
          const result = await (await this.media()).videoStatus(draft.facebook_id);
          const status = result.status ?? {};
          const published = status.publishing_phase?.publish_status === 'published';
          const failed = status.video_status === 'error';
          await this.store.change(state => {
            const item = findDraft(state, draft.id);
            if (published) item.status = 'published';
            else if (failed) Object.assign(item, { status: 'uncertain', error: 'Facebook reported a video processing error. Inspect the Facebook video before retrying.' });
            if (result.permalink_url) {
              const link = result.permalink_url;
              item.facebook_url = link.startsWith('https://www.facebook.com/') ? link : `https://www.facebook.com/${link.replace(/^\/+/, '')}`;
            }
          });
        } catch { /* The upload receipt is already saved. A later check tries again. */ }
      });
    }
  }

  async execute(command) {
    const action = command.action;
    if (action === 'refresh_models') {
      const catalog = await this.step('load models', async () => fetchModels(await this.openaiKey()));
      return this.step('save models', () => this.store.change(state => { state.model_catalog = catalog; }));
    }
    if (action === 'save_model')
      return saveModel(this.store, command, await this.step('read key', () => this.openaiKey()), (label, fn) => this.step(label, fn));
    if (action === 'run_due') {
      // Use the same eligibility checks and reservations as the scheduled check.
      await this.tick();
      return null;
    }
    if (action === 'recover_missed') {
      const found = await this.step('find missed run', async () => {
        const now = this.clock();
        await this.store.change(state => captureMissed(state, now));
        const [state] = await this.store.read();
        const missed = command.missed_id ? findMissed(state, command.missed_id)
          : (state.missed_runs ?? []).find(r => r.schedule_id === command.schedule_id && r.slot === command.slot);
        if (!missed) throw new UserError('This missed run is not available. Refresh Activity and try again.');
        const draftId = missed.draft_id || missed.id;
        const draft = state.drafts.find(d => d.id === draftId);
        if (draft && ['preparing', 'publishing', 'uncertain', 'deleted'].includes(draft.status))
          throw new UserError('Review the existing post in Activity before recovering this run.');
        return { missed: { id: missed.id, type: missed.type, schedule_id: missed.schedule_id }, draftId, exists: Boolean(draft) };
      });
      if (!found.exists) await this.generate(found.missed.type, found.draftId, { scheduleId: found.missed.schedule_id });
      await this.step('link recovered draft', () => this.store.change(state => {
        const item = findMissed(state, found.missed.id);
        const draft = findDraft(state, found.draftId);
        Object.assign(item, { status: draft.status, draft_id: found.draftId });
        draft.missed_run_id = found.missed.id;
      }));
      return found.draftId;
    }
    if (action === 'save_prompt') {
      const { type: kind, prompt } = command;
      if (!PROMPT_TYPES.includes(kind)) throw new UserError('Unknown post type.');
      if (typeof prompt !== 'string' || pyLen(pyStrip(prompt)) < 1 || pyLen(pyStrip(prompt)) > 8000)
        throw new UserError('The prompt must contain 1–8,000 characters.');
      return this.step('save prompt', () => this.store.change(state => {
        const revisions = state.prompt_revisions ??= {};
        if (!isInt(command.revision) || command.revision !== (revisions[kind] ?? 0))
          throw new UserError('This prompt changed in another session. Discard your changes to load the saved prompt before editing again.');
        (state.prompts ??= {})[kind] = pyStrip(prompt);
        revisions[kind] = (revisions[kind] ?? 0) + 1;
      }));
    }
    if (action === 'generate')
      return this.generate(command.type, command.id, { scheduleId: command.schedule_id ?? null,
        captionStyle: Object.hasOwn(command, 'caption_style') ? command.caption_style : 'default' });
    if (action === 'generate_upload') {
      validateId(command.upload_id);
      return this.generate(command.type, command.id, { uploadId: command.upload_id, description: command.description ?? null,
        captionStyle: Object.hasOwn(command, 'caption_style') ? command.caption_style : 'default' });
    }
    if (action === 'create_upload_draft') return this.createUploadDraft(command);
    if (action === 'publish') return this.publish(command);
    if (['save_draft', 'schedule_draft', 'cancel_draft'].includes(action)) {
      return this.step(action.replace('_', ' '), () => {
        const date = action === 'schedule_draft' ? parseFuture(command.scheduled_at, this.clock()) : null;
        return this.store.change(state => {
          const draft = editDraft(state, command);
          if (action === 'schedule_draft') Object.assign(draft, { status: 'scheduled', scheduled_at: date });
          else if (action === 'cancel_draft' || draft.status === 'failed') Object.assign(draft, { status: 'draft', scheduled_at: null });
          return draft.id;
        });
      });
    }
    if (action === 'delete_draft')
      return this.step('delete draft', () => this.store.change(state => {
        Object.assign(editDraft(state, command), { status: 'deleted', preview: null, scheduled_at: null });
      }));
    if (action === 'save_schedule') {
      const value = validateSchedule(command.schedule ?? {});
      return this.step('save schedule', () => {
        const now = this.clock();
        return this.store.change(async state => {
          const scheduleId = command.schedule_id || command.id;
          const existing = state.schedules.find(s => s.id === scheduleId);
          if (existing) {
            await captureMissed(state, now, { onlySchedule: existing, retiring: true });
            Object.assign(existing, value, { starts_at: isoUtc(now) });
          } else {
            if (state.schedules.length >= 12) throw new UserError('A maximum of 12 recurring schedules is supported.');
            state.schedules.push({ id: scheduleId, created_at: isoUtc(now), starts_at: isoUtc(now), ...value });
          }
          return scheduleId;
        });
      });
    }
    if (['toggle_schedule', 'delete_schedule'].includes(action)) {
      return this.step(action.replace('_', ' '), () => {
        const now = this.clock();
        return this.store.change(async state => {
          const item = state.schedules.find(s => s.id === command.schedule_id);
          if (!item) throw new UserError('This schedule no longer exists.');
          await captureMissed(state, now, { onlySchedule: item, retiring: true });
          if (action === 'delete_schedule') state.schedules.splice(state.schedules.indexOf(item), 1);
          else {
            if (!Object.hasOwn(command, 'enabled')) throw new Error('KeyError: enabled');
            item.enabled = Boolean(command.enabled);
            item.starts_at = isoUtc(now);
          }
        });
      });
    }
    if (action === 'refresh') {
      await this.step('find missed runs', () => { const now = this.clock(); return this.store.change(state => captureMissed(state, now)); });
      await this.refreshVideos();
      return null;
    }
    throw new UserError('Unknown command.');
  }

  async command(command) {
    const requestId = command.id ?? '';
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 150)
      throw new UserError('A unique request ID is required.');
    const claimed = await this.step(`claim ${command.action}`, () => this.store.change(state => {
      if (state.operations.some(op => op.id === requestId)) return false;
      state.operations.unshift({ id: requestId, action: command.action ?? null, status: 'running', created_at: nowIso() });
      state.operations = state.operations.slice(0, 150);
      return true;
    }));
    if (!claimed) return null;
    const finish = (status, extra) => this.step(`finish ${command.action}`, () => this.store.change(state => {
      Object.assign(state.operations.find(op => op.id === requestId), { status, finished_at: nowIso(), ...extra });
    }));
    let result;
    try {
      result = await this.execute(command);
    } catch (error) {
      // Avoid persisting raw provider responses or URLs containing credentials.
      const message = safeError(error);
      await finish('failed', { error: message });
      console.log(`Operation failed (${error?.constructor?.name ?? 'Error'}). Provider response omitted to protect credentials.`);
      throw new CommandFailed(message);
    }
    await finish('complete', { result: result ?? null });
    return result;
  }

  async tick(now) {
    now ??= new Date(await this.step('read clock', () => this.clock().getTime()));
    await this.step('start check', () => this.store.change(state => { (state.scheduler ??= {}).last_started_at = isoUtc(now); }));
    await this.step('find missed runs', () => this.store.change(state => captureMissed(state, now)));
    await this.refreshVideos();
    const due = await this.step('find due posts', async () => {
      const [state] = await this.store.read();
      return { drafts: state.drafts.filter(d => d.status === 'scheduled' && parseIso(d.scheduled_at).date <= now)
        .map(d => ({ id: d.id, revision: d.revision })), schedules: clone(state.schedules) };
    });
    for (const item of due.drafts) {
      try {
        await this.command({ id: `scheduled-${item.id}-${item.revision}`, action: 'publish', draft_id: item.id, revision: item.revision });
      } catch (error) { if (!(error instanceof CommandFailed)) throw error; }
    }
    for (let schedule of due.schedules) {
      const slot = dueSlot(schedule, now);
      if (!slot) continue;
      const draftId = await runId(schedule.id, slot);
      const reserved = await this.step(`reserve ${schedule.id} ${slot}`, () => this.store.change(state => {
        const latest = state.schedules.find(s => s.id === schedule.id);
        if (!latest || dueSlot(latest, now) !== slot) return false;
        Object.assign(latest, { last_slot: slot, last_run: isoUtc(now), last_draft_id: draftId, last_status: 'running', last_error: null });
        return clone(latest);
      }));
      if (!reserved) continue;
      schedule = reserved;
      const finishRun = error => this.step(`finish ${schedule.id} ${slot}`, () => this.store.change(async state => {
        const draft = state.drafts.find(d => d.id === draftId);
        if (error && !draft) Object.assign(await remember(state, schedule, slot, now), { status: 'failed', error });
        const latest = state.schedules.find(s => s.id === schedule.id);
        if (!latest || latest.last_slot !== slot) return;
        Object.assign(latest, { last_status: draft ? draft.status : 'failed', last_error: error ?? null });
      }));
      try {
        await this.command({ id: draftId, action: 'generate', type: schedule.type, schedule_id: schedule.id });
        if (schedule.mode === 'publish')
          await this.command({ id: `publish-${draftId}`, action: 'publish', draft_id: draftId, revision: 1 });
      } catch (error) {
        if (!(error instanceof CommandFailed)) throw error;
        await finishRun(error.message);
        continue;
      }
      await finishRun(null);
    }
    await this.step('finish check', () => this.store.change(state => { (state.scheduler ??= {}).last_finished_at = nowIso(); }));
  }
}
