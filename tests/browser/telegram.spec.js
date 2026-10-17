import { test, expect } from '@playwright/test';
import { demoState } from '../../web/demo.js';
import { translations } from '../../web/translations.js';

const GATEWAY = 'https://alfred-studio-gateway.kourgeorge.workers.dev/**';
const label = (language, key) => language === 'en' ? key : translations[key][language === 'he' ? 0 : 1];

/** A fake gateway with a Telegram bot. Records what the page sends. */
async function gateway(page, { status = {} } = {}) {
  const remote = demoState();
  remote.model_catalog = { ids: ['gpt-6-luna', 'gpt-5.6-luna'], refreshed_at: new Date().toISOString() };
  remote.ai_settings = { model: 'gpt-6-luna', revision: 1 };
  const bot = { enabled: true, users: ['266148622'], model: 'gpt-5.6-luna', revision: 3, token_set: true, openai_key_set: true,
    webhook_secret_set: true, settings_key_set: true, bot: { username: 'avi_openclaw_bot', name: 'avi' }, connected: true,
    pending_updates: 0, last_error: null, ...status };
  const saves = []; const secrets = []; let connects = 0;
  await page.route(GATEWAY, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === '/api/login') return route.fulfill({ json: { token: 'test-session', repository: 'kourgeorge/alfred_posts_automation' } });
    if (path === '/api/state') return route.fulfill({ json: remote });
    if (path === '/api/secrets') return route.fulfill({ json: { secrets: [{ name: 'OPENAI_API_KEY' }] } });
    if (path === '/api/secrets/public-key') return route.fulfill({ json: { key_id: 'k', key: 'Hq4JZ0j3/DC8Hl5P6B8x2rWJt0i0b3o7M9hJ6cWv1WQ=' } });
    if (path.startsWith('/api/secrets/')) { secrets.push(path.split('/').at(-1)); return route.fulfill({ status: 204, body: '' }); }
    if (path === '/api/telegram' && request.method() === 'GET') return route.fulfill({ json: bot });
    if (path === '/api/telegram' && request.method() === 'PUT') {
      const value = request.postDataJSON(); saves.push(value);
      if (value.revision !== bot.revision) return route.fulfill({ status: 409, json: { error: 'These settings changed in another session. Reload them and try again.' } });
      for (const name of ['enabled', 'users', 'model']) if (name in value) bot[name] = value[name];
      if (value.TELEGRAM_BOT_TOKEN) bot.token_set = true;
      bot.revision++;
      return route.fulfill({ json: bot });
    }
    if (path === '/api/telegram/connect') { connects++; bot.connected = true; return route.fulfill({ json: bot }); }
    if (path === '/api/commands') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ json: {} });
  });
  return { bot, saves, secrets, connects: () => connects };
}

async function openBotTab(page) {
  await page.goto('/#settings');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Open studio' }).click();
  await page.getByRole('button', { name: 'Telegram bot', exact: true }).click();
  await expect(page.getByRole('heading', { name: '@avi_openclaw_bot' })).toBeVisible();
}

for (const width of [1440, 390]) test(`bot settings show status and save users, model, pause and keys at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 });
  const fake = await gateway(page);
  await openBotTab(page);
  await expect(page.locator('#bot-status')).toHaveText('Connected. Messages to the bot reach your studio.');
  await expect(page.getByLabel('Telegram user IDs')).toHaveValue('266148622');
  await expect(page.getByLabel('Bot model')).toHaveValue('gpt-5.6-luna');
  await expect(page.locator('#bot-model option').first()).toHaveText('Same as the studio (gpt-6-luna)');
  // Keys are never shown: the fields start empty and only say whether a key is set.
  await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Bot token', { exact: true })).toHaveAttribute('type', 'password');

  await page.getByRole('button', { name: 'Save bot settings' }).click();
  await expect(page.locator('#bot-error')).toHaveText('Change a setting or enter a replacement key to save.');
  await page.getByLabel('Telegram user IDs').fill('266148622, 12ab');
  await page.getByRole('button', { name: 'Save bot settings' }).click();
  await expect(page.locator('#bot-error')).toContainText('only numbers');
  expect(fake.saves).toEqual([]);

  await page.getByLabel('Telegram user IDs').fill('266148622, 555 777');
  await page.getByLabel('Bot model').selectOption('');
  await page.getByLabel('Bot token', { exact: true }).fill('999999:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
  await page.getByRole('button', { name: 'Save bot settings' }).click();
  await expect(page.locator('#toast')).toContainText('Bot settings saved');
  expect(fake.saves).toEqual([{ revision: 3, users: ['266148622', '555', '777'], model: '', TELEGRAM_BOT_TOKEN: '999999:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }]);
  await expect(page.getByLabel('Telegram user IDs')).toHaveValue('266148622, 555, 777');
  await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue('');

  await page.getByRole('switch', { name: 'Bot is on' }).click();
  await expect(page.getByRole('switch', { name: 'Bot is on' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.section-title .secret-state').first()).toHaveText('Paused');
  await expect(page.locator('#bot-status')).toHaveText('Connected, but paused. The bot replies that it is paused.');
  expect(fake.saves.at(-1)).toEqual({ revision: 4, enabled: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `test-results/telegram-settings-${width}.png`, fullPage: true });
});

test('a disconnected bot shows the problem and reconnects', async ({ page }) => {
  const fake = await gateway(page, { status: { connected: false, webhook_elsewhere: true, last_error: 'Wrong response from the webhook: 500',
    last_error_at: new Date().toISOString(), pending_updates: 4 } });
  await openBotTab(page);
  await expect(page.locator('#bot-status')).toHaveText('This bot is connected to another address. Reconnect to use it here.');
  await expect(page.locator('.form-error').first()).toContainText('Wrong response from the webhook: 500');
  await expect(page.getByText('4 messages are waiting to be delivered.')).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.locator('#toast')).toContainText('The bot is connected to your studio.');
  await expect(page.locator('#bot-status')).toHaveText('Connected. Messages to the bot reach your studio.');
  expect(fake.connects()).toBe(1);
});

test('a new OpenAI key in Connections also updates the bot copy', async ({ page }) => {
  const fake = await gateway(page);
  await page.goto('/#settings');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Open studio' }).click();
  await page.getByLabel('API key', { exact: true }).fill('sk-replacement-key-1234567890');
  await page.getByRole('button', { name: 'Save credentials', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Credentials saved securely');
  await expect.poll(() => fake.saves.length).toBe(1);
  expect(fake.saves[0]).toEqual({ revision: 3, OPENAI_API_KEY: 'sk-replacement-key-1234567890' });
  expect(fake.secrets).toEqual(['OPENAI_API_KEY']);
});

for (const language of ['he', 'ar']) test(`bot settings are translated (${language})`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('alfred-ui-language', value), language);
  await gateway(page);
  await page.goto('/#settings');
  await page.locator('#studio-password').fill('test-password');
  await page.locator('#login-form [type=submit]').click();
  await page.getByRole('button', { name: label(language, 'Telegram bot'), exact: true }).click();
  await expect(page.locator('#bot-status')).toHaveText(label(language, 'Connected. Messages to the bot reach your studio.'));
  await expect(page.getByRole('button', { name: label(language, 'Save bot settings') })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('the demo explains the bot without contacting the gateway', async ({ page }) => {
  let calls = 0;
  await page.route(GATEWAY, route => { calls++; return route.abort(); });
  await page.goto('/');
  await page.locator('[data-action="demo"]').click();
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Telegram bot', exact: true }).click();
  await expect(page.getByText('Available after you sign in to your studio.')).toBeVisible();
  expect(calls).toBe(0);
});
