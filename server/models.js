// Model discovery and the one private Studio model setting. Mirrors studio/models.py,
// using the same discovery code as the GitHub worker (scripts/openai-models.mjs).
import { modelRequest } from '../scripts/openai-models.mjs';
import { UserError, isInt } from './util.js';

export async function fetchModels(apiKey, model) {
  try { return await modelRequest(apiKey, model); }
  catch { throw new UserError('OpenAI model request failed. Check your API key, model access and billing, then try again.'); }
}

function check(state, revision) {
  if (!isInt(revision) || revision !== (state.ai_settings?.revision ?? 0))
    throw new UserError('The model changed in another session. Discard your change and choose again.');
}

export async function saveModel(store, command, apiKey, step) {
  const { model, revision } = command;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,150}$/.test(model))
    throw new UserError('Choose a model from the refreshed OpenAI list.');
  await step('check model revision', async () => check((await store.read())[0], revision));
  // Fresh availability and a small caption-endpoint check.
  const catalog = await step('check model', () => fetchModels(apiKey, model));
  return step('save model', () => store.change(state => {
    check(state, revision);
    state.ai_settings = { model, revision: revision + 1 };
    state.model_catalog = catalog;
  }).then(() => null));
}

/** Preserve existing installations until the user saves a choice. */
export function applyModel(config, state) {
  const model = state.ai_settings?.model;
  if (!model) return config;
  return { ...config, openai_model_image: model, openai_model_video: model, openai_model_question: model };
}
