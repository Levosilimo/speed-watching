// CfT lane: same fixture server as the main chromium suite, but only the
// offscreen spec runs (the main headless suite stays on the bundled channel
// in playwright.config.chromium.ts). The managed build IS Chrome for Testing
// (Playwright 1.57+ ships CfT as its default chromium; verified 151.0.7922.34
// on this box) — the channel is named explicitly in the spec so the lane
// fails loudly if a future Playwright switches the managed build back.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/chromium',
  testMatch: 'offscreen.spec.ts',
  workers: 1,
  timeout: 60_000,
  reporter: 'line',
  webServer: {
    command: 'bun run e2e/server.ts',
    url: 'http://127.0.0.1:4319/proxy.pac',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
