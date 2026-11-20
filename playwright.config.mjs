import { defineConfig } from '@playwright/test';

// Two copies of the site: one with sign-in on, one with it off (the production default).
export default defineConfig({
  testDir: 'tests-e2e',
  testIgnore: /[\\/]real[\\/]/, // the real-stack specs have their own config (playwright.real.config.mjs)
  testMatch: /.*\.spec\.mjs/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // Uses the Chrome already installed on the machine (set PW_CHANNEL=chromium after `npx playwright install chromium` to use Playwright's own build).
  use: { channel: process.env.PW_CHANNEL ?? 'chrome' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    // layout.spec.mjs sets its own widths (320-768px), so it runs once, in the desktop project, rather than being skipped here.
    { name: 'mobile', testIgnore: [/[\/]real[\/]/, /layout.spec/], use: { browserName: 'chromium', viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true } },
  ],
  webServer: [
    { command: 'node tests-e2e/server.mjs 8801 on', port: 8801, reuseExistingServer: false },
    { command: 'node tests-e2e/server.mjs 8802 off', port: 8802, reuseExistingServer: false },
  ],
});
