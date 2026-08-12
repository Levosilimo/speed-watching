// Shared E2E specs, framework-agnostic: the chromium runner drives them with
// Playwright, the firefox runner with selenium-webdriver. Each runner only
// supplies navigation + a way to read the page-side measurement payload.
//
// Everything is asserted against local fixtures (e2e/server.ts) — no real
// YouTube traffic. Expected wpm values are recomputed in this process from
// the same pure lib functions the content script uses, so the assertion is
// math-level: fixture JSON → reported wpm. Expected pill states are
// recomputed the same way (recommend() over the fixture's natural rate), so
// the pill specs assert that the content script ran the same math and that
// Apply really changes the fixture <video>'s playbackRate.
//
// The pill's shadow root is closed, so specs observe it through the content
// script's test hook (window.__speedwatcherPill: state + apply/dismiss),
// which invokes the exact handlers the pill buttons are wired to.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYouTubeJson3 } from '../../lib/captions';
import { priorMidpoint } from '../../lib/heuristics';
import { detectMusic } from '../../lib/music';
import { recommend, type Recommendation } from '../../lib/recommend';
import type { PillState } from '../../ui/pill';
import {
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  totalWords,
  wordLevelWpm,
} from '../../lib/wpm';
import type { MeasureEventDetail } from '../../entrypoints/content';
import { KIND_BY_FIXTURE } from './fixtures';

export type Measurement = MeasureEventDetail;

export type CaptionSource = 'web' | 'android' | 'none';

declare global {
  interface Window {
    __speedwatcherLastMeasure?: MeasureEventDetail;
  }
}

const fixtureRoot = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url));

export interface E2EDriver {
  /** Navigate to the fixture watch page at a *.youtube.com origin. */
  navigateToWatch(fixture: string): Promise<void>;
  /** Page-captured speedwatcher:measure payload, or undefined before it fires. */
  readMeasurement(): Promise<Measurement | undefined>;
  /** Current pill state (polls until the first update renders). */
  readPillState(): Promise<PillState | null>;
  /** Trigger the pill's Apply handler (same callback the Apply button fires). */
  applyPill(): Promise<void>;
  /** Trigger the pill's Dismiss handler. */
  dismissPill(): Promise<void>;
  /** The page's <video> playbackRate, or null when no video element exists. */
  readPlaybackRate(): Promise<number | null>;
  /** Which caption path served the page: 'web', 'android', or 'none'. */
  readCaptionSource(): Promise<CaptionSource | null>;
}

interface ExpectedStats {
  word?: number | null;
  cue?: number | null;
  corrected?: number | null;
  nWords: number;
}

/** The same tier selection the content script applies. */
function expectedStats(fixture: string): ExpectedStats {
  const json = JSON.parse(readFileSync(join(fixtureRoot, fixture), 'utf8')) as unknown;
  const { words, cues } = parseYouTubeJson3(json);
  if (words.length >= 2) {
    return {
      word: wordLevelWpm(words),
      cue: cueLevelWpm(cues),
      corrected: correctedCueLevelWpm(cues),
      nWords: totalWords(words),
    };
  }
  return {
    cue: cueLevelWpm(cues),
    corrected: correctedCueLevelWpm(cues),
    nWords: totalWords(cues),
  };
}

/** The recommendation the content script must produce for a fixture
 * (default settings: target 250, platformMax 2, no overrides). */
function expectedRecommendation(fixture: string): { rec: Recommendation; naturalRate: number } {
  const json = JSON.parse(readFileSync(join(fixtureRoot, fixture), 'utf8')) as unknown;
  const { cues } = parseYouTubeJson3(json);
  const kind = KIND_BY_FIXTURE[fixture];
  const naturalRate = kind === 'asr' ? filteredTokensOverTrimmedSpan(cues) : manualCueRate(cues);
  if (naturalRate === null) throw new Error(`${fixture}: no natural rate`);
  const detected = detectMusic(cues, naturalRate) ? 'music' : 'generic';
  const rec = recommend({
    naturalRate,
    tier: kind === 'asr' ? 'asr-cue' : 'manual-cue',
    contentType: detected,
    platformMax: 2,
  });
  return { rec, naturalRate };
}

const WPM_TOLERANCE = 0.5;
const RATE_TOLERANCE = 0.01;

/** The estimated-tier pill the content script must render when captions are
 * unavailable: generic-prior midpoint (no content-type signal in fixtures). */
function expectedEstimatedPill(): { rec: Recommendation; naturalRate: number } {
  const naturalRate = priorMidpoint('generic');
  return {
    rec: recommend({ naturalRate, tier: 'estimated', contentType: 'generic', platformMax: 2 }),
    naturalRate,
  };
}

function assertClose(actual: number | null | undefined, expected: number | null | undefined, label: string): void {
  if (actual === null || actual === undefined) {
    if (expected !== null && expected !== undefined) {
      throw new Error(`${label}: expected ${expected.toFixed(2)} wpm, got null`);
    }
    return;
  }
  if (expected === null || expected === undefined) {
    throw new Error(`${label}: expected null, got ${actual.toFixed(2)} wpm`);
  }
  if (Math.abs(actual - expected) > WPM_TOLERANCE) {
    throw new Error(
      `${label}: ${actual.toFixed(2)} wpm outside tolerance of ${expected.toFixed(2)} ± ${WPM_TOLERANCE}`,
    );
  }
}

export async function runMeasurementSpecs(driver: E2EDriver): Promise<void> {
  for (const fixture of ['real/asr-word.json', 'real/manual-cue.json']) {
    await driver.navigateToWatch(fixture);
    const measurement = await driver.readMeasurement();
    if (!measurement) throw new Error(`no speedwatcher:measure payload for ${fixture}`);
    const expected = expectedStats(fixture);
    assertClose(measurement.stats.word, expected.word, `${fixture} word-level`);
    assertClose(measurement.stats.cue, expected.cue, `${fixture} cue-level`);
    assertClose(measurement.stats.corrected, expected.corrected, `${fixture} corrected`);
    if (measurement.stats.nWords !== expected.nWords) {
      throw new Error(
        `${fixture}: nWords ${measurement.stats.nWords} !== expected ${expected.nWords}`,
      );
    }
    if (measurement.videoId !== 'e2e-fixture' || measurement.lang !== 'en') {
      throw new Error(`${fixture}: unexpected identity ${measurement.videoId}/${measurement.lang}`);
    }
  }
}

function expectState(state: PillState | null, fixture: string): PillState {
  if (state === null) throw new Error(`${fixture}: pill never rendered`);
  return state;
}

export async function runPillSpecs(driver: E2EDriver): Promise<void> {
  // (a) The pill renders the expected recommendation for both tiers.
  for (const fixture of ['real/asr-word.json', 'real/manual-cue.json']) {
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    const { rec, naturalRate } = expectedRecommendation(fixture);
    if (state.mode !== rec.mode) {
      throw new Error(`${fixture}: pill mode ${state.mode} !== expected ${rec.mode}`);
    }
    if (state.label !== rec.label) {
      throw new Error(`${fixture}: pill label "${state.label}" !== expected "${rec.label}"`);
    }
    if (Math.abs(state.multiplier - rec.multiplier) > 1e-9) {
      throw new Error(
        `${fixture}: pill multiplier ${state.multiplier} !== expected ${rec.multiplier}`,
      );
    }
    if (Math.abs(state.rateWpm - naturalRate) > WPM_TOLERANCE) {
      throw new Error(`${fixture}: pill rateWpm ${state.rateWpm} outside tolerance of ${naturalRate}`);
    }
    if (state.tierLabel !== rec.tierLabel) {
      throw new Error(`${fixture}: pill tierLabel ${state.tierLabel} !== expected ${rec.tierLabel}`);
    }
    const source = await driver.readCaptionSource();
    if (source !== 'web') throw new Error(`${fixture}: caption source ${source}, expected web`);
  }

  // (b) Apply sets the fixture <video>'s playbackRate to the recommendation.
  {
    const fixture = 'real/asr-word.json';
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    await driver.applyPill();
    const rate = await driver.readPlaybackRate();
    if (rate === null || Math.abs(rate - state.multiplier) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: playbackRate ${rate} after apply, expected ${state.multiplier} ± ${RATE_TOLERANCE}`,
      );
    }
  }

  // (c) Dismiss hides the pill (state flips to 'none').
  {
    const fixture = 'real/asr-word.json';
    await driver.navigateToWatch(fixture);
    expectState(await driver.readPillState(), fixture);
    await driver.dismissPill();
    const state = expectState(await driver.readPillState(), fixture);
    if (state.mode !== 'none') throw new Error(`${fixture}: pill still visible after dismiss`);
  }

  // (d) Music detection: mode 'music', Apply must not touch playbackRate.
  {
    const fixture = 'synthetic/music-lyrics.json';
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    if (state.mode !== 'music') throw new Error(`${fixture}: pill mode ${state.mode}, expected music`);
    if (!state.label.includes('music')) {
      throw new Error(`${fixture}: music label missing from "${state.label}"`);
    }
    await driver.applyPill();
    const rate = await driver.readPlaybackRate();
    if (rate === null || Math.abs(rate - 1) > RATE_TOLERANCE) {
      throw new Error(`${fixture}: Apply changed playbackRate to ${rate}, expected 1`);
    }
  }

  // (e) Unreachable: mode 'unreachable', Apply must not touch playbackRate.
  {
    const fixture = 'synthetic/word-level.json';
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    if (state.mode !== 'unreachable') {
      throw new Error(`${fixture}: pill mode ${state.mode}, expected unreachable`);
    }
    await driver.applyPill();
    const rate = await driver.readPlaybackRate();
    if (rate === null || Math.abs(rate - 1) > RATE_TOLERANCE) {
      throw new Error(`${fixture}: Apply changed playbackRate to ${rate}, expected 1`);
    }
  }

  // (f) WEB caption fetch blocked → ANDROID fallback attempted and failed →
  // no captions, so the pill falls back to the estimated tier. The ANDROID
  // POST itself is additionally asserted at the network layer by each runner.
  {
    const fixture = 'synthetic/web-blocked.json';
    await driver.navigateToWatch(fixture);
    const source = await driver.readCaptionSource();
    if (source !== 'none') {
      throw new Error(`${fixture}: caption source ${source}, expected none (WEB blocked)`);
    }
    const state = expectState(await driver.readPillState(), fixture);
    const { rec, naturalRate } = expectedEstimatedPill();
    if (state.mode !== rec.mode || state.tierLabel !== rec.tierLabel) {
      throw new Error(
        `${fixture}: pill ${state.mode}/${state.tierLabel}, expected ${rec.mode}/${rec.tierLabel}`,
      );
    }
    if (Math.abs(state.rateWpm - naturalRate) > WPM_TOLERANCE) {
      throw new Error(`${fixture}: pill rateWpm ${state.rateWpm}, expected ${naturalRate}`);
    }
  }

  // (g) No caption tracks at all → estimated tier from the generic prior.
  // The tierLabel assertion here is the firefox-side evidence; the local
  // counter increment is asserted chromium-only (e2e.spec.ts) because
  // WebDriver cannot read chrome.storage.
  {
    const fixture = 'synthetic/no-tracks.json';
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    const { rec, naturalRate } = expectedEstimatedPill();
    if (state.mode !== 'recommend') {
      throw new Error(`${fixture}: pill mode ${state.mode}, expected recommend`);
    }
    if (state.tierLabel !== 'estimated') {
      throw new Error(`${fixture}: pill tierLabel ${state.tierLabel}, expected estimated`);
    }
    if (Math.abs(state.rateWpm - naturalRate) > WPM_TOLERANCE) {
      throw new Error(`${fixture}: pill rateWpm ${state.rateWpm}, expected ${naturalRate}`);
    }
    if (state.label !== rec.label) {
      throw new Error(`${fixture}: pill label "${state.label}" !== expected "${rec.label}"`);
    }
  }
}
