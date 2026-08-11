// Chromium E2E: Playwright persistent context with the BUILT extension
// side-loaded (channel 'chromium' — bundled Playwright build; Chrome/Edge
// dropped the side-load flags). The stub watch page is served to a
// *.youtube.com origin from the local fixture server via route interception,
// so no real YouTube traffic leaves the machine.

import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMeasurementSpecs, type E2EDriver } from '../shared/specs';
import { FIXTURE_PORT } from '../server';

const extensionPath = resolve('.output/chrome-mv3');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl = (fixture: string): string =>
  `http://www.youtube.com/watch?v=e2e-fixture&fixture=${fixture}`;

let context: BrowserContext;
let serviceWorker: Worker;
let page: Page;
const consoleLines: string[] = [];

test.beforeAll(async () => {
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(`built extension not found at ${extensionPath} — run \`bun run build\` first`);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  // Dark Reader pattern: youtube.com pages are fulfilled from the fixture
  // server; non-document requests (favicon etc.) are dropped. The pattern
  // covers both schemes because Chrome's HSTS preload rewrites the http
  // navigation to https before the request reaches the network layer. The
  // caption fetch (/api/timedtext) is same-origin and served from fixtures
  // too, so no CORS or Private Network Access rules apply.
  await context.route('**://www.youtube.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/timedtext') {
      const fixture = url.searchParams.get('fixture');
      const response = await fetch(`${fixtureBase}/api/timedtext?fixture=${fixture}`);
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      });
      return;
    }
    if (request.resourceType() !== 'document') {
      await route.abort();
      return;
    }
    const fixture = url.searchParams.get('fixture');
    const response = await fetch(`${fixtureBase}/watch?fixture=${fixture}`);
    await route.fulfill({
      status: response.status,
      contentType: 'text/html',
      body: await response.text(),
    });
  });
  serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
  await context?.close();
});

test('extension loads and service worker answers', async () => {
  expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\//);
  const name = await serviceWorker.evaluate(() => chrome.runtime.getManifest().name);
  expect(name).toBe('Speed Watcher');
});

test('content script measures fixture wpm; console hook agrees with event hook', async () => {
  const driver: E2EDriver = {
    async navigateToWatch(fixture) {
      consoleLines.length = 0;
      page.on('console', (message) => consoleLines.push(message.text()));
      await page.goto(watchUrl(fixture));
    },
    async readMeasurement() {
      await page.waitForFunction(
        () => window.__speedwatcherLastMeasure !== undefined,
        undefined,
        { timeout: 15_000 },
      );
      return page.evaluate(() => window.__speedwatcherLastMeasure);
    },
  };
  await runMeasurementSpecs(driver);
  const last = await page.evaluate(() => window.__speedwatcherLastMeasure);
  expect(consoleLines).toContain(last?.line);
});
