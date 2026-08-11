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
import {
  runMeasurementSpecs,
  runPillSpecs,
  type CaptionSource,
  type E2EDriver,
} from '../shared/specs';
import { FIXTURE_PORT } from '../server';

const extensionPath = resolve('.output/chrome-mv3');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl = (fixture: string): string =>
  `http://www.youtube.com/watch?v=e2e-fixture&fixture=${fixture}`;

let context: BrowserContext;
let serviceWorker: Worker;
let page: Page;
const consoleLines: string[] = [];
/** ANDROID innertube fallback POSTs seen by the route interceptor. */
let androidPosts = 0;
let driver: E2EDriver;

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
    // The content script's ANDROID innertube fallback POST: record it, then
    // drop it (no real YouTube traffic).
    if (url.pathname === '/youtubei/v1/player') {
      androidPosts += 1;
      await route.abort();
      return;
    }
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
  driver = {
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
    async readPillState() {
      await page.waitForFunction(
        () => window.__speedwatcherPill?.state != null,
        undefined,
        { timeout: 15_000 },
      );
      return page.evaluate(() => window.__speedwatcherPill?.state ?? null);
    },
    async applyPill() {
      await page.evaluate(() => window.__speedwatcherPill?.apply());
    },
    async dismissPill() {
      await page.evaluate(() => window.__speedwatcherPill?.dismiss());
    },
    async readPlaybackRate() {
      return page.evaluate(() => document.querySelector('video')?.playbackRate ?? null);
    },
    async readCaptionSource() {
      await page.waitForFunction(
        () => window.__speedwatcherCaptionSource !== undefined,
        undefined,
        { timeout: 15_000 },
      );
      return page.evaluate(
        () => (window.__speedwatcherCaptionSource as CaptionSource) ?? null,
      );
    },
  };
});

test.afterAll(async () => {
  await context?.close();
});

test('extension loads and service worker answers', async () => {
  expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\//);
  const name = await serviceWorker.evaluate(() => chrome.runtime.getManifest().name);
  expect(name).toBe('Speed Watcher');
});

test('manifest registers the measurement script (MAIN) and its chrome bridge (ISOLATED)', async () => {
  // If WXT ever mis-registers the bridge (wrong name/merge), the pill falls
  // back to default settings silently — this guard catches that.
  const scripts = await serviceWorker.evaluate(
    () =>
      (chrome.runtime.getManifest() as { content_scripts?: Array<{ world?: string }> })
        .content_scripts ?? [],
  );
  const worlds = scripts.map((script) => script.world ?? 'ISOLATED').sort();
  expect(worlds).toEqual(['ISOLATED', 'MAIN']);
});

test('settings overrides flow from storage through the bridge into the pill', async () => {
  // Write exactly what the options page writes (lib/settings.ts Settings
  // object at 'sw.settings'), then assert the pill reflects the override —
  // with a dead bridge it would render the 250-wpm defaults instead.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      'sw.settings': {
        target: 300,
        conservative: false,
        platformMax: 2,
        sites: {},
        contentTypes: {},
      },
    });
  });
  try {
    await driver.navigateToWatch('real/asr-word.json');
    const state = await driver.readPillState();
    // 300 / 160.25 rounded to 0.05 → 1.85; the default target would give 1.55.
    expect(state?.multiplier).toBeCloseTo(1.85, 2);
  } finally {
    await serviceWorker.evaluate(async () => chrome.storage.local.remove('sw.settings'));
  }
});

test('content script measures fixture wpm; console hook agrees with event hook', async () => {
  await runMeasurementSpecs(driver);
  const last = await page.evaluate(() => window.__speedwatcherLastMeasure);
  expect(consoleLines).toContain(last?.line);
});

test('pill renders, applies, dismisses; music/unreachable suppress Apply; WEB-blocked fixture triggers the ANDROID fallback', async () => {
  await runPillSpecs(driver);
  // Network-layer proof the ANDROID innertube fallback actually fired: the
  // web-blocked fixture must have produced one youtubei/v1/player POST.
  expect(androidPosts).toBeGreaterThan(0);
});
