import { test, expect } from '@playwright/test';
import { demoState } from '../../web/demo.js';

// The Cloudflare installation serves the site and the gateway from one Worker.
async function cloudflareStudio(page) {
  const remote = demoState();
  const saved = {}; const commands = []; const finish = new Set();
  await page.route('**/config.json', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ gateway: 'same-origin', backend: 'cloudflare' }) }));
  await page.route('http://127.0.0.1:5189/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/login') body = { token: 'test-session', backend: 'cloudflare' };
    if (path === '/api/state') {
      // A request stays "starting" until the test lets it finish.
      for (const id of finish) if (!remote.operations.some(op => op.id === id))
        remote.operations.unshift({ id, action: commands.find(c => c.id === id).action, status: 'complete' });
      body = remote;
    }
    if (path === '/api/secrets') body = { secrets: [{ name: 'OPENAI_API_KEY' }] };
    if (path === '/api/secrets/public-key') throw new Error('Cloudflare must not use the GitHub key format');
    if (request.method() === 'PUT') {
      saved[path.split('/').at(-1)] = request.postDataJSON();
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/api/commands') {
      commands.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: '' });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { remote, saved, commands, finish };
}

test('Cloudflare studio uses its own Worker, plain-HTTPS credentials, and no GitHub wording', async ({ page }) => {
  const studio = await cloudflareStudio(page);
  await page.goto('/#settings');
  await expect(page.getByText('Powered by Cloudflare')).toBeVisible();
  await expect(page.getByText('Powered by GitHub')).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Open studio' }).click();
  await expect(page.getByRole('heading', { name: 'Cloudflare Workers' })).toBeVisible();
  await expect(page.getByText('saved encrypted in your private Cloudflare storage')).toBeVisible();
  await page.getByLabel('API key', { exact: true }).fill('replacement-api-key');
  await page.getByRole('button', { name: 'Save credentials', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Credentials saved securely');
  await expect(page.locator('#toast')).not.toContainText('GitHub');
  expect(studio.saved).toEqual({ OPENAI_API_KEY: { value: 'replacement-api-key' } });

  await page.getByRole('link', { name: 'Create a post' }).click();
  await page.getByRole('button', { name: 'Generate photo draft' }).click();
  const banner = page.locator('.pending-banner');
  await expect(banner).toContainText('Starting');
  await expect(banner).toContainText('Your request is starting');
  await expect(banner.getByRole('link', { name: /GitHub/ })).toHaveCount(0);
  await expect(page.locator('.connection-status svg')).toHaveCount(0);
  studio.finish.add(studio.commands.at(-1).id);
  await expect(banner).toHaveCount(0, { timeout: 15000 });
});
