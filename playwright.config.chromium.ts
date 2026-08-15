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
  expect: {
    // The pill's accessibility surface is fully specified: the aria
    // snapshots in this lane list every child of the pill host, so an
    // extra node or a button inside the live region fails the assertion
    // instead of passing as an unlisted sibling.
    toMatchAriaSnapshot: { children: 'equal' },
  },
  webServer: {
    command: 'bun run e2e/server.ts',
    url: 'http://127.0.0.1:4319/proxy.pac',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
