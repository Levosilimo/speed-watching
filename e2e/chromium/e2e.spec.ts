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
  runBridgeSpecs,
  runGenericSpecs,
  runMeasurementSpecs,
  runPillSpecs,
  type CaptionSource,
  type E2EDriver,
} from '../shared/specs';
import { FIXTURE_PORT } from '../server';
import type { Settings } from '../../lib/settings';

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
    async navigateToGeneric() {
      await page.goto(`${fixtureBase}/generic`);
    },
    async readCaptionTier() {
      await page.waitForFunction(
        () => window.__speedwatcherCaptionTier !== undefined,
        undefined,
        { timeout: 15_000 },
      );
      return page.evaluate(
        () => (window.__speedwatcherCaptionTier as 'captions' | 'estimated') ?? null,
      );
    },
    async resetPlaybackRate() {
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video !== null) video.playbackRate = 1;
      });
    },
    async waitForPlaybackRate(expected, timeoutMs = 8_000) {
      await page.waitForFunction(
        (target) => {
          const rate = document.querySelector('video')?.playbackRate ?? null;
          return rate !== null && Math.abs(rate - target) < 0.01;
        },
        expected,
        { timeout: timeoutMs },
      );
    },
    async sleep(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    async writeSettings(settings: Settings) {
      await page.evaluate(async (next) => {
        const hook = window.__speedwatcherSettings;
        if (hook === undefined) throw new Error('__speedwatcherSettings hook missing');
        await hook.set(next);
      }, settings);
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

test('manifest registers the measurement scripts and the chrome bridge', async () => {
  // If WXT ever mis-registers a script (wrong name/merge/world/all_frames),
  // the pill falls back to default settings silently or embedded players go
  // unhandled — this guard pins the whole content-script registration
  // contract: the youtube measurement script (MAIN, top frame only), the
  // generic matcher (MAIN, all frames), and the chrome bridge (ISOLATED).
  const scripts = await serviceWorker.evaluate(
    () =>
      (chrome.runtime.getManifest() as {
        content_scripts?: Array<{ world?: string; all_frames?: boolean; matches?: string[] }>;
      }).content_scripts ?? [],
  );
  expect(scripts).toHaveLength(3);
  const registration = (script: (typeof scripts)[number]): string =>
    `${script.world ?? 'ISOLATED'}|${script.all_frames === true ? 'all-frames' : 'top-only'}|${script.matches?.join(',')}`;
  expect(scripts.map(registration).sort()).toEqual(
    [
      // chrome-backed settings bridge (entrypoints/bridge.content.ts)
      'ISOLATED|all-frames|<all_urls>',
      // generic matcher (entrypoints/generic.content.ts) — all frames so
      // cross-origin embed players are reachable
      'MAIN|all-frames|<all_urls>',
      // youtube measurement pipeline (entrypoints/content.ts)
      'MAIN|top-only|*://*.youtube.com/*',
    ].sort(),
  );
});

test('pill renders, applies, dismisses; music/unreachable suppress Apply; WEB-blocked fixture triggers the ANDROID fallback', async () => {
  await runPillSpecs(driver);
  // Network-layer proof the ANDROID innertube fallback actually fired: the
  // web-blocked fixture must have produced one youtubei/v1/player POST.
  expect(androidPosts).toBeGreaterThan(0);
});

test('estimated renders increment the local demand counter (zero egress)', async () => {
  // The shared specs assert tierLabel 'estimated' in both browsers; the
  // counter itself lives in chrome.storage.local, reachable only from the
  // extension (firefox's WebDriver cannot read it — documented split).
  // Read around a fresh navigation so the assertion is order-independent.
  const readDemand = (): Promise<{
    estimatedCount?: number;
    byContentType?: Record<string, number>;
  } | null> =>
    serviceWorker.evaluate(async () => {
      const items = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.local.get('sw.demand', (items) => resolve(items)),
      );
      const record = items['sw.demand'];
      return record === undefined
        ? null
        : (record as { estimatedCount?: number; byContentType?: Record<string, number> });
    });

  const before = await readDemand();
  await driver.navigateToWatch('synthetic/no-tracks.json');
  const state = await driver.readPillState();
  expect(state?.tierLabel).toBe('estimated');
  const after = await readDemand();
  expect(after?.estimatedCount).toBe((before?.estimatedCount ?? 0) + 1);
  expect(after?.byContentType?.generic).toBe((before?.byContentType?.generic ?? 0) + 1);
});

test('content script measures fixture wpm; console hook agrees with event hook', async () => {
  await runMeasurementSpecs(driver);
  const last = await page.evaluate(() => window.__speedwatcherLastMeasure);
  expect(consoleLines).toContain(last?.line);
});

test('bridge settings write flows into the pill (shared with firefox single-world)', async () => {
  await runBridgeSpecs(driver);
});

test('generic matcher harvests captions, applies, and re-asserts after a reset', async () => {
  await runGenericSpecs(driver);
});
