import { test, expect } from '@playwright/test';
import { translations } from '../../web/translations.js';
import { demoState } from '../../web/demo.js';

test.use({ hasTouch: true, isMobile: true, locale: 'en-US' });

const label = (language, key) => translations[key][language === 'he' ? 0 : 1];
async function navigate(page, route) {
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').tap();
  await page.locator(`.sidebar a[href="#${route}"]`).tap();
  await expect(page).toHaveURL(new RegExp(`#${route}$`));
}
async function fits(page, width) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  if (await page.getByRole('dialog').count()) {
    expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
}

for (const language of ['he', 'ar']) for (const width of [320, 390, 844, 1440]) {
  test(`${language} interface and scheduling work at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.locator('#studio-password').fill('unsaved-password');
    await page.locator('[data-language]').selectOption(language);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#studio-password')).toHaveValue('unsaved-password');
    await expect(page.getByRole('heading', { name: language === 'he' ? 'מרחב משלך.' : 'مساحتك الخاصة.' })).toBeVisible();
    await fits(page, width);
    await page.getByRole('button', { name: label(language, 'Explore the demo'), exact: true }).tap();
    await expect(page.locator('.app-layout')).toBeVisible();
    await expect(page.locator('h1')).toHaveText(label(language, 'Your content, on autopilot.'));
    await fits(page, width);

    await navigate(page, 'create');
    await page.getByRole('button', { name: label(language, 'Generate photo draft'), exact: true }).tap();
    await expect(page.locator('#caption')).toBeVisible();
    const caption = 'Draft — טקסט عربي <b>stays literal</b>';
    const source = await page.locator('.source-label > span').textContent();
    await page.locator('#caption').fill(caption);
    await page.locator('[data-language]').selectOption('en');
    await expect(page.locator('#caption')).toHaveValue(caption);
    await expect(page.locator('#preview-caption')).toHaveText(caption);
    await expect(page.locator('#preview-caption b')).toHaveCount(0);
    await expect(page.locator('.source-label > span')).toHaveText(source);
    await page.locator('[data-language]').selectOption(language);
    await page.getByRole('button', { name: label(language, 'Save draft'), exact: true }).tap();
    await expect(page.locator('#edit-state')).toHaveText(label(language, 'Saved draft'));
    await page.getByRole('button', { name: label(language, 'Publish now'), exact: true }).tap();
    await expect(page.getByRole('dialog')).toContainText(label(language, 'This is a demo. No post will be sent to Facebook.'));
    await fits(page, width);
    await page.getByRole('button', { name: label(language, 'Keep editing'), exact: true }).tap();

    await navigate(page, 'schedule');
    await page.getByRole('button', { name: label(language, 'Add a schedule'), exact: true }).tap();
    await page.locator('#schedule-name').fill('تجربة עברית');
    await page.locator('#schedule-time').fill('12:15');
    await page.locator('#schedule-zone').fill('UTC');
    const saturday = page.locator('.day-picker label').filter({ has: page.locator('input[value="5"]') });
    await saturday.tap();
    await expect(saturday.locator('input')).toBeChecked();
    await expect(page.locator('#schedule-type')).toHaveValue('image');
    await fits(page, width);
    await page.getByRole('button', { name: label(language, 'Save schedule'), exact: true }).tap();
    const card = page.locator('.schedule-card').filter({ hasText: 'تجربة עברית' });
    await expect(card).toContainText('12:15');
    await expect(card).toContainText('UTC');
    await card.getByRole('switch').tap();
    await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await card.locator('[data-action="edit-schedule"]').tap();
    await expect(page.locator('#schedule-time')).toHaveValue('12:15');
    await expect(page.locator('#schedule-zone')).toHaveValue('UTC');
    await page.getByRole('button', { name: label(language, 'Cancel'), exact: true }).tap();
    await navigate(page, 'activity');
    await page.getByRole('group', { name: label(language, 'Filter activity'), exact: true })
      .getByRole('button', { name: new RegExp(label(language, 'Published')) }).tap();
    await fits(page, width);

    await navigate(page, 'settings');
    await page.locator('#fb-page').fill('777777');
    await page.locator('#openai-key').fill('private-unsaved-replacement');
    await page.locator('[data-language]').selectOption('en');
    await expect(page.locator('#fb-page')).toHaveValue('777777');
    await expect(page.locator('#openai-key')).toHaveValue('private-unsaved-replacement');
    await page.locator('[data-language]').selectOption(language);
    await fits(page, width);
    await page.getByRole('button', { name: label(language, 'AI prompts'), exact: true }).tap();
    const prompt = 'Write in Hebrew. اكتب بالعربية. <script>plain text</script>';
    await page.locator('#prompt-text').fill(prompt);
    await page.locator('[data-language]').selectOption('en');
    await expect(page.locator('#prompt-text')).toHaveValue(prompt);
    await page.locator('[data-language]').selectOption(language);
    await page.getByRole('button', { name: label(language, 'Save prompt'), exact: true }).tap();
    await expect(page.locator('#prompt-state')).toHaveText(label(language, 'Saved custom prompt'));
    await fits(page, width);
    await page.screenshot({ path: testInfo.outputPath('translated-interface.png'), fullPage: true });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('[data-language]')).toHaveValue(language);
    await expect(page.locator('#studio-password')).toHaveValue('');
    expect(await page.evaluate(() => ({ keys: Object.keys(localStorage), session: sessionStorage.length })))
      .toEqual({ keys: ['alfred-ui-language'], session: 0 });
    expect(errors).toEqual([]);
  });
}

test('language switching preserves uploads and works without browser storage', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }));
  await page.goto('/');
  await page.locator('[data-language]').selectOption('ar');
  await page.locator('[data-action="demo"]').tap();
  await expect(page.locator('.app-layout')).toBeVisible();
  await navigate(page, 'create');
  await page.locator('[data-mode="upload"]').tap();
  await page.locator('#media-upload').setInputFiles('tests/browser/fixtures/upload-photo.png');
  await page.locator('#upload-description').fill('وصف الصورة — תיאור');
  await page.locator('[data-language]').selectOption('he');
  await expect(page.locator('#upload-description')).toHaveValue('وصف الصورة — תיאור');
  expect(await page.locator('#media-upload').evaluate(el => el.files[0].name)).toBe('upload-photo.png');
  await page.getByRole('button', { name: 'יצירת טקסט', exact: true }).tap();
  await expect(page.locator('#caption')).toContainText('وصف الصورة — תיאור');
  await fits(page, 390);
});

test('authentication errors and pending work follow the selected language', async ({ page }) => {
  const remote = demoState();
  let valid = false;
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/login' && !valid) return route.fulfill({ status: 401, json: { error: 'Incorrect password. Please try again.' } });
    if (path === '/api/commands') return route.fulfill({ status: 204, body: '' });
    await route.fulfill({ json: path === '/api/login' ? { token: 'test-session', repository: 'kourgeorge/alfred_posts_automation' } : remote });
  });
  await page.goto('/');
  await page.locator('[data-language]').selectOption('he');
  await page.locator('#studio-password').fill('wrong-password');
  await page.getByRole('button', { name: 'כניסה לסטודיו', exact: true }).tap();
  await expect(page.locator('#login-error')).toHaveText('הסיסמה שגויה. יש לנסות שוב.');
  valid = true;
  await page.locator('#studio-password').fill('test-password');
  await page.getByRole('button', { name: 'כניסה לסטודיו', exact: true }).tap();
  await expect(page.locator('.app-layout')).toBeVisible();
  await navigate(page, 'create');
  await page.getByRole('button', { name: 'יצירת טיוטת תמונה', exact: true }).tap();
  await expect(page.locator('.pending-copy strong')).toHaveText('הטיוטה נוצרת…');
  await page.locator('[data-language]').selectOption('ar');
  await expect(page.locator('.pending-copy strong')).toHaveText('جارٍ إنشاء المسودة…');
  await expect(page.locator('.pending-stage')).toHaveText('بانتظار GitHub');
  await expect(page.locator('.pending-elapsed')).toContainText('المدة');
});

test.describe('browser language preference', () => {
  test.use({ locale: 'ar-EG' });
  test('uses Arabic initially and remembers an explicit English choice', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-language]')).toHaveValue('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('[data-language]').selectOption('en');
    await page.reload();
    await expect(page.locator('[data-language]')).toHaveValue('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('button', { name: 'Open studio', exact: true })).toBeVisible();
  });
});
