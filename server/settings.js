// Provider credentials for the Cloudflare server, and the non-secret settings snapshot.
// GitHub keeps these in Actions secrets; Cloudflare keeps them encrypted (AES-GCM) in R2,
// with the key in the Worker secret CREDENTIALS_KEY. Values are never returned to browsers.
import { decoder, encoder, fromBase64, isoUtc, toBase64 } from './util.js';

export const SECRET_NAMES = ['FB_PAGE_ACCESS_TOKEN', 'FB_PAGE_ID', 'OPENAI_API_KEY', 'TAVILY_API_KEY',
  'OPENAI_MODEL', 'OPENAI_MODEL_VIDEO', 'OPENAI_MODEL_QUESTION',
  'GOOGLE_SERVICE_ACCOUNT_JSON', 'DRIVE_FOLDER_ID', 'DRIVE_FOLDER_ID_VIDEO', 'DRIVE_FOLDER_ID_QUESTIONS'];
export const VISIBLE_SETTINGS = ['FB_PAGE_ID', 'DRIVE_FOLDER_ID', 'DRIVE_FOLDER_ID_VIDEO', 'DRIVE_FOLDER_ID_QUESTIONS',
  'OPENAI_MODEL', 'OPENAI_MODEL_VIDEO', 'OPENAI_MODEL_QUESTION'];
// Settings that can only be set as Worker variables, like the GitHub-only secrets.
const ENV_ONLY = ['GOOGLE_API_KEY', 'FB_GRAPH_VERSION', 'TIMEZONE', 'INITIAL_POSTED_HISTORY'];
const FILE = 'secrets.json';

async function key(env) {
  if (!env.CREDENTIALS_KEY || env.CREDENTIALS_KEY.length < 32) throw new Error('CREDENTIALS_KEY is not configured.');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(env.CREDENTIALS_KEY));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export class SecretStore {
  constructor(bucket, env) { this.bucket = bucket; this.env = env; }

  async read() {
    const object = await this.bucket.get(FILE);
    if (!object) return [{}, null];
    const { iv, data } = await object.json();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await key(this.env), fromBase64(data));
    return [JSON.parse(decoder.decode(plain)), object.etag];
  }

  async names() {
    const [values] = await this.read();
    return SECRET_NAMES.filter(name => values[name] || this.env[name]);
  }

  async set(name, value) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const [values, etag] = await this.read();
      values[name] = value;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(this.env), encoder.encode(JSON.stringify(values)));
      const body = JSON.stringify({ iv: toBase64(iv), data: toBase64(new Uint8Array(data)) });
      const onlyIf = etag ? { etagMatches: etag } : new Headers({ 'If-None-Match': '*' });
      if (await this.bucket.put(FILE, body, { onlyIf })) return;
    }
    throw new Error('Settings are busy. Try again.');
  }

  /** Saved values first, then Worker variables of the same name. */
  async values() {
    const [saved] = await this.read();
    const values = {};
    for (const name of [...SECRET_NAMES, ...ENV_ONLY]) {
      const value = saved[name] || this.env[name];
      if (value) values[name] = String(value);
    }
    return values;
  }
}

/** Never copy the credential map wholesale: it contains credentials. */
export function captureSettings(state, values, now = new Date()) {
  const visible = Object.fromEntries(VISIBLE_SETTINGS.map(name => [name, String(values[name] ?? '').trim()]));
  for (const name of VISIBLE_SETTINGS) if (name.startsWith('OPENAI_MODEL') && !visible[name]) visible[name] = 'gpt-4.1-mini';
  // GitHub orders snapshots by run number; here the clock gives the same ordering.
  const runNumber = now.getTime();
  if (runNumber < (state.connection_settings?.run_number ?? 0)) return;
  state.connection_settings = { values: visible, updated_at: isoUtc(now), run_number: runNumber };
}

/** The provider settings used by the content, media and news modules (config.py). */
export function providerConfig(values) {
  return {
    openai_api_key: values.OPENAI_API_KEY ?? '',
    openai_model_image: values.OPENAI_MODEL || 'gpt-4.1-mini',
    openai_model_video: values.OPENAI_MODEL_VIDEO || 'gpt-4.1-mini',
    openai_model_question: values.OPENAI_MODEL_QUESTION || 'gpt-4.1-mini',
    google_api_key: values.GOOGLE_API_KEY || null,
    google_service_account_json: values.GOOGLE_SERVICE_ACCOUNT_JSON || null,
    drive_folder_id_image: values.DRIVE_FOLDER_ID ?? '',
    drive_folder_id_video: values.DRIVE_FOLDER_ID_VIDEO ?? '',
    drive_folder_id_questions: values.DRIVE_FOLDER_ID_QUESTIONS ?? '',
    fb_page_id: values.FB_PAGE_ID ?? '',
    fb_page_access_token: values.FB_PAGE_ACCESS_TOKEN ?? '',
    fb_graph_version: values.FB_GRAPH_VERSION || 'v23.0',
    timezone: values.TIMEZONE || 'Asia/Jerusalem',
    tavily_api_key: values.TAVILY_API_KEY || null,
  };
}
