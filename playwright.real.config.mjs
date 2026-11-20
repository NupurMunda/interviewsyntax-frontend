import { defineConfig } from '@playwright/test';

// The real stack: real Worker (roundwise-backend, local D1) + real Netlify functions + the site + a local Google.
// Needs the sibling folder ../roundwise-backend. Run with: npm run test:e2e:real
export default defineConfig({
  testDir: 'tests-e2e/real',
  testMatch: /.*\.spec\.mjs/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { channel: process.env.PW_CHANNEL ?? 'chrome' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true } },
  ],
  webServer: [
    { command: 'node ../roundwise-backend/scripts/e2e-real-backend.mjs 8811', url: 'http://127.0.0.1:8811/v1/health', timeout: 180_000, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe', gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 } },
    { command: 'node tests-e2e/real/site.mjs 8812 8811', port: 8812, reuseExistingServer: false },
  ],
});
