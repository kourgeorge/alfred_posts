// Cloudflare R2 storage with optimistic, atomic state updates.
// Mirrors studio/store.py: one state.json, read → change → write only if unchanged.
import { UserError, clone, decoder, encoder, isoUtc } from './util.js';

const FILE = 'state.json';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Store only when nothing exists at the key yet.
const absent = () => new Headers({ 'If-None-Match': '*' });

export const nowIso = () => isoUtc(new Date());

export function emptyState() {
  return { version: 1, updated_at: nowIso(), drafts: [], schedules: [], operations: [],
    posted: { image: [], video: [], question: [], news: [] } };
}

export class R2Store {
  constructor(bucket, { initialPosted } = {}) {
    this.bucket = bucket;
    this.initialPosted = initialPosted;
  }

  async initialize() {
    if (await this.bucket.head(FILE)) return;
    const state = emptyState();
    // Optional import preserves history from the original command-line workflow.
    if (this.initialPosted) state.posted = JSON.parse(this.initialPosted);
    // Another worker may initialize first; that write wins.
    await this.bucket.put(FILE, JSON.stringify(state), { onlyIf: absent() }).catch(() => null);
  }

  async read() {
    const object = await this.bucket.get(FILE);
    if (!object) return [emptyState(), null];
    return [JSON.parse(await object.text()), object.etag];
  }

  async readRaw() {
    const object = await this.bucket.get(FILE);
    return object ? object.text() : JSON.stringify(emptyState());
  }

  async readFile(path, limit) {
    const object = await this.bucket.get(path);
    if (!object) throw new UserError('The uploaded file is incomplete or unavailable. Upload it again.');
    if (object.size > limit) throw new UserError('The uploaded file is too large.');
    return new Uint8Array(await object.arrayBuffer());
  }

  /** Write a file once; an identical existing file is accepted, a different one is refused. */
  async writeOnce(path, bytes) {
    const saved = await this.bucket.put(path, bytes, { onlyIf: absent() });
    if (saved) return 'saved';
    const existing = await this.bucket.get(path);
    if (!existing) return 'busy';
    const current = new Uint8Array(await existing.arrayBuffer());
    return current.length === bytes.length && current.every((b, i) => b === bytes[i]) ? 'saved' : 'different';
  }

  // mutate must only change state, never make external calls: it may be retried.
  async change(mutate) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const [state, etag] = await this.read();
      const result = await mutate(state);
      state.updated_at = nowIso();
      const options = { httpMetadata: { contentType: 'application/json' },
        onlyIf: etag ? { etagMatches: etag } : absent() };
      if (await this.bucket.put(FILE, JSON.stringify(state), options)) return result;
      await sleep(Math.min(400 * (attempt + 1), 2000));
    }
    throw new Error('State is busy. Please try again after the current operation finishes.');
  }
}

/** Test store; mirrors transaction isolation without network requests. */
export class MemoryStore {
  constructor(state) {
    this.state = state ?? emptyState();
    this.files = {};
  }

  async read() { return [clone(this.state), 'test']; }

  async readRaw() { return JSON.stringify(this.state); }

  async change(mutate) {
    const state = clone(this.state);
    const result = await mutate(state);
    state.updated_at = nowIso();
    this.state = state;
    return result;
  }

  async readFile(path, limit) {
    if (!(path in this.files)) throw new UserError('The uploaded file is incomplete.');
    const data = this.files[path];
    if (data.length > limit) throw new UserError('The uploaded file is too large.');
    return data;
  }

  async writeOnce(path, bytes) {
    if (!(path in this.files)) { this.files[path] = bytes; return 'saved'; }
    const current = this.files[path];
    return current.length === bytes.length && current.every((b, i) => b === bytes[i]) ? 'saved' : 'different';
  }
}

export const json = value => encoder.encode(JSON.stringify(value));
export const parseJson = bytes => JSON.parse(decoder.decode(bytes));
