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
  runAutoSpecs,
  runBridgeSpecs,
  runChapterSpecs,
  runGenericSpecs,
  runLiveSuppressionSpecs,
  runMeasurementSpecs,
  runMultiVideoSpecs,
  runPillSpecs,
  runSkipSpecs,
  type CaptionSource,
  type E2EDriver,
} from '../shared/specs';
import { FIXTURE_PORT } from '../server';
import type { RateTier } from '../../lib/recommend';
import { defaultSettings, type Settings } from '../../lib/settings';

const extensionPath = resolve('.output/chrome-mv3-e2e');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl = (fixture: string, extra?: string): string =>
  `http://www.youtube.com/watch?v=e2e-fixture&fixture=${fixture}${extra === undefined ? '' : `&${extra}`}`;

let context: BrowserContext;
let serviceWorker: Worker;
let page: Page;
const consoleLines: string[] = [];
/** ANDROID innertube fallback POSTs seen by the route interceptor. */
let androidPosts = 0;
let driver: E2EDriver;

test.beforeAll(async () => {
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `built extension not found at ${extensionPath} — run \`bun run build:e2e\` first (the e2e build keeps the window test hooks)`,
    );
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
    const live = url.searchParams.get('live');
    const straybadge = url.searchParams.get('straybadge');
    const response = await fetch(
      `${fixtureBase}/watch?fixture=${fixture}&multi=${multi ?? ''}&live=${live ?? ''}&straybadge=${straybadge ?? ''}`,
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
    async navigateToWatch(fixture, extra) {
      consoleLines.length = 0;
      page.on('console', (message) => consoleLines.push(message.text()));
      await page.goto(watchUrl(fixture, extra));
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
    async stopAuto() {
      await page.evaluate(() => window.__speedwatcherPill?.stopAuto?.());
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
    async navigateToGenericDzen() {
      await page.goto(`${fixtureBase}/generic-dzen`);
    },
    async readCaptionTier() {
      await page.waitForFunction(
        () => window.__speedwatcherCaptionTier !== undefined,
        undefined,
        { timeout: 15_000 },
      );
      return page.evaluate(
        () => (window.__speedwatcherCaptionTier as RateTier) ?? null,
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
    async writeSkipPrefs(prefs) {
      await page.evaluate(async (next) => {
        const hook = window.__speedwatcherSkip;
        if (hook === undefined) throw new Error('__speedwatcherSkip hook missing');
        await hook.set(next);
      }, prefs);
    },
    async setLiveStream() {
      // The live badge plus a navigation cycle: yt-navigate-start clears the
      // old video context, the finish re-measures and renders the live
      // suppression (mirror of the SPA transition).
      await page.evaluate(() => {
        const anchor = document.querySelector('#movie_player');
        if (anchor !== null) {
          const badge = document.createElement('div');
          badge.className = 'ytp-live-badge';
          anchor.appendChild(badge);
        }
        document.dispatchEvent(new Event('yt-navigate-start'));
        document.dispatchEvent(new Event('yt-navigate-finish'));
      });
    },
    async readChapterHook() {
      await page.waitForFunction(
        () => window.__speedwatcherChapter !== undefined,
        undefined,
        { timeout: 15_000 },
      );
      return page.evaluate(() => {
        const hook = window.__speedwatcherChapter;
        if (hook === undefined) return null;
        return { rates: hook.rates, activeIndex: hook.activeIndex };
      });
    },
    async chapterApplyFor(sec) {
      await page.evaluate((s) => window.__speedwatcherChapter?.applyFor(s), sec);
    },
    async setChapterConsent(enabled) {
      // The toggle lives inside the pill's open shadow root; wait for it to
      // render, then drive the exact click handler the button is wired to.
      await page.waitForFunction(
        () => {
          const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
          const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('button.btn-chapter-toggle');
          return btn !== null && btn !== undefined && !btn.hidden;
        },
        undefined,
        { timeout: 15_000 },
      );
      await page.evaluate((want) => {
        const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
        const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('button.btn-chapter-toggle');
        if (btn === null || btn === undefined) throw new Error('chapter toggle missing');
        if ((btn.getAttribute('aria-pressed') === 'true') !== want) btn.click();
      }, enabled);
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

test('pill really paints: shadow root populated, non-zero geometry, in the layout tree', async () => {
  // The fixture mirrors real YouTube (a div#movie_player wrapping the
  // <video>), so the pill's anchor has real layout from the start.
  await driver.navigateToWatch('real/manual-cue.json');
  await driver.readPillState();
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state?.mode === 'recommend',
    undefined,
    { timeout: 15_000 },
  );
  const render = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
    const root = host?.shadowRoot;
    if (root === null || root === undefined) return { error: 'no open shadow root on the host' };
    const pill = root.querySelector<HTMLElement>('.pill');
    if (pill === null) return { error: '.pill missing from the shadow root' };
    const rect = pill.getBoundingClientRect();
    return {
      childCount: root.childElementCount,
      mode: pill.dataset.mode ?? null,
      width: rect.width,
      height: rect.height,
      x: rect.x,
      y: rect.y,
      hasOffsetParent: pill.offsetParent !== null,
      hostZIndex: host === null || host === undefined ? -1 : Number(getComputedStyle(host).zIndex),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  console.log('real-render pill geometry:', JSON.stringify(render));
  if (render === null || 'error' in render) {
    throw new Error(`pill real-render check failed: ${render === null ? 'no host' : render.error}`);
  }
  // (a) the shadow root exists and holds the pill DOM
  expect(render.childCount).toBeGreaterThan(0);
  expect(render.mode).toBe('recommend');
  // (b) the pill has real painted geometry
  expect(render.width).toBeGreaterThan(0);
  expect(render.height).toBeGreaterThan(0);
  // (c) the pill is in the layout tree (has a positioned ancestor)
  expect(render.hasOffsetParent).toBe(true);
  // (d) the pill anchors fixed to the viewport's bottom-right (the shadow
  // :host rule): fully inside the viewport, in its right-bottom half.
  const right = render.x + render.width;
  const bottom = render.y + render.height;
  expect(render.x).toBeGreaterThanOrEqual(0);
  expect(render.y).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(render.viewport.width);
  expect(bottom).toBeLessThanOrEqual(render.viewport.height);
  expect(right).toBeGreaterThan(render.viewport.width / 2);
  expect(bottom).toBeGreaterThan(render.viewport.height / 2);
  // (e) the host sits at the top of the stacking chart — the user-verified
  // fix for the pill painting behind YouTube's related-videos column (the
  // computed value reads the inline style on the page-visible host).
  expect(render.hostZIndex).toBeGreaterThanOrEqual(2147483000);
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

test('auto-apply: opt-in settings apply on navigation; estimated/music stay pill-only; stop-auto and manual override disengage per video', async () => {
  await runAutoSpecs(driver);
});

test('generic matcher harvests captions, applies, and re-asserts after a reset', async () => {
  await runGenericSpecs(driver);
});

test('generic apply at >=1.5x counts toward the recall nudge (E6)', async () => {
  // E6: the generic matcher mirrors content.ts's nudge wiring — a
  // high-speed apply on a non-YouTube player counts too. The talk fixture
  // renders 1.05x at the default target, so raise the target to 360 and let
  // the manual-cue clamp land at exactly 1.5x (>= NUDGE_MULTIPLIER_MIN).
  const readNudge = (): Promise<number> =>
    serviceWorker.evaluate(async () => {
      const items = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.local.get('sw.nudge', (items) => resolve(items)),
      );
      const record = items['sw.nudge'] as { highApplied?: number } | undefined;
      return typeof record?.highApplied === 'number' ? record.highApplied : 0;
    });
  // Deterministic baseline: other specs apply high-speed pills too, and a
  // counter at 3 would show the overlay and reset mid-assertion.
  await serviceWorker.evaluate(async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ 'sw.nudge': { highApplied: 0 } }, () => resolve()),
    );
  });
  await driver.navigateToWatch('real/manual-cue.json');
  await driver.readPillState();
  try {
    await driver.writeSettings({ ...defaultSettings(), target: 360 });
    await driver.navigateToGeneric();
    const state = await driver.readPillState();
    if (state === null || state.multiplier < 1.5) {
      throw new Error(`generic nudge: pill multiplier ${state?.multiplier}, expected >= 1.5`);
    }
    await driver.applyPill();
    await expect.poll(async () => readNudge(), { timeout: 10_000 }).toBe(1);
  } finally {
    await driver.navigateToWatch('real/manual-cue.json');
    await driver.readPillState();
    await driver.writeSettings(defaultSettings());
  }
});

test('applied generic playback accrues sw.timeSavedSec (time-saved metric)', async () => {
  // The tracker flushes to the background store every 10 s and on detach, so
  // the assertion reads around a fresh apply and forces the flush with a
  // dismiss; the value lives in chrome.storage.local, reachable only from
  // the extension (same read pattern as the demand test).
  const readSaved = (): Promise<number> =>
    serviceWorker.evaluate(async () => {
      const items = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.local.get('sw.timeSavedSec', (items) => resolve(items)),
      );
      const value = items['sw.timeSavedSec'];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });

  await driver.navigateToGeneric();
  await driver.readPillState();
  await driver.applyPill();
  const before = await readSaved();
  // The fixture video plays the silent webm at the applied rate; real
  // timeupdate ticks accrue wall time during the sleep.
  await driver.sleep(4500);
  await driver.dismissPill(); // detach flushes the accrued tail to the store
  await expect.poll(async () => readSaved(), { timeout: 10_000 }).toBeGreaterThan(before);
});

test('multi-video page: Apply targets the video that actually plays', async () => {
  await runMultiVideoSpecs(driver);
});

test('chaptered fixture: consent toggle arms the per-chapter scheduler', async () => {
  await runChapterSpecs(driver);
});

test('live suppression: stray page-level badge must not suppress; playerResponse flags and in-player badges do', async () => {
  await runLiveSuppressionSpecs(driver);
});

test('skip-silence: the toggle dips the rate inside caption gaps; off/music/live never dip', async () => {
  await runSkipSpecs(driver);
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
  const manualCueResponse = {
    videoDetails: { videoId: 'e2e-fixture', title: 'E2E fixture: real/manual-cue.json' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: '/api/timedtext?fixture=real/manual-cue.json', languageCode: 'en' },
        ],
      },
    },
  };
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
  });
  // Measure 1: slow (its caption fetch is the delayed one), pinned to the
  // asr-word response it reads before the swap below.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  // Point the player response at a different fixture, then measure 2: queued
  // behind measure 1 (guard) or concurrent (no guard), fast, manual-cue.
  await page.evaluate((response) => {
    window.ytInitialPlayerResponse = response;
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
  }, manualCueResponse);
  // Both landed (the delayed fetch resolves at ~1500ms).
  await driver.sleep(2500);
  const state = await driver.readPillState();
  const { rec } = expectedRecommendation('real/manual-cue.json');
  if (
    state === null ||
    state.mode !== rec.mode ||
    (state.reason ?? null) !== rec.reason ||
    Math.abs(state.multiplier - rec.multiplier) > 1e-9
  ) {
    throw new Error(
      `measure race: final pill ${state?.mode}/${state?.reason}/${state?.multiplier}, ` +
        `expected ${rec.mode}/${rec.reason}/${rec.multiplier} (stale measure must not win)`,
    );
  }
});

test('auto-apply race: a stale in-flight measure never applies; the fresh measure auto-applies', async () => {
  // The navigation epoch (E2): onNavigationStart resets autoState but cannot
  // cancel an in-flight measure. Without the guard the stale measure's
  // renderRecommendation auto-applies the OLD video's multiplier (manual-cue
  // 1.4) and sets autoState='auto', which blocks the fresh ja measure's
  // correct apply (0.9).
  await driver.navigateToWatch('real/manual-cue.json');
  await driver.readPillState();
  try {
    await driver.writeSettings({
      ...defaultSettings(),
      contentType: 'talk',
      autoApply: { enabled: true, contentTypes: {} },
    });
    // Measure 1 reads the manual-cue response, but its caption fetch is
    // delayed; the player response is swapped to ja before it lands.
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
    });
    await page.evaluate(() => {
      document.dispatchEvent(new Event('yt-navigate-start'));
      document.dispatchEvent(new Event('yt-navigate-finish'));
    });
    const jaResponse = {
      videoDetails: { videoId: 'e2e-fixture', title: 'E2E fixture: synthetic/ja-captions.json' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            // kind: 'asr' mirrors the fixture server's player response
            // (KIND_BY_FIXTURE) — without it the matcher takes the manual
            // path and the multipliers do not diverge.
            {
              baseUrl: '/api/timedtext?fixture=synthetic/ja-captions.json',
              kind: 'asr',
              languageCode: 'ja',
            },
          ],
        },
      },
    };
    await page.evaluate((response) => {
      window.ytInitialPlayerResponse = response;
      document.dispatchEvent(new Event('yt-navigate-start'));
      document.dispatchEvent(new Event('yt-navigate-finish'));
    }, jaResponse);
    // Both measures landed; the stale one must not have applied its
    // multiplier — the queued fresh measure auto-applies the ja one.
    await driver.sleep(2500);
    const state = await driver.readPillState();
    const { rec } = expectedRecommendation('synthetic/ja-captions.json');
    if (
      state === null ||
      state.applied !== 'auto' ||
      state.mode !== rec.mode ||
      Math.abs(state.multiplier - rec.multiplier) > 1e-9
    ) {
      throw new Error(
        `auto-apply race: pill ${state?.mode}/${state?.applied}/${state?.multiplier}, ` +
          `expected ${rec.mode}/auto/${rec.multiplier} (stale measure must not set autoState)`,
      );
    }
    const rate = await driver.readPlaybackRate();
    if (rate === null || Math.abs(rate - rec.multiplier) > 0.01) {
      throw new Error(
        `auto-apply race: playbackRate ${rate}, expected ${rec.multiplier} (fresh measure's multiplier, not the stale one's)`,
      );
    }
  } finally {
    await driver.writeSettings(defaultSettings());
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
