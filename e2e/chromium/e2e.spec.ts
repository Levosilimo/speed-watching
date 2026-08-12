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
  expectedRecommendation,
  runBridgeSpecs,
  runGenericSpecs,
  runMeasurementSpecs,
  runMultiVideoSpecs,
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
    const multi = url.searchParams.get('multi');
    const response = await fetch(
      `${fixtureBase}/watch?fixture=${fixture}&multi=${multi ?? ''}`,
    );
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
    async readPlaybackRate(index = 0) {
      return page.evaluate((i) => {
        const video = document.querySelectorAll('video')[i];
        return video?.playbackRate ?? null;
      }, index);
    },
    async setPlaybackRate(rate) {
      await page.evaluate((value) => {
        const video = document.querySelector('video');
        if (video !== null) video.playbackRate = value;
      }, rate);
    },
    async navigateToMultiVideo(fixture) {
      await page.goto(`${watchUrl(fixture)}&multi=1`);
    },
    async fireMediaEvent(index, type) {
      await page.evaluate(
        ({ i, eventType }) => {
          document.querySelectorAll('video')[i]?.dispatchEvent(new Event(eventType));
        },
        { i: index, eventType: type },
      );
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

test('multi-video page: Apply targets the video that actually plays', async () => {
  await runMultiVideoSpecs(driver);
});

test('measure race: a slow in-flight measure cannot overwrite a newer one', async () => {
  // The measure() guard (mirror of generic.content.ts) serializes overlapping
  // measures: yt-navigate-finish during an in-flight caption fetch queues a
  // re-measure instead of running concurrently. Without it, the slow stale
  // measure lands last and its pill wins. The slow fetch is injected by
  // wrapping window.fetch (same MAIN world as the content script) and the
  // player response is swapped so the two measures disagree on the result.
  await driver.navigateToWatch('real/asr-word.json');
  const initial = await driver.readPillState();
  expect(initial?.mode).toBe('warning'); // pause-diluted: the stale side
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    let delayed = false;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
      if (!delayed && url.includes('/api/timedtext')) {
        delayed = true;
        return new Promise<Response>((resolve, reject) => {
          setTimeout(() => {
            realFetch(input, init).then(resolve, reject);
          }, 1500);
        });
      }
      return realFetch(input, init);
    };
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: 'e2e-fixture', title: 'E2E fixture: real/manual-cue.json' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: '/api/timedtext?fixture=real/manual-cue.json', languageCode: 'en' },
          ],
        },
      },
    };
  });
  // Measure 1: slow (its caption fetch is the delayed one).
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  // Measure 2: queued behind measure 1, fast, reads the manual-cue response.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  // Both landed (the delayed fetch resolves at ~1500ms).
  await driver.sleep(2500);
  const state = await driver.readPillState();
  const { rec } = expectedRecommendation('real/manual-cue.json');
  if (
    state === null ||
    state.mode !== rec.mode ||
    state.reason !== rec.reason ||
    Math.abs(state.multiplier - rec.multiplier) > 1e-9
  ) {
    throw new Error(
      `measure race: final pill ${state?.mode}/${state?.reason}/${state?.multiplier}, ` +
        `expected ${rec.mode}/${rec.reason}/${rec.multiplier} (stale measure must not win)`,
    );
  }
});

test('SPA race: an Apply between yt-navigate-start and the fresh pill is a no-op', async () => {
  const fixture = 'real/asr-word.json';
  await driver.navigateToWatch(fixture);
  const state = await driver.readPillState();
  // The old video's recommendation is live; a fast Apply right after
  // navigation starts must not apply the previous multiplier.
  const rateBefore = await driver.readPlaybackRate();
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    window.__speedwatcherPill?.apply();
  });
  const rateAfter = await driver.readPlaybackRate();
  expect(rateBefore).toBe(1);
  expect(rateAfter).toBe(1);
  expect(rateAfter).not.toBeCloseTo(state?.multiplier ?? -1, 2);
  const pillState = await driver.readPillState();
  expect(pillState?.mode).toBe('none');
});

test('demand and override-log records survive a service-worker restart; the SW re-answers', async () => {
  // Seed records through the bridge (chrome.storage.local writes need no SW).
  await driver.navigateToWatch('synthetic/no-tracks.json');
  await driver.readPillState();
  await driver.applyPill();
  await driver.sleep(300); // let the log append land

  const readStorage = (worker: Worker, key: string): Promise<unknown> =>
    worker.evaluate(async (storageKey) => {
      const items = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.local.get(storageKey, (items) => resolve(items)),
      );
      return items[storageKey];
    }, key);

  const demand = await readStorage(serviceWorker, 'sw.demand');
  const log = await readStorage(serviceWorker, 'sw.overrideLog');
  expect(demand).not.toBeNull();
  expect(log).not.toBeNull();

  // Stop the worker as the browser would on idle. newCDPSession accepts
  // only Page/Frame in this playwright version, so the versionId comes from
  // the ServiceWorker domain's workerVersionUpdated events.
  const session = await context.newCDPSession(page);
  const extensionUrl = serviceWorker.url();
  const statusLog: Array<{ versionId: string; runningStatus?: string }> = [];
  session.on('ServiceWorker.workerVersionUpdated', (event: {
    versions: Array<{ scriptURL?: string; versionId: string; runningStatus?: string }>;
  }) => {
    for (const version of event.versions) {
      if (version.scriptURL === extensionUrl) {
        statusLog.push({ versionId: version.versionId, runningStatus: version.runningStatus });
      }
    }
  });
  await session.send('ServiceWorker.enable');
  await expect.poll(() => statusLog.length, { timeout: 10_000 }).toBeGreaterThan(0);
  const latest = statusLog[statusLog.length - 1];
  if (latest === undefined) throw new Error('no service-worker version observed');
  await session.send('ServiceWorker.stopWorker', { versionId: latest.versionId });
  await expect.poll(() => statusLog.at(-1)?.runningStatus, { timeout: 10_000 }).toBe('stopped');

  // Wake it: the options page's probe-state round trip targets the SW.
  const extensionId = new URL(serviceWorker.url()).host;
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await expect.poll(() => statusLog.at(-1)?.runningStatus, { timeout: 15_000 }).toBe('running');

  // Records live in chrome.storage.local, so they survive the restart; the
  // re-answering worker reads them back.
  expect(await readStorage(serviceWorker, 'sw.demand')).toEqual(demand);
  expect(await readStorage(serviceWorker, 'sw.overrideLog')).toEqual(log);
  expect(await serviceWorker.evaluate(() => chrome.runtime.getManifest().name)).toBe('Speed Watcher');
  await optionsPage.close();
});
