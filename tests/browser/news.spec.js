import { test, expect } from '@playwright/test';
import { demoState, demoCommand } from '../../web/demo.js';
import { translations } from '../../web/translations.js';
import { languages } from '../../web/i18n.js';

test.use({ locale: 'en-US' });
const label = (language, key) => language === 'en' ? key : translations[key][language === 'he' ? 0 : 1];

for (const [language, width] of [['en', 1440], ['he', 390], ['ar', 320]]) {
  test(`news draft previews its source and media in ${language} at ${width}px`, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore the demo', exact: true }).click();
    await page.locator('main [data-action="new"]').click();
    if (language !== 'en') {
      await page.locator('[data-language]').click();
      await page.getByRole('menuitemradio', { name: languages[language], exact: true }).click();
    }
    await page.getByRole('button', { name: label(language, 'News Post'), exact: true }).click();
    await expect(page.getByRole('heading', { name: label(language, 'Find a story worth sharing') })).toBeVisible();
    await page.locator('#caption-style').selectOption('neutral');
    await page.getByRole('button', { name: label(language, 'Find news & prepare post'), exact: true }).click();
    await expect(page.locator('.news-source')).toContainText('bbc.com');
    await expect(page.locator('.news-link-preview .post-image')).toBeVisible();
    await expect(page.locator('.news-link-preview')).toHaveAttribute('href', 'https://www.bbc.com/news/topics/cg41ylwvggnt');
    await expect(page.locator('.draft-style')).toContainText(label(language, 'Neutral'));
    await expect(page.locator('#caption')).not.toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`news-${language}.png`), fullPage: true });
    await page.getByRole('button', { name: label(language, 'Existing resources'), exact: true }).click();
    await expect(page.locator('[data-action="type"][data-type="image"]')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: label(language, 'Generate photo draft'), exact: true }).click();
    await expect(page.locator('.news-source')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('news generation sends the style, disables duplicate requests and displays provider errors safely', async ({ page }) => {
  const remote = demoState();
  const requests = [];
  let fail = true;
  let finish;
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/commands') {
      const command = route.request().postDataJSON();
      requests.push(command);
      if (fail) {
        fail = false;
        await new Promise(resolve => { finish = resolve; });
        remote.operations.unshift({ id: command.id, status: 'failed', error: 'News search is temporarily unavailable. Try again.' });
      } else {
        demoCommand(remote, command);
        remote.drafts[0].source.media_kind = 'video';
        remote.drafts[0].preview = null;
      }
      return route.fulfill({ status: 204, body: '' });
    }
    await route.fulfill({ json: path === '/api/login' ? { token: 'test-session', repository: 'kourgeorge/alfred_posts_automation' } : remote });
  });
  await page.goto('/#create');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Open studio', exact: true }).click();
  await page.getByRole('button', { name: 'News Post', exact: true }).click();
  await page.getByLabel('Caption style', { exact: true }).selectOption('educational');
  const generate = page.getByRole('button', { name: 'Find news & prepare post', exact: true });
  await generate.click();
  await expect(generate).toBeDisabled();
  await expect(page.locator('#caption-style')).toBeDisabled();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ action: 'generate', type: 'news', caption_style: 'educational' });
  finish();
  await expect(page.locator('#toast')).toContainText('News search is temporarily unavailable');
  await expect(page.locator('#caption-style')).toHaveValue('educational');
  await generate.click();
  await expect(page.locator('.news-link-preview')).toContainText('Watch original video');
  await expect(page.locator('.news-source')).toContainText('bbc.com');
  expect(requests).toHaveLength(2);
});
