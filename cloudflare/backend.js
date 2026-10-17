// Cloudflare installation: state.json, uploads and encrypted credentials in R2;
// commands run as Cloudflare Workflows (see worker.js). Kept free of
// `cloudflare:` imports so tests can load it in Node.
import { HttpError, base64 } from '../gateway/core.js';
import { CloudflareImages } from '../server/images.js';
import { MediaService } from '../server/media.js';
import { applyModel } from '../server/models.js';
import { CommandFailed, Steps, Studio } from '../server/service.js';
import { SecretStore, captureSettings, providerConfig } from '../server/settings.js';
import { R2Store } from '../server/store.js';
import { WorkflowError } from '../server/drive.js';

const UPLOAD_CHUNK = 2 * 1024 * 1024;
const store = env => new R2Store(env.STUDIO, { initialPosted: env.INITIAL_POSTED_HISTORY });
const credentials = env => new SecretStore(env.STUDIO, env);

export async function exists(env, id) {
  try { return Boolean(await env.STUDIO_WORKFLOW.get(id)); } catch { return false; }
}

export const cloudflareBackend = {
  name: 'cloudflare',
  // The site is served by the same Worker; other origins can be added for a separate front end.
  origins: (env, request) => [new URL(request.url).origin,
    ...String(env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean)],
  loginPage: (env, request) => `${new URL(request.url).origin}/`,
  configured: env => Boolean(env.STUDIO && env.STUDIO_WORKFLOW && env.CREDENTIALS_KEY),
  login: () => ({}),
  readState: env => store(env).readRaw(),
  async dispatch(env, command) {
    try { await env.STUDIO_WORKFLOW.create({ id: command.id, params: { command } }); }
    catch {
      // The same request ID is already running or finished: the command is idempotent.
      if (await exists(env, command.id)) return;
      throw new HttpError(502, 'The studio could not start this request. Please try again shortly.');
    }
  },
  secretNames: env => credentials(env).names(),
  async putSecret(env, name, value) {
    // Sent over HTTPS and encrypted before it is stored; never returned to a browser.
    if (typeof value?.value !== 'string' || !value.value || value.value.length > 32768)
      throw new HttpError(400, 'Invalid credential.');
    await credentials(env).set(name, value.value);
  },
  async writeUpload(env, path, bytes) {
    const result = await store(env).writeOnce(path, bytes);
    if (result === 'saved') return { size: bytes.length };
    if (result === 'different') throw new HttpError(409, 'This upload already contains a different file. Choose the file again.');
    throw new HttpError(503, 'The upload storage is busy. Try again shortly.');
  },
  async readUpload(env, path) {
    const object = await env.STUDIO.get(path);
    if (!object) throw new HttpError(404, 'This uploaded file is unavailable.');
    if (object.size < 1 || object.size > UPLOAD_CHUNK) throw new HttpError(502, 'This uploaded file could not be opened.');
    return { content: base64(await object.arrayBuffer()), size: object.size };
  },
};

/** Like Config.from_env: provider calls need these three settings. */
function requireSettings(values) {
  for (const name of ['OPENAI_API_KEY', 'FB_PAGE_ID', 'FB_PAGE_ACCESS_TOKEN'])
    if (!values[name]) throw new WorkflowError(`Missing required setting: ${name}`);
}

/**
 * Run one dashboard command, or the scheduled check, as a Workflow.
 * `stepImpl(name, fn)` is Workflow step.do; tests pass a direct call.
 */
export async function runStudio(env, payload, stepImpl, { images = new CloudflareImages(env.IMAGES) } = {}) {
  const steps = new Steps(stepImpl);
  const state = store(env);
  const secrets = credentials(env);
  await steps.run('prepare storage', async () => {
    await state.initialize();
    const values = await secrets.values();
    await state.change(current => captureSettings(current, values));
  });
  const media = async () => {
    const values = await secrets.values();
    requireSettings(values);
    const [current] = await state.read();
    return new MediaService(applyModel(providerConfig(values), current), { store: state, images,
      step: (label, fn) => steps.run(label, fn) });
  };
  const app = new Studio(state, media, { steps, openaiKey: async () => (await secrets.values()).OPENAI_API_KEY ?? '' });
  try {
    if (payload.command) await app.command(payload.command);
    else await app.tick();
  } catch (error) {
    // A failed command is already recorded for the dashboard.
    if (!(error instanceof CommandFailed)) throw error;
  }
}
