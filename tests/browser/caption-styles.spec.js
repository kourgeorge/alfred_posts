import { test, expect } from '@playwright/test';
import { demoState, demoCommand } from '../../web/demo.js';
import { translations } from '../../web/translations.js';
import { languages } from '../../web/i18n.js';

test.use({ locale: 'en-US' });
const label = (language, key) => language === 'en' ? key : translations[key][language === 'he' ? 0 : 1];
const styles = ['Saved style', 'Neutral', 'Funny', 'Friendly', 'Professional', 'Educational', 'Motivational', 'Storytelling', 'Promotional'];

test('manual library requests carry the style and publishing keeps the reviewed caption', async ({ page }) => {
  const remote = demoState();
  const requests = [];
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/commands') {
      const command = route.request().postDataJSON();
      requests.push(command);
      demoCommand(remote, command);
      return route.fulfill({ status: 204, body: '' });
    }
    await route.fulfill({ json: path === '/api/login' ? { token: 'session', repository: 'kourgeorge/alfred_posts_automation' } : remote });
  });
  await page.goto('/#create');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Open studio', exact: true }).click();
  await expect(page.getByLabel('Caption style', { exact: true })).toHaveValue('default');
  for (const [type, format, style] of [['image', 'Photo', 'funny'], ['video', 'Video', 'professional'], ['question', 'Question', 'educational']]) {
    await page.getByRole('button', { name: format, exact: true }).click();
    await page.getByLabel('Caption style', { exact: true }).selectOption(style);
    if (type === 'question') await expect(page.locator('#caption-style-scope')).toContainText('question and answers stay unchanged');
    await page.getByRole('button', { name: `Generate ${format.toLowerCase()} draft`, exact: true }).click();
    await expect(page.locator('.draft-style')).toHaveText(`Generated style: ${style[0].toUpperCase()}${style.slice(1)}`);
    expect(requests.at(-1)).toMatchObject({ action: 'generate', type, caption_style: style });
    expect(remote.drafts[0].caption_style).toBe(style);
  }
  const originalQuestion = demoState().drafts.find(draft => draft.type === 'question').text.split('\n\n').slice(1).join('\n\n');
  expect(await page.locator('#caption').inputValue()).toContain(originalQuestion);
  await page.locator('#caption').fill('My reviewed caption — שלום');
  await page.getByLabel('Caption style', { exact: true }).selectOption('promotional');
  await expect(page.locator('#caption')).toHaveValue('My reviewed caption — שלום');
  await expect(page.locator('.draft-style')).toHaveText('Generated style: Educational');
  expect(requests).toHaveLength(3);
  await page.getByRole('button', { name: 'Publish now', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish to Facebook', exact: true }).click();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Published');
  expect(requests.at(-1)).toMatchObject({ action: 'publish', text: 'My reviewed caption — שלום' });
  expect(remote.drafts[0].caption_style).toBe('educational');
});

for (const [language, width] of [['en', 1440], ['he', 390], ['ar', 320]]) {
  test(`style picker preserves upload edits and language changes in ${language} at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore the demo', exact: true }).click();
    await page.locator('main [data-action="new"]').click();
    await expect(page.locator('#caption-style option')).toHaveText(styles);
    await page.getByLabel('Caption style', { exact: true }).selectOption('funny');
    await page.getByRole('button', { name: 'Upload image or video', exact: true }).click();
    await page.locator('#media-upload').setInputFiles('tests/browser/fixtures/upload-photo.png');
    await page.locator('#upload-description').fill('מתרגלים חניה במקביל');
    await page.getByLabel('Caption style', { exact: true }).selectOption('storytelling');
    if (language !== 'en') {
      await page.locator('[data-language]').click();
      await page.getByRole('menuitemradio', { name: languages[language], exact: true }).click();
    }
    await expect(page.locator('#caption-style option')).toHaveText(styles.map(style => label(language, style)));
    await expect(page.getByLabel(label(language, 'Caption style'), { exact: true })).toHaveValue('storytelling');
    await expect(page.locator('#caption-style-hint')).toHaveText(label(language, 'A relatable moment with a useful takeaway.'));
    await expect(page.locator('#upload-description')).toHaveValue('מתרגלים חניה במקביל');
    expect(await page.locator('#media-upload').evaluate(input => input.files[0].name)).toBe('upload-photo.png');
    await page.getByRole('button', { name: label(language, 'Generate caption'), exact: true }).click();
    await expect(page.locator('#caption')).toContainText('דמיינו');
    await expect(page.locator('.draft-style')).toContainText(label(language, 'Storytelling'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`caption-style-${language}.png`), fullPage: true });
    await page.getByRole('button', { name: label(language, 'Existing resources'), exact: true }).click();
    await expect(page.locator('#caption-style')).toHaveValue('storytelling');
    await page.getByRole('button', { name: label(language, 'Generate photo draft'), exact: true }).click();
    await expect(page.locator('#caption')).toContainText('דמיינו');
    expect(errors).toEqual([]);
  });
}
