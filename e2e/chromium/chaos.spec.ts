// Chaos permutation matrix (Wave 3): the deterministic enumeration of the
// caption-chain failure combinations. Each cell drives one fixture + variant
// through the BUILT extension and asserts the OBSERVABLE outcome — the
// caption source (capture/web/android/none) and the tier
// (asr-word/asr-cue/manual-cue/estimated) — per fetchCaptions' total order
// (lib/caption-fetch.ts): capture → web → android (transcript → baseUrl) →
// WEB-params transcript → none. Never click counts: the cells assert the
// rendered pill's source and tier only.
//
// The timing classes from the study: the offline class (the fetch
// catch→null paths, simulated by aborting the caption-chain routes) and the
// flaky-network class (a timedtext delay past the 15s capture window; a 429
// on the ANDROID POST). The matrix must fail against a deliberate
// chain-order break — the both-succeed cell's expected source inverts when
// the web/android order flips (the fail-mode proof in the Wave-3 PR).

import { chromium, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RateTier } from '../../lib/recommend';
import type { CaptionStatus, PillState } from '../../ui/pill';
import type { CaptionSource, Measurement } from '../shared/specs';
import { routeFixtures } from '../shared/route-fixtures';

const extensionPath = resolve('.output/chrome-mv3-e2e');
const watchUrl = (fixture: string, extra?: string): string =>
  `http://www.youtube.com/watch?v=e2e-fixture&fixture=${fixture}${extra === undefined ? '' : `&${extra}`}`;

let context: BrowserContext;
let page: Page;
/** Armed per offline cell: the route interceptor aborts the caption-chain
 * requests while true — the fetch-level failure a network drop produces. */
let offlineArmed = false;

interface ChaosDriver {
  navigateToWatch(fixture: string, extra?: string): Promise<void>;
  readPillState(timeoutMs?: number): Promise<PillState | null>;
  readCaptionSource(timeoutMs?: number): Promise<CaptionSource | null>;
  readMeasurement(timeoutMs?: number): Promise<Measurement | undefined>;
  /** The source hook's current value without waiting — the no-track page
   * never sets it (no fetch chain ran), and the cell asserts that absence. */
  peekCaptionSource(): Promise<CaptionSource | null>;
}
let driver: ChaosDriver;

test.beforeAll(async () => {
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `built extension not found at ${extensionPath} — run \`bun run build:e2e\` first`,
    );
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-chaos-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  await routeFixtures(context, { offline: () => offlineArmed });
  page = context.pages()[0] ?? (await context.newPage());
  driver = {
    async navigateToWatch(fixture, extra) {
      await page.goto(watchUrl(fixture, extra));
    },
    async readPillState(timeoutMs = 15_000) {
      await page.waitForFunction(
        () => window.__speedwatcherPill?.state != null,
        undefined,
        { timeout: timeoutMs },
      );
      return page.evaluate(() => window.__speedwatcherPill?.state ?? null);
    },
    async readCaptionSource(timeoutMs = 15_000) {
      await page.waitForFunction(
        () => window.__speedwatcherCaptionSource !== undefined,
        undefined,
        { timeout: timeoutMs },
      );
      return page.evaluate(
        () => (window.__speedwatcherCaptionSource as CaptionSource) ?? null,
      );
    },
    async readMeasurement(timeoutMs = 15_000) {
      await page.waitForFunction(
        () => window.__speedwatcherLastMeasure !== undefined,
        undefined,
        { timeout: timeoutMs },
      );
      return page.evaluate(() => window.__speedwatcherLastMeasure);
    },
    async peekCaptionSource() {
      return page.evaluate(
        () => (window.__speedwatcherCaptionSource as CaptionSource | undefined) ?? null,
      );
    },
  };
});

test.afterAll(async () => {
  await context?.close();
});

/** The tier read off the observable surface: word stats → asr-word, the
 * corrected label → manual-cue, the plain captions label → asr-cue, the
 * estimated label → estimated. */
function tierOf(pill: PillState, measure: Measurement | undefined): RateTier {
  if (typeof measure?.stats.word === 'number') return 'asr-word';
  if (pill.tierLabel === 'estimated') return 'estimated';
  return pill.tierLabel === 'from captions (corrected)' ? 'manual-cue' : 'asr-cue';
}

/** Assert one cell's observable contract: the caption source plus the tier
 * derived from the measure payload and the pill label. A null source
 * expectation asserts the hook's absence — the no-track page never sets it
 * (no fetch chain ran), so the read peeks instead of waiting. */
async function assertCell(
  expected: { source: CaptionSource | null; tier: RateTier; captionStatus?: CaptionStatus },
  timeoutMs: number,
): Promise<void> {
  const pill = await driver.readPillState(timeoutMs);
  const source =
    expected.source === null ? await driver.peekCaptionSource() : await driver.readCaptionSource(timeoutMs);
  if (pill === null || source !== expected.source) {
    throw new Error(
      `cell ${expected.source ?? 'no-source'}/${expected.tier}: pill=${pill === null ? 'null' : `mode ${pill.mode}`} ` +
        `source=${source} tierLabel=${pill?.tierLabel ?? 'undefined'}`,
    );
  }
  if (expected.captionStatus !== undefined && pill.captionStatus !== expected.captionStatus) {
    throw new Error(
      `cell ${expected.source ?? 'no-source'}/${expected.tier}: captionStatus ${pill.captionStatus ?? 'undefined'}, ` +
        `expected ${expected.captionStatus}`,
    );
  }
  if (expected.tier === 'estimated') {
    if (pill.tierLabel !== 'estimated') {
      throw new Error(`cell ${expected.source}/estimated: tierLabel ${pill.tierLabel}`);
    }
    return;
  }
  const tier = tierOf(pill, await driver.readMeasurement(timeoutMs));
  if (tier !== expected.tier) {
    throw new Error(`cell ${expected.source}/${expected.tier}: observed tier ${tier}`);
  }
}

interface MatrixCell {
  name: string;
  fixture: string;
  extra?: string;
  /** Null asserts the source hook's absence (the no-track page). */
  source: CaptionSource | null;
  tier: RateTier;
  /** The collapse reason the estimated tier must name (contract, not counts). */
  captionStatus?: CaptionStatus;
  /** Read timeout: the capture-miss cells render ~22s after navigation (the
   * 6s no-controls drive + the 15s capture window), the delayed ones later. */
  timeoutMs?: number;
}

const MATRIX: MatrixCell[] = [
  {
    name: 'capture absent, web ok: the WEB timedtext wins',
    fixture: 'real/asr-word.json',
    source: 'web',
    tier: 'asr-word',
  },
  {
    name: 'capture absent, web ok (manual track): WEB wins at the corrected cue tier',
    fixture: 'real/manual-cue.json',
    source: 'web',
    tier: 'manual-cue',
  },
  {
    name: 'capture present: the signed fetch beats every fallback',
    fixture: 'synthetic/pot-gated.json',
    source: 'capture',
    tier: 'asr-word',
  },
  {
    name: 'capture absent, web 200-empty, ANDROID params: get_transcript wins',
    fixture: 'synthetic/transcript-gated.json',
    source: 'android',
    tier: 'asr-cue',
  },
  {
    name: 'ANDROID LOGIN_REQUIRED: the WEB-params transcript resort wins',
    fixture: 'synthetic/transcript-gated.json',
    extra: 'loginrequired=1',
    source: 'android',
    tier: 'asr-cue',
  },
  {
    name: 'ANDROID track without params: the bare re-fetch 200-empties, the WEB-params resort wins',
    fixture: 'synthetic/transcript-gated.json',
    extra: 'androidnoparams=1',
    source: 'android',
    tier: 'asr-cue',
  },
  {
    name: 'transcript endpoint 500: every resort dies, the chain lands on none',
    fixture: 'synthetic/transcript-gated.json',
    extra: 'transcriptfail=1',
    source: 'none',
    tier: 'estimated',
    captionStatus: 'fetch-failed',
  },
  {
    name: 'ANDROID LOGIN_REQUIRED + transcript 500: none',
    fixture: 'synthetic/transcript-gated.json',
    extra: 'loginrequired=1&transcriptfail=1',
    source: 'none',
    tier: 'estimated',
    captionStatus: 'fetch-failed',
  },
  {
    name: 'ANDROID no params + no WEB panel: none',
    fixture: 'synthetic/transcript-gated.json',
    extra: 'androidnoparams=1&webnopanel=1',
    source: 'none',
    tier: 'estimated',
    captionStatus: 'fetch-failed',
  },
  {
    name: 'WEB 403 and no ANDROID player response: none',
    fixture: 'synthetic/web-blocked.json',
    source: 'none',
    tier: 'estimated',
    captionStatus: 'fetch-failed',
  },
  {
    // No caption track: the fetch chain never runs, so the source hook
    // stays unset — the cell asserts that absence plus the estimated pill
    // with its no-track collapse reason.
    name: 'no caption track at all: the estimated tier',
    fixture: 'synthetic/no-tracks.json',
    source: null,
    tier: 'estimated',
    captionStatus: 'no-track',
  },
  {
    // The chain-order discriminator: with the ANDROID response synthesized
    // on a web-ok fixture, both stages could serve a payload — the designed
    // order says WEB first. A web/android flip inverts this cell to
    // android/asr-cue (the get_transcript payload) — the fail-mode proof.
    name: 'both WEB and ANDROID could win: the designed order serves WEB first',
    fixture: 'real/asr-word.json',
    extra: 'androidtrack=1',
    source: 'web',
    tier: 'asr-word',
  },
];

test.describe('chaos permutation matrix', () => {
  for (const cell of MATRIX) {
    test(`${cell.name}: renders the designed source and tier`, async () => {
      await driver.navigateToWatch(cell.fixture, cell.extra);
      await assertCell(cell, cell.timeoutMs ?? 30_000);
    });
  }
});

test.describe('timing classes', () => {
  test('flaky network: a signed fetch landing inside the 15s window still wins as capture', async () => {
    await driver.navigateToWatch('synthetic/pot-gated.json', 'timedtextDelay=10000');
    await assertCell({ source: 'capture', tier: 'asr-word' }, 30_000);
  });

  test('flaky network: a signed fetch delayed past the 15s window degrades the chain — never wedges', async () => {
    // The capture lands at ~19s, the window closes at ~17s; the chain must
    // fall through (bare web 200-empty → ANDROID 400 → no WEB panel) to
    // none instead of hanging on the capture stage.
    await driver.navigateToWatch('synthetic/pot-gated.json', 'timedtextDelay=18000');
    await assertCell({ source: 'none', tier: 'estimated', captionStatus: 'fetch-failed' }, 60_000);
  });

  test('flaky network: a 429 on the ANDROID POST falls through to the WEB-params transcript', async () => {
    await driver.navigateToWatch('synthetic/transcript-gated.json', 'android429=1');
    await assertCell({ source: 'android', tier: 'asr-cue' }, 30_000);
  });

  test('offline class: the web-ok page degrades to none when every fetch fails', async () => {
    offlineArmed = true;
    try {
      await driver.navigateToWatch('real/asr-word.json');
      await assertCell({ source: 'none', tier: 'estimated', captionStatus: 'fetch-failed' }, 30_000);
    } finally {
      offlineArmed = false;
    }
  });

  test('offline class: the ANDROID-tail page degrades to none too', async () => {
    offlineArmed = true;
    try {
      await driver.navigateToWatch('synthetic/transcript-gated.json');
      await assertCell({ source: 'none', tier: 'estimated', captionStatus: 'fetch-failed' }, 30_000);
    } finally {
      offlineArmed = false;
    }
  });
});
