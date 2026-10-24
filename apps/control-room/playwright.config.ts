import { defineConfig } from '@playwright/test';

// Uses the installed Google Chrome by default. On a machine without it, run
// `npx playwright install chromium` and set PW_CHANNEL=chromium.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PW_CHANNEL ?? 'chrome',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
