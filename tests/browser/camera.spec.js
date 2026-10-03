import { test, expect } from '@playwright/test';
import { translations } from '../../web/translations.js';
import { languages } from '../../web/i18n.js';

test.use({ hasTouch: true, isMobile: true, locale: 'en-US' });
const label = (language, key) => language === 'en' ? key : translations[key][language === 'he' ? 0 : 1];

for (const language of ['en', 'he', 'ar']) test(`${language}: capture a photo or video and review it before generating a post`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('[data-language]').tap();
  await page.getByRole('menuitemradio', { name: languages[language], exact: true }).tap();
  await page.locator('[data-action="demo"]').tap();
  await page.locator('.mobile-menu').tap();
  await page.locator('.sidebar a[href="#create"]').tap();
  await page.locator('[data-mode="upload"]').tap();
  const generate = page.getByRole('button', { name: label(language, 'Generate caption'), exact: true });
  await expect(generate).toBeDisabled();
  await expect(page.locator('#media-upload')).not.toHaveAttribute('capture');
  await page.locator('#upload-description').fill('A driving lesson — שיעור נהיגה — درس قيادة');

  for (const [kind, title, accept, file] of [
    ['photo', 'Take photo', 'image/*', 'tests/browser/fixtures/upload-photo.png'],
    ['video', 'Record video', 'video/*', 'tests/browser/fixtures/upload-video.mp4'],
  ]) {
    const button = page.getByRole('button', { name: label(language, title), exact: true });
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    const chooserReady = page.waitForEvent('filechooser');
    await button.tap();
    const chooser = await chooserReady;
    expect(await chooser.element().getAttribute('capture')).toBe('environment');
    expect(await chooser.element().getAttribute('accept')).toBe(accept);
    await chooser.setFiles(file);
    await expect(page.locator('.upload-selection')).toBeVisible();
    await expect(page.locator('#caption')).toHaveCount(0);
    await expect(generate).toBeEnabled();
    await expect(page.locator('#upload-description')).toHaveValue('A driving lesson — שיעור נהיגה — درس قيادة');
    if (kind === 'photo') await expect(page.getByAltText(label(language, 'Selected upload preview'))).toBeVisible();
    else await expect.poll(() => page.locator('.upload-selection video').evaluate(el => el.readyState)).toBeGreaterThan(0);

    // Cancelling a retake keeps the previously selected media and description.
    const preview = await page.locator('.upload-selection img, .upload-selection video').getAttribute('src');
    const cancelledReady = page.waitForEvent('filechooser');
    await button.tap();
    await (await cancelledReady).setFiles([]);
    await expect(page.locator('.upload-selection img, .upload-selection video')).toHaveAttribute('src', preview);
    await expect(generate).toBeEnabled();
    await generate.tap();
    await expect(page.locator('#caption')).toContainText('A driving lesson');
    await expect(page.locator('.caption-panel .badge')).toHaveText(label(language, 'Draft'));
    expect(await page.locator('#media-upload').evaluate(input => input.files[0].name)).toBe(file.split('/').at(-1));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  }
  expect(errors).toEqual([]);
});
