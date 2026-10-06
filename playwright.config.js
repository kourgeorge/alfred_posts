import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5189', headless: true, screenshot: 'only-on-failure' },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'mobile-webkit', testMatch: ['mobile.spec.js', 'i18n.spec.js', 'camera.spec.js', 'caption-styles.spec.js', 'news.spec.js', 'models.spec.js'], use: { browserName: 'webkit' } },
  ],
  webServer: { command: 'npm run preview -- --port 5189 --strictPort', url: 'http://127.0.0.1:5189', reuseExistingServer: false },
});
