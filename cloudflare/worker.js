// Cloudflare Worker for the whole studio: the website (static assets), the
// password gateway (/api/*), each command as a durable Workflow, and the
// scheduled check (Cron Trigger). Configuration: wrangler.jsonc.
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { createGateway } from '../gateway/core.js';
import { cloudflareBackend, exists, runStudio } from './backend.js';

const handle = createGateway(cloudflareBackend);

// Steps never retry: a repeated Facebook call could publish twice. State writes
// retry inside the step instead (compare-and-swap), as on GitHub.
const STEP = { retries: { limit: 0, delay: '1 second' }, timeout: '30 minutes' };

export class StudioWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await runStudio(this.env, event.payload, (name, fn) => step.do(name, STEP, fn));
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/api') return handle(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env) {
    // One check per Cron firing; the ID makes a repeated delivery harmless.
    const id = `tick-${event.scheduledTime}`;
    try { await env.STUDIO_WORKFLOW.create({ id, params: { tick: true } }); }
    catch (error) { if (!await exists(env, id)) throw error; }
  },
};
