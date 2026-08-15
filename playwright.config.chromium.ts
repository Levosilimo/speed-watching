import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/chromium',
  // The offscreen spec runs on the CfT lane (playwright.config.chromium.cft.ts,
  // channel 'chrome-for-testing'); this suite stays the bundled-channel specs.
  testIgnore: 'offscreen.spec.ts',
  workers: 1,
  timeout: 60_000,
  reporter: 'line',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'bun run e2e/server.ts',
    url: 'http://127.0.0.1:4319/proxy.pac',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
