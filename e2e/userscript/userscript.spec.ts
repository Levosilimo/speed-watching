// Userscript E2E: loads the BUILT bundle (userscript/dist/speed-watcher.user.js)
// via page.addScriptTag on the stub youtube.com fixture origin and drives the
// ported measure flow through the same hooks the extension specs use. Plain
// chromium has no GM storage, so this suite doubles as the no-storage
// fallback evidence: estimated renders come from priors, never a channel
// seed.

import { test, chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MeasureEventDetail } from '../../lib/measure-hooks';
import { priorMidpoint } from '../../lib/heuristics';
import { recommend } from '../../lib/recommend';
import type { PillState } from '../../ui/pill';
import { expectedRecommendation, expectedStats } from '../shared/specs';
import { FIXTURE_PORT } from '../server';

declare global {
  interface Window {
    __speedwatcherE2E?: boolean;
    __speedwatcherLastMeasure?: MeasureEventDetail;
    __speedwatcherPill?: {
      state: PillState | null;
      apply(): void;
      dismiss(): void;
      stopAuto?(): void;
    };
    __speedwatcherCaptionSource?: 'web' | 'android' | 'capture' | 'none';
    /** Absent in plain chromium — the no-storage fallback relies on that. */
    GM_setValue?: unknown;
  }
}

const bundlePath = resolve('userscript/dist/speed-watcher.user.js');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl = (fixture: string, extra?: string): string =>
  `http://www.youtube.com/watch?v=e2e-fixture&fixture=${fixture}${extra === undefined ? '' : `&${extra}`}`;

let browser: Browser;
let context: BrowserContext;
let page: Page;
/** ANDROID innertube fallback POSTs seen by the route interceptor. */
let androidPosts = 0;

test.beforeAll(async () => {
  if (!existsSync(bundlePath)) {
    throw new Error(`bundle not found at ${bundlePath} — run \`bun run build:userscript\` first`);
  }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  // Runtime flag: flips main()'s measure/pill hooks on before the bundle runs.
  await context.addInitScript(() => {
    window.__speedwatcherE2E = true;
  });
  await context.route('**://www.youtube.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/youtubei/v1/player') {
      androidPosts += 1;
      await route.abort();
      return;
    }
    if (url.pathname === '/api/timedtext') {
      // All query params are forwarded (fixture + pot/potc/c/fmt): the
      // pot-gated fixture's gate keys on the pot proof-of-origin params, so
      // stripping them would break the signed-request lane.
      const response = await fetch(
        `${fixtureBase}/api/timedtext?${url.searchParams.toString()}`,
      );
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
    const live = url.searchParams.get('live');
    const straybadge = url.searchParams.get('straybadge');
    const response = await fetch(
      `${fixtureBase}/watch?fixture=${fixture}&live=${live ?? ''}&straybadge=${straybadge ?? ''}`,
    );
    await route.fulfill({
      status: response.status,
      contentType: 'text/html',
      body: await response.text(),
    });
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await browser?.close();
});

async function loadBundle(fixture: string, extra?: string): Promise<void> {
  await page.goto(watchUrl(fixture, extra));
  await page.addScriptTag({ path: bundlePath });
}

async function readMeasure(): Promise<MeasureEventDetail> {
  await page.waitForFunction(
    () => window.__speedwatcherLastMeasure !== undefined,
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate(() => window.__speedwatcherLastMeasure as MeasureEventDetail);
}

async function readPill(): Promise<PillState> {
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state != null,
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate(() => window.__speedwatcherPill?.state as PillState);
}

async function readPlaybackRate(): Promise<number | null> {
  return page.evaluate(() => document.querySelector('video')?.playbackRate ?? null);
}

function assertClose(
  actual: number | null | undefined,
  expected: number | null | undefined,
  label: string,
): void {
  if (actual === null || actual === undefined) {
    if (expected !== null && expected !== undefined) {
      throw new Error(`${label}: expected ${expected.toFixed(2)}, got null`);
    }
    return;
  }
  if (expected === null || expected === undefined) {
    throw new Error(`${label}: expected null, got ${actual.toFixed(2)}`);
  }
  if (Math.abs(actual - expected) > 0.5) {
    throw new Error(`${label}: ${actual.toFixed(2)} outside tolerance of ${expected} ± 0.5`);
  }
}

test('measures the asr-word fixture and drives the pill (apply, dismiss)', async () => {
  await loadBundle('real/asr-word.json');

  // speedwatcher:measure CustomEvent, same stats contract as the extension.
  const measurement = await readMeasure();
  const expected = expectedStats('real/asr-word.json');
  assertClose(measurement.stats.word, expected.word, 'word-level');
  assertClose(measurement.stats.cue, expected.cue, 'cue-level');
  assertClose(measurement.stats.corrected, expected.corrected, 'corrected');
  expect(measurement.stats.nWords).toBe(expected.nWords);
  expect(measurement.videoId).toBe('e2e-fixture');
  expect(measurement.lang).toBe('en');

  // Pill renders the same recommendation the extension's math produces.
  const state = await readPill();
  const { rec, naturalRate } = expectedRecommendation('real/asr-word.json');
  expect(state.mode).toBe(rec.mode);
  expect(state.label).toBe(rec.label);
  expect(state.tierLabel).toBe(rec.tierLabel);
  expect(Math.abs(state.multiplier - rec.multiplier)).toBeLessThanOrEqual(1e-9);
  expect(Math.abs(state.rateWpm - naturalRate)).toBeLessThanOrEqual(0.5);
  expect(state.reason ?? null).toBe(rec.reason);

  // Captions came from the WEB timedtext fetch, not the ANDROID fallback.
  await page.waitForFunction(
    () => window.__speedwatcherCaptionSource !== undefined,
    undefined,
    { timeout: 15_000 },
  );
  expect(await page.evaluate(() => window.__speedwatcherCaptionSource)).toBe('web');

  // Apply (hook) sets the fixture <video>'s playbackRate; Dismiss hides the pill.
  await page.evaluate(() => window.__speedwatcherPill?.apply());
  expect(await readPlaybackRate()).toBeCloseTo(state.multiplier, 2);
  await page.evaluate(() => window.__speedwatcherPill?.dismiss());
  expect((await readPill()).mode).toBe('none');
});

test('manual-cue fixture measures through the corrected-cue tier', async () => {
  await loadBundle('real/manual-cue.json');
  const measurement = await readMeasure();
  const expected = expectedStats('real/manual-cue.json');
  assertClose(measurement.stats.cue, expected.cue, 'cue-level');
  assertClose(measurement.stats.corrected, expected.corrected, 'corrected');
  expect(measurement.stats.nWords).toBe(expected.nWords);
  const state = await readPill();
  expect(state.tierLabel).toBe('from captions (corrected)');
});

test('keyboard: Shift+W applies, Escape dismisses', async () => {
  await loadBundle('real/asr-word.json');
  const state = await readPill();
  await page.keyboard.press('Shift+W');
  expect(await readPlaybackRate()).toBeCloseTo(state.multiplier, 2);
  await page.keyboard.press('Escape');
  expect((await readPill()).mode).toBe('none');
});

test('no GM storage: estimated tier renders from priors, never a channel seed', async () => {
  await loadBundle('synthetic/no-tracks.json');
  const state = await readPill();
  // Plain chromium has no userscript manager — the storage gate no-ops and
  // the estimated tier falls back to the generic prior midpoint.
  expect(await page.evaluate(() => typeof window.GM_setValue)).toBe('undefined');
  const naturalRate = priorMidpoint('generic');
  const rec = recommend({ naturalRate, tier: 'estimated', contentType: 'generic', platformMax: 2 });
  expect(state.mode).toBe(rec.mode);
  expect(state.tierLabel).toBe('estimated');
  expect(state.label).toBe(rec.label);
  expect(Math.abs(state.rateWpm - naturalRate)).toBeLessThanOrEqual(0.5);
});

test('WEB blocked → ANDROID fallback fails → estimated (no storage)', async () => {
  await loadBundle('synthetic/web-blocked.json');
  await page.waitForFunction(
    () => window.__speedwatcherCaptionSource !== undefined,
    undefined,
    { timeout: 15_000 },
  );
  expect(await page.evaluate(() => window.__speedwatcherCaptionSource)).toBe('none');
  expect(androidPosts).toBeGreaterThan(0);
  const state = await readPill();
  expect(state.tierLabel).toBe('estimated');
  const naturalRate = priorMidpoint('generic');
  expect(Math.abs(state.rateWpm - naturalRate)).toBeLessThanOrEqual(0.5);
});

test('live suppression: a stray page-level badge must not suppress; isLiveContent does', async () => {
  // Fail-without-fix pin for the ported scoped-badge fix (mirror of the
  // extension's runLiveSuppressionSpecs): the document-wide .ytp-live-badge
  // query used to suppress the pill on a normal VOD with any stray badge
  // anywhere in the page. The fixture injects the badge OUTSIDE the player.
  await loadBundle('real/manual-cue.json', 'straybadge=1');
  const state = await readPill();
  expect(state.mode).toBe('recommend');

  // The player response's authoritative isLiveContent flag suppresses even
  // with no badge anywhere in the DOM.
  await loadBundle('real/manual-cue.json', 'live=1');
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state != null,
    undefined,
    { timeout: 15_000 },
  );
  expect((await readPill()).mode).toBe('none');
});

test('pot-gated fixture: the capture path measures word-level from the signed response', async () => {
  // Fail-without-fix lane for the interception port: the fixture server
  // 200-empties bare timedtext fetches (no pot params), and the stub player
  // answers the CC drive with a SIGNED fetch the userscript must capture.
  // Before the port the chain lands on the estimated tier and never
  // measures; after it, the captured payload produces the word-level rate
  // and the source reports 'capture'.
  await loadBundle('synthetic/pot-gated.json');

  const measurement = await readMeasure();
  const expected = expectedStats('synthetic/pot-gated.json');
  assertClose(measurement.stats.word, expected.word, 'captured word-level');
  expect(measurement.stats.nWords).toBe(expected.nWords);
  expect(await page.evaluate(() => window.__speedwatcherCaptionSource)).toBe('capture');

  // The CC automation must restore the pre-measure state (off) — the
  // mirror of the extension's runCaptureSpecs restore assertion.
  const ccState = await page.evaluate(
    () =>
      document
        .querySelector('button.ytp-subtitles-button')
        ?.getAttribute('aria-pressed') ?? null,
  );
  expect(ccState).toBe('false');
});
