import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true });

async function openDemo(page) {
  await page.goto('/');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Explore the demo' }).tap();
  await expect(page.locator('.app-layout')).toBeVisible();
}

async function navigate(page, name) {
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  if (await toggle.isVisible()) await toggle.tap();
  await page.locator('.sidebar').getByRole('link', { name, exact: true }).tap();
  await expect(page.locator('.breadcrumb strong')).toHaveText(name);
}

async function fits(page, width) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const bounds = await dialog.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
  }
}

for (const [width, height] of [[320,740], [390,844], [430,932], [768,1024], [844,390]]) {
  test(`touch workflows fit ${width}×${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await openDemo(page);
    await fits(page, width);

    await navigate(page, 'Create a post');
    await page.getByRole('button', { name: 'Upload image or video', exact: true }).tap();
    await page.getByLabel('Choose an image or video', { exact: true }).setInputFiles('tests/browser/fixtures/upload-photo.png');
    await page.getByLabel('Describe your image or video', { exact: true }).fill('A mobile driving lesson');
    await fits(page, width);
    await page.getByRole('button', { name: 'Generate caption', exact: true }).tap();
    await expect(page.locator('#caption')).toContainText('A mobile driving lesson');
    const caption = 'בדיקה מהטלפון — A caption edited on mobile';
    await page.getByLabel('Post caption').fill(caption);
    await expect(page.locator('#preview-caption')).toHaveText(caption);
    await page.getByRole('button', { name: 'Save draft', exact: true }).tap();
    await expect(page.locator('#edit-state')).toHaveText('Saved draft');

    await page.getByRole('button', { name: 'Publish now', exact: true }).tap();
    await fits(page, width);
    await page.getByRole('button', { name: 'Keep editing', exact: true }).tap();
    await page.getByRole('button', { name: 'Schedule post', exact: true }).tap();
    await fits(page, width);
    await page.locator('#post-date').fill('2099-10-02T10:30');
    await page.getByRole('dialog').getByRole('button', { name: 'Schedule post', exact: true }).tap();
    await expect(page.locator('.caption-panel .badge')).toHaveText('Scheduled');

    await navigate(page, 'Schedule');
    await fits(page, width);
    await page.getByRole('button', { name: 'Add a schedule', exact: true }).tap();
    await page.getByLabel('Schedule name', { exact: true }).fill('Mobile schedule');
    await page.getByLabel('Preferred time', { exact: true }).fill('12:15');
    const saturday = page.locator('.day-picker label').filter({ hasText: 'Sat' });
    await saturday.tap();
    await expect(saturday.locator('input')).toBeChecked();
    await fits(page, width);
    await page.getByRole('button', { name: 'Save schedule', exact: true }).tap();
    const card = page.locator('.schedule-card').filter({ hasText: 'Mobile schedule' });
    await expect(card).toBeVisible();
    const toggle = card.getByRole('switch');
    const bounds = await toggle.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await toggle.tap();
    await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    await navigate(page, 'Activity');
    await page.getByRole('button', { name: /^Scheduled/ }).tap();
    await fits(page, width);
    await page.getByRole('button', { name: 'Review post', exact: true }).first().tap();
    await expect(page.locator('#caption')).toHaveValue(caption);

    await navigate(page, 'Settings');
    await fits(page, width);
    await page.getByRole('button', { name: 'AI prompts', exact: true }).tap();
    await page.getByLabel('Photo prompt', { exact: true }).fill('Write a clear short caption in Hebrew.');
    await page.getByRole('button', { name: 'Save prompt', exact: true }).tap();
    await expect(page.locator('#prompt-state')).toHaveText('Saved custom prompt');
    await fits(page, width);
    await page.screenshot({ path: testInfo.outputPath('mobile-settings.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('mobile navigation preserves edits, dismisses, and contains focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await navigate(page, 'Settings');
  const field = page.getByLabel(/^Facebook page ID/);
  const key = page.getByLabel('API key', { exact: true });
  await field.fill('777777');
  await key.fill('unsaved-replacement');
  const menu = page.getByRole('button', { name: 'Toggle navigation' });
  await menu.tap();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement.closest('.sidebar, .mobile-menu')))).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(field).toHaveValue('777777');
  await expect(key).toHaveValue('unsaved-replacement');
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');

  await menu.tap();
  await page.touchscreen.tap(370, 200);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(field).toHaveValue('777777');
  await menu.tap();
  await page.locator('.sidebar').getByRole('link', { name: 'Settings', exact: true }).tap();
  await expect(key).toHaveValue('unsaved-replacement');

  await navigate(page, 'Schedule');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await menu.tap();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.sidebar')).not.toHaveAttribute('inert', '');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.locator('.sidebar').getByRole('link', { name: 'Settings', exact: true }).tap();
  await expect(page.locator('.breadcrumb strong')).toHaveText('Settings');
  await page.setViewportSize({ width: 390, height: 500 });
  await menu.tap();
  await page.locator('.sidebar').getByRole('button', { name: 'Exit demo', exact: true }).tap();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/mobile-nav-open/);
});
