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
import vttjs from 'vtt.js';
import { parseVtt, parseVttWords, type VttHost } from '../../lib/captions-harvest';
import { parseYouTubeJson3 } from '../../lib/captions';
import { chapteredInitialData, KIND_BY_FIXTURE, LANG_BY_FIXTURE } from './fixtures';
import { segmentRates, type RateSegment } from '../../lib/chapters';
import { priorMidpoint } from '../../lib/heuristics';
import { normalizeLanguageCode, resolveLanguage } from '../../lib/languages';
import { detectMusic } from '../../lib/music';
import { recommend, type RateTier, type Recommendation } from '../../lib/recommend';
import { defaultSettings, resolveUserTarget, type Settings } from '../../lib/settings';
import { defaultSkipSilence, pauseRateFor, type SkipSilencePrefs } from '../../lib/skip-silence';
import type { PillState } from '../../ui/pill';
import { chaptersOf } from '../../lib/youtube';
import {
  asrTierInputs,
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  totalWords,
  wordLevelWpm,
} from '../../lib/wpm';
import type { MeasureEventDetail } from '../../lib/measure-hooks';

export type Measurement = MeasureEventDetail;

export type CaptionSource = 'web' | 'android' | 'capture' | 'none';

declare global {
  interface Window {
    __speedwatcherLastMeasure?: MeasureEventDetail;
    __speedwatcherChapter?: {
      rates: RateSegment[];
      activeIndex: number;
      applyFor(sec: number): void;
    };
  }
}

const fixtureRoot = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url));

// vtt.js needs a window-ish host to create cues; node has no DOM, so the
// specs parse fixtures with the same minimal shim the unit tests use.
const VTT_HOST: VttHost = {
  VTTCue: vttjs.VTTCue,
  document: {
    createElement: (tagName: string) => ({
      tagName,
      style: {},
      children: [],
      appendChild() {},
      setAttribute() {},
    }),
  },
};

export interface E2EDriver {
  /** Navigate to the fixture watch page at a *.youtube.com origin; extra
   * appends raw query params (live=1, straybadge=1) for the fixture-server
   * variants. */
  navigateToWatch(fixture: string, extra?: string): Promise<void>;
  /** Page-captured speedwatcher:measure payload, or undefined before it fires. */
  readMeasurement(): Promise<Measurement | undefined>;
  /** Current pill state (polls until the first update renders). */
  readPillState(): Promise<PillState | null>;
  /** Trigger the pill's Apply handler (same callback the Apply button fires). */
  applyPill(): Promise<void>;
  /** Trigger the pill's Dismiss handler. */
  dismissPill(): Promise<void>;
  /** Trigger the pill's Stop-auto handler. */
  stopAuto(): Promise<void>;
  /** The page's <video> playbackRate (index picks the element on
   * multi-video pages), or null when no video element exists. */
  readPlaybackRate(index?: number): Promise<number | null>;
  /** Which caption path served the page: 'web', 'android', 'capture', or 'none'. */
  readCaptionSource(): Promise<CaptionSource | null>;
  /** Bare /api/timedtext fetch from the page (no pot params) — the
   * pot-gated fixture's gate is asserted through the same route the
   * content script's fetchJson3 used. */
  readBareTimedtext(fixture: string): Promise<{ status: number; body: string }>;
  /** The page's browser UI language (navigator.language) — the estimated
   * tier's UI-locale language fallback reads it, so the spec mirror needs
   * the same input the content script uses. */
  readBrowserLanguage(): Promise<string>;
  /** Navigate to the generic player fixture page (non-YouTube origin). */
  navigateToGeneric(): Promise<void>;
  /** Navigate to the Dzen-shaped track-src fixture page. */
  navigateToGenericDzen(): Promise<void>;
  /** Which caption tier the generic matcher rendered. */
  readCaptionTier(): Promise<RateTier | null>;
  /** Set the page video's playbackRate to 1 (simulates a player reset). */
  resetPlaybackRate(): Promise<void>;
  /** Set the page video's playbackRate to an explicit value (user manual). */
  setPlaybackRate(rate: number): Promise<void>;
  /** Navigate to a watch page with two <video> elements. */
  navigateToMultiVideo(fixture: string): Promise<void>;
  /** Dispatch a media event on the index-th <video> element. */
  fireMediaEvent(index: number, type: string): Promise<void>;
  /** Poll readPlaybackRate until it equals expected (re-assert evidence). */
  waitForPlaybackRate(expected: number, timeoutMs?: number): Promise<void>;
  /** Wait ms (for asserting that a stopped loop does NOT re-assert). */
  sleep(ms: number): Promise<void>;
  /** Write settings through the bridge — same path the options page uses. */
  writeSettings(settings: Settings): Promise<void>;
  /** Write skip-silence prefs through the bridge (mirror of writeSettings). */
  writeSkipPrefs(prefs: SkipSilencePrefs): Promise<void>;
  /** Simulate a live stream: the player badge + a navigation cycle that
   * re-measures (the content script suppresses the pill on live). */
  setLiveStream(): Promise<void>;
  /** The chapter hook: the per-chapter plan and the enforced segment index. */
  readChapterHook(): Promise<{
    rates: Array<{ startSec: number; endSec: number; multiplier: number; mode: string }>;
    activeIndex: number;
  } | null>;
  /** Seek the fixture video and fire the scheduler's timeupdate tick. */
  chapterApplyFor(sec: number): Promise<void>;
  /** Toggle chapter consent via the pill's toggle button (waits for it). */
  setChapterConsent(enabled: boolean): Promise<void>;
}

interface ExpectedStats {
  word?: number | null;
  cue?: number | null;
  corrected?: number | null;
  nWords: number;
}

/** The same tier selection the content script applies. */
export function expectedStats(fixture: string): ExpectedStats {
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
 * (default settings: platformMax 2, no overrides). Mirror of
 * entrypoints/content.ts: the track language feeds the rate measurement and
 * the unit label, the settings target rides through resolveUserTarget —
 * unset under default settings, so the language model's own target applies
 * on language tracks (en 250, ja 470 morae/min) — and word-timed ASR
 * tracks carry the articulatory inputs that can fire the pause-diluted
 * warning. */
export function expectedRecommendation(fixture: string): { rec: Recommendation; naturalRate: number } {
  const json = JSON.parse(readFileSync(join(fixtureRoot, fixture), 'utf8')) as unknown;
  const { words, cues } = parseYouTubeJson3(json);
  const kind = KIND_BY_FIXTURE[fixture];
  const language = resolveLanguage(LANG_BY_FIXTURE[fixture]) ?? undefined;
  const naturalRate =
    kind === 'asr' ? filteredTokensOverTrimmedSpan(cues, language) : manualCueRate(cues, language);
  if (naturalRate === null) throw new Error(`${fixture}: no natural rate`);
  const detected = detectMusic(cues, naturalRate) ? 'music' : 'generic';
  const { tier, wordInputs } = asrTierInputs(kind, words, cues);
  const rec = recommend({
    naturalRate,
    tier,
    contentType: detected,
    platformMax: 2,
    userTarget: resolveUserTarget(defaultSettings(), 'youtube.com', detected),
    language,
    ...wordInputs,
  });
  return { rec, naturalRate };
}

const WPM_TOLERANCE = 0.5;
const RATE_TOLERANCE = 0.01;

/** The estimated-tier pill the content script must render when captions are
 * unavailable: generic-prior midpoint (no content-type signal in fixtures),
 * with the UI-locale language fallback mirroring entrypoints/content.ts —
 * no track language → navigator.language's model drives the math and the
 * displayed range. The e2e browsers run en-US, so the en fixtures stay
 * byte-identical. */
export function expectedEstimatedPill(browserLanguage: string): { rec: Recommendation; naturalRate: number } {
  const naturalRate = priorMidpoint('generic');
  const language = resolveLanguage(normalizeLanguageCode(browserLanguage) ?? undefined) ?? undefined;
  return {
    rec: recommend({ naturalRate, tier: 'estimated', contentType: 'generic', platformMax: 2, language }),
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
  // (a) The pill renders the expected recommendation for all three tiers.
  for (const fixture of [
    'real/asr-word.json',
    'real/manual-cue.json',
    'synthetic/ja-captions.json',
  ]) {
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    const { rec, naturalRate } = expectedRecommendation(fixture);
    if (state.mode !== rec.mode) {
      throw new Error(`${fixture}: pill mode ${state.mode} !== expected ${rec.mode}`);
    }
    if (state.label !== rec.label) {
      throw new Error(`${fixture}: pill label "${state.label}" !== expected "${rec.label}"`);
    }
    // Language-unit label end-to-end: the ja fixture must render in the
    // resolved language's unit, not wpm.
    if (fixture === 'synthetic/ja-captions.json' && !state.label.includes('morae/min')) {
      throw new Error(`${fixture}: pill label "${state.label}" missing the morae/min unit`);
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
    // The warning reason (pause-diluted on word-timed ASR) must survive the
    // whole pipeline into the pill state — the e2e half of the production
    // wiring for the articulatory warning. The hook serializes undefined as
    // an absent field, so normalize before comparing.
    if ((state.reason ?? null) !== rec.reason) {
      throw new Error(`${fixture}: pill reason ${state.reason} !== expected ${rec.reason}`);
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
    const { rec, naturalRate } = expectedEstimatedPill(await driver.readBrowserLanguage());
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
    const { rec, naturalRate } = expectedEstimatedPill(await driver.readBrowserLanguage());
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

/**
 * Pot-gated caption e2e (the logged-in POT failure): the fixture server
 * pays payloads only to signed timedtext requests (pot/potc params); a bare
 * fetch 200-empties. (a) proves the gate is real through the harness route;
 * (b) proves the capture-first path measures from the player's signed
 * fetch — the fail-without-fix lane: before the content-script wiring, the
 * bare fetch 200-empties and the pill lands on the estimated tier.
 */
export async function runCaptureSpecs(driver: E2EDriver): Promise<void> {
  const fixture = 'synthetic/pot-gated.json';

  // (a) The gate is real in the harness: a bare timedtext fetch (the old
  // fetchJson3 shape, no pot) is HTTP 200 with an empty body. Runs from the
  // watch page so the relative fetch resolves against the youtube origin.
  await driver.navigateToWatch(fixture);
  const bare = await driver.readBareTimedtext(fixture);
  if (bare.status !== 200 || bare.body !== '') {
    throw new Error(
      `pot-gated: bare timedtext returned ${bare.status}/${JSON.stringify(bare.body.slice(0, 40))}, expected 200/empty`,
    );
  }

  // (b) Fresh navigation: the capture path below must measure from scratch.
  await driver.navigateToWatch(fixture);
  const state = expectState(await driver.readPillState(), fixture);
  const source = await driver.readCaptionSource();
  if (source !== 'capture') {
    throw new Error(`${fixture}: caption source ${source}, expected capture`);
  }
  const { rec, naturalRate } = expectedRecommendation(fixture);
  if (state.mode !== rec.mode) {
    throw new Error(`${fixture}: pill mode ${state.mode} !== expected ${rec.mode}`);
  }
  if (state.tierLabel !== rec.tierLabel) {
    throw new Error(`${fixture}: pill tierLabel ${state.tierLabel} !== expected ${rec.tierLabel}`);
  }
  if (Math.abs(state.rateWpm - naturalRate) > WPM_TOLERANCE) {
    throw new Error(`${fixture}: pill rateWpm ${state.rateWpm} outside tolerance of ${naturalRate}`);
  }
  if (Math.abs(state.multiplier - rec.multiplier) > 1e-9) {
    throw new Error(
      `${fixture}: pill multiplier ${state.multiplier} !== expected ${rec.multiplier}`,
    );
  }
  // The word-timed measurement itself (not just the pill): the captured
  // payload must have produced the word-level rate of the fixture.
  const measurement = await driver.readMeasurement();
  if (measurement === undefined) {
    throw new Error(`${fixture}: no speedwatcher:measure payload`);
  }
  const expected = expectedStats(fixture);
  assertClose(measurement.stats.word, expected.word, `${fixture} captured word-level`);
  if (measurement.stats.nWords !== expected.nWords) {
    throw new Error(
      `${fixture}: nWords ${measurement.stats.nWords} !== expected ${expected.nWords}`,
    );
  }
}

/** The recommendation the generic matcher must produce from the talk
 * fixture: harvest the HLS subtitle track, measure the manual-cue rate,
 * recommend with default settings (mirror of entrypoints/generic.content.ts). */
function expectedGenericRecommendation(): { rec: Recommendation; naturalRate: number } {
  const vtt = readFileSync(join(fixtureRoot, 'synthetic/hls/talk/talk.vtt'), 'utf8');
  const segments = parseVtt(vtt, VTT_HOST);
  const naturalRate = manualCueRate(segments);
  if (naturalRate === null) throw new Error('talk.vtt: no natural rate');
  const rec = recommend({ naturalRate, tier: 'manual-cue', contentType: 'generic', platformMax: 2 });
  return { rec, naturalRate };
}

/** The recommendation the generic matcher must produce from the Dzen
 * fixture: the track-src probe yields word timings + cues from the VTT, the
 * asr branch measures the presentation rate over the cues and renders
 * asr-word (mirror of entrypoints/generic.content.ts). The fixture page's
 * track declares srclang="ru", so the ru language model (target 168) must
 * drive the recommendation — the multiplier assertion is the end-to-end
 * proof of the language resolution. */
function expectedDzenRecommendation(): { rec: Recommendation; naturalRate: number } {
  const vtt = readFileSync(join(fixtureRoot, 'synthetic/dzen-word.vtt'), 'utf8');
  const words = parseVttWords(vtt, VTT_HOST);
  const cues = parseVtt(vtt, VTT_HOST);
  const language = resolveLanguage('ru') ?? undefined;
  const naturalRate = filteredTokensOverTrimmedSpan(cues, language);
  if (naturalRate === null) throw new Error('dzen-word.vtt: no natural rate');
  const detected = detectMusic(cues, naturalRate, language?.unit ?? 'wpm') ? 'music' : 'generic';
  const { tier, wordInputs } = asrTierInputs('asr', words, cues);
  const rec = recommend({
    naturalRate,
    tier,
    contentType: detected,
    platformMax: 2,
    language,
    ...wordInputs,
  });
  return { rec, naturalRate };
}

/** Generic matcher e2e: harvest → pill → apply → re-assert → dismiss stops
 * the loop. The re-apply evidence is behavioral: after a simulated player
 * reset the rate must come back, and after dismiss it must stay. */
export async function runGenericSpecs(driver: E2EDriver): Promise<void> {
  // (a) The matcher harvests the HLS subtitle track and renders a tier-2 pill.
  await driver.navigateToGeneric();
  const state = expectState(await driver.readPillState(), 'generic');
  const { rec, naturalRate } = expectedGenericRecommendation();
  if (state.mode !== rec.mode) {
    throw new Error(`generic: pill mode ${state.mode} !== expected ${rec.mode}`);
  }
  if (state.tierLabel !== rec.tierLabel) {
    throw new Error(`generic: pill tierLabel ${state.tierLabel} !== expected ${rec.tierLabel}`);
  }
  if (Math.abs(state.rateWpm - naturalRate) > WPM_TOLERANCE) {
    throw new Error(`generic: pill rateWpm ${state.rateWpm} outside tolerance of ${naturalRate}`);
  }
  if (Math.abs(state.multiplier - rec.multiplier) > 1e-9) {
    throw new Error(`generic: pill multiplier ${state.multiplier} !== expected ${rec.multiplier}`);
  }
  const tier = await driver.readCaptionTier();
  if (tier !== 'manual-cue') {
    throw new Error(`generic: caption tier ${tier}, expected manual-cue`);
  }

  // (b) Apply sets the fixture video's playbackRate.
  await driver.applyPill();
  const applied = await driver.readPlaybackRate();
  if (applied === null || Math.abs(applied - state.multiplier) > RATE_TOLERANCE) {
    throw new Error(
      `generic: playbackRate ${applied} after apply, expected ${state.multiplier} ± ${RATE_TOLERANCE}`,
    );
  }

  // (c) Re-apply loop: a player-style reset (rate → 1) must be re-asserted.
  await driver.resetPlaybackRate();
  await driver.waitForPlaybackRate(state.multiplier);

  // (d) A user's manual rate is respected: the loop only re-asserts resets
  // to 1.0, so a manual 1.25 must stick past a re-check interval.
  await driver.setPlaybackRate(1.25);
  await driver.sleep(3500); // > one re-check interval (2s)
  const manual = await driver.readPlaybackRate();
  if (manual === null || Math.abs(manual - 1.25) > RATE_TOLERANCE) {
    throw new Error(
      `generic: playbackRate ${manual} after manual 1.25, expected 1.25 (loop must not fight the user)`,
    );
  }

  // (e) Dismiss stops the loop: after dismiss, a reset sticks.
  await driver.dismissPill();
  await driver.resetPlaybackRate();
  await driver.sleep(3500); // > one re-check interval (2s)
  const after = await driver.readPlaybackRate();
  if (after === null || Math.abs(after - 1) > RATE_TOLERANCE) {
    throw new Error(`generic: playbackRate ${after} after dismiss + reset, expected 1 (loop stopped)`);
  }

  // (f) Dzen-shaped fixture: the track-src probe yields word timings from
  // the inline VTT runs, so the matcher renders the asr-word tier and the
  // srclang="ru" track resolution lands the recommendation on the ru
  // language model (target 168, not the 250 default).
  await driver.navigateToGenericDzen();
  const dzenState = expectState(await driver.readPillState(), 'generic-dzen');
  const dzenExpected = expectedDzenRecommendation();
  if (dzenState.mode !== dzenExpected.rec.mode) {
    throw new Error(
      `generic-dzen: pill mode ${dzenState.mode} !== expected ${dzenExpected.rec.mode}`,
    );
  }
  if (dzenState.tierLabel !== dzenExpected.rec.tierLabel) {
    throw new Error(
      `generic-dzen: pill tierLabel ${dzenState.tierLabel} !== expected ${dzenExpected.rec.tierLabel}`,
    );
  }
  if (Math.abs(dzenState.rateWpm - dzenExpected.naturalRate) > WPM_TOLERANCE) {
    throw new Error(
      `generic-dzen: pill rateWpm ${dzenState.rateWpm} outside tolerance of ${dzenExpected.naturalRate}`,
    );
  }
  if (Math.abs(dzenState.multiplier - dzenExpected.rec.multiplier) > 1e-9) {
    throw new Error(
      `generic-dzen: pill multiplier ${dzenState.multiplier} !== expected ${dzenExpected.rec.multiplier}`,
    );
  }
  const dzenTier = await driver.readCaptionTier();
  if (dzenTier !== 'asr-word') {
    throw new Error(`generic-dzen: caption tier ${dzenTier}, expected asr-word`);
  }
}

/** Multi-video watch page: the active element follows the video that
 * actually plays, and Apply targets only that element. */
export async function runMultiVideoSpecs(driver: E2EDriver): Promise<void> {
  const fixture = 'real/asr-word.json';
  await driver.navigateToMultiVideo(fixture);
  const state = expectState(await driver.readPillState(), fixture);
  await driver.fireMediaEvent(1, 'playing');
  await driver.applyPill();
  const first = await driver.readPlaybackRate(0);
  const second = await driver.readPlaybackRate(1);
  if (first === null || Math.abs(first - 1) > RATE_TOLERANCE) {
    throw new Error(
      `multi-video: video[0] playbackRate ${first} after apply on video[1], expected 1 (untouched)`,
    );
  }
  if (second === null || Math.abs(second - state.multiplier) > RATE_TOLERANCE) {
    throw new Error(
      `multi-video: video[1] playbackRate ${second}, expected ${state.multiplier} (the playing video)`,
    );
  }
}

/** Settings write through the bridge, asserted via the pill. In Firefox the
 * bridge shares the page world with the measurement script (no isolated
 * worlds), so this spec is the single-world hardening evidence. */
export async function runBridgeSpecs(driver: E2EDriver): Promise<void> {
  const fixture = 'real/asr-word.json';
  await driver.navigateToWatch(fixture);
  // Wait for the content script (and its settings hook) to be up before
  // writing through it.
  expectState(await driver.readPillState(), fixture);
  // Deliberately omits autoApply — pre-auto-apply payloads must keep
  // validating (isSettingsPayload's optional-only check).
  await driver.writeSettings({
    target: 300,
    conservative: false,
    platformMax: 2,
    // Strict validator: the provider toggle is a required boolean field.
    externalApiEnabled: false,
    sites: {},
    contentTypes: {},
  } as Settings);
  try {
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    // 300 / 160.25 rounded to 0.05 → 1.85; the default target would give 1.55.
    if (Math.abs(state.multiplier - 1.85) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: pill multiplier ${state.multiplier}, expected 1.85 from bridge-written settings`,
      );
    }
  } finally {
    await driver.writeSettings(defaultSettings());
  }
}

/** Auto-apply e2e: opt-in settings force a recommend-mode fixture to apply
 * itself on navigation; estimated/music stay pill-only; Stop-auto and a
 * manual rate change disengage per video; the generic path adds the sentinel
 * re-assert and the loop detach. Note: real/asr-word.json renders the
 * pause-diluted WARNING under default settings, so the recommend-mode
 * assertions use real/manual-cue.json (manual-cue tier) — the warning path
 * is covered by shouldAutoApply's unit tests. The watch fixture's video
 * never plays, so the applied 'user' relabel (markUserOverride gates on
 * paused) is asserted on the generic page, whose video autoplays. */
export async function runAutoSpecs(driver: E2EDriver): Promise<void> {
  const fixture = 'real/manual-cue.json';
  // Ensure the content script is up before writing through its hook.
  await driver.navigateToWatch(fixture);
  expectState(await driver.readPillState(), fixture);
  try {
    await driver.writeSettings({
      ...defaultSettings(),
      contentType: 'talk',
      autoApply: { enabled: true, contentTypes: {} },
    });
    // (a) Auto-apply on navigation: the recommend-mode recommendation lands
    // without an Apply click and the pill reports applied 'auto'.
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    if (state.mode !== 'recommend') {
      throw new Error(`${fixture}: pill mode ${state.mode}, expected recommend (auto candidate)`);
    }
    if (state.applied !== 'auto') {
      throw new Error(`${fixture}: pill applied ${state.applied}, expected auto`);
    }
    const rate = await driver.readPlaybackRate();
    if (rate === null || Math.abs(rate - state.multiplier) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: playbackRate ${rate} without Apply, expected ${state.multiplier} ± ${RATE_TOLERANCE}`,
      );
    }

    // (b) Estimated tier stays pill-only: no caption tracks → rate 1, not auto.
    {
      const estFixture = 'synthetic/no-tracks.json';
      await driver.navigateToWatch(estFixture);
      const est = expectState(await driver.readPillState(), estFixture);
      if (est.applied === 'auto') {
        throw new Error(`${estFixture}: estimated tier auto-applied (safety rule)`);
      }
      const estRate = await driver.readPlaybackRate();
      if (estRate === null || Math.abs(estRate - 1) > RATE_TOLERANCE) {
        throw new Error(`${estFixture}: playbackRate ${estRate}, expected 1 (estimated never auto)`);
      }
    }

    // (c) Music never auto-applies.
    {
      const musicFixture = 'synthetic/music-lyrics.json';
      await driver.navigateToWatch(musicFixture);
      const music = expectState(await driver.readPillState(), musicFixture);
      if (music.applied === 'auto') {
        throw new Error(`${musicFixture}: music auto-applied (safety rule)`);
      }
      const musicRate = await driver.readPlaybackRate();
      if (musicRate === null || Math.abs(musicRate - 1) > RATE_TOLERANCE) {
        throw new Error(`${musicFixture}: playbackRate ${musicRate}, expected 1 (music never auto)`);
      }
    }

    // (d) Stop-auto: rate untouched, applied 'none'; auto returns on the next
    // video (per-video opt-in — navigation arms a fresh lifecycle).
    await driver.navigateToWatch(fixture);
    const before = expectState(await driver.readPillState(), fixture);
    if (before.applied !== 'auto') {
      throw new Error(`${fixture}: pill applied ${before.applied}, expected auto before stop-auto`);
    }
    await driver.stopAuto();
    const stopped = expectState(await driver.readPillState(), fixture);
    if (stopped.applied !== 'none') {
      throw new Error(`${fixture}: pill applied ${stopped.applied}, expected none after stop-auto`);
    }
    // P1a: stop-auto in the auto state is the undo — the pre-auto rate (1,
    // the fixture never played) is restored, not left at the auto rate.
    const stoppedRate = await driver.readPlaybackRate();
    if (stoppedRate === null || Math.abs(stoppedRate - 1) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: playbackRate ${stoppedRate} after stop-auto, expected 1 (pre-auto rate restored)`,
      );
    }
    await driver.navigateToWatch(fixture);
    const after = expectState(await driver.readPillState(), fixture);
    if (after.applied !== 'auto') {
      throw new Error(`${fixture}: auto did not re-arm on the next video (per-video opt-in)`);
    }

    // (e) Manual rate change is respected on youtube: the rate sticks (no
    // loop exists to fight it). The applied 'user' relabel needs a PLAYING
    // video (markUserOverride gates on paused, and the watch fixture never
    // plays) — that assertion lives in the generic sub-spec (f) below.
    await driver.navigateToWatch(fixture);
    const auto = expectState(await driver.readPillState(), fixture);
    if (auto.applied !== 'auto') {
      throw new Error(`${fixture}: pill applied ${auto.applied}, expected auto before override`);
    }
    await driver.setPlaybackRate(1.25);
    const manualRate = await driver.readPlaybackRate();
    if (manualRate === null || Math.abs(manualRate - 1.25) > RATE_TOLERANCE) {
      throw new Error(`${fixture}: playbackRate ${manualRate}, expected 1.25 (manual change must stick)`);
    }
    await driver.navigateToWatch(fixture);
    const fresh = expectState(await driver.readPillState(), fixture);
    if (fresh.applied !== 'auto') {
      throw new Error(`${fixture}: auto did not re-arm after a manual rate change (next video)`);
    }

    // (f) Generic path: auto applies on the talk fixture with the forced
    // content type; the sentinel re-asserts a reset to 1.0; a manual non-1.0
    // rate is respected and labels the source 'user' (the fixture video
    // plays, so the override detection runs); Stop-auto detaches the loop so
    // a later reset sticks; the next video re-arms.
    await driver.navigateToGeneric();
    const g = expectState(await driver.readPillState(), 'generic-auto');
    if (g.applied !== 'auto') {
      throw new Error(`generic: pill applied ${g.applied}, expected auto`);
    }
    const gRate = await driver.readPlaybackRate();
    if (gRate === null || Math.abs(gRate - g.multiplier) > RATE_TOLERANCE) {
      throw new Error(
        `generic: playbackRate ${gRate} without Apply, expected ${g.multiplier} ± ${RATE_TOLERANCE}`,
      );
    }
    await driver.resetPlaybackRate();
    await driver.waitForPlaybackRate(g.multiplier);
    await driver.setPlaybackRate(1.25);
    await driver.sleep(3500); // > one re-check interval (2s)
    const gManual = await driver.readPlaybackRate();
    if (gManual === null || Math.abs(gManual - 1.25) > RATE_TOLERANCE) {
      throw new Error(
        `generic: playbackRate ${gManual} after manual 1.25, expected 1.25 (loop must not fight the user)`,
      );
    }
    const gUser = expectState(await driver.readPillState(), 'generic-auto');
    if (gUser.applied !== 'user') {
      throw new Error(`generic: pill applied ${gUser.applied}, expected user after manual rate`);
    }
    // E1: the override itself must have detached the re-assert loop — a
    // later reset to 1.0 sticks (without the fix the sentinel re-asserts the
    // old auto rate and fights the reset).
    await driver.resetPlaybackRate();
    await driver.sleep(3500); // > one re-check interval (2s)
    const gReset = await driver.readPlaybackRate();
    if (gReset === null || Math.abs(gReset - 1) > RATE_TOLERANCE) {
      throw new Error(
        `generic: playbackRate ${gReset} after override + reset, expected 1 (loop detached by the override)`,
      );
    }
    await driver.stopAuto();
    await driver.resetPlaybackRate();
    await driver.sleep(3500); // > one re-check interval (2s)
    const gAfter = await driver.readPlaybackRate();
    if (gAfter === null || Math.abs(gAfter - 1) > RATE_TOLERANCE) {
      throw new Error(
        `generic: playbackRate ${gAfter} after stop-auto + reset, expected 1 (loop detached)`,
      );
    }
    await driver.navigateToGeneric();
    const gFresh = expectState(await driver.readPillState(), 'generic-auto');
    if (gFresh.applied !== 'auto') {
      throw new Error(`generic: auto did not re-arm on the next video (per-video opt-in)`);
    }
  } finally {
    // The settings hook lives on youtube pages only — land back there before
    // restoring, whatever page the last sub-spec ended on.
    await driver.navigateToWatch(fixture);
    expectState(await driver.readPillState(), fixture);
    await driver.writeSettings(defaultSettings());
  }
}

/**
 * Chaptered-fixture e2e: the consent toggle arms the scheduler, boundary
 * steps land the segment multipliers, and a manual rate yields until the
 * next boundary. Expected rates are recomputed from the same pure lib
 * functions the content script uses (segmentRates over the fixture's cues
 * and the chaptered initial data), so the assertions are math-level.
 * The fixture video never plays — the driver crosses boundaries through
 * the __speedwatcherChapter hook's applyFor (currentTime + timeupdate).
 */
function expectedChapterPlan(fixture: string): {
  rates: RateSegment[];
  whole: Recommendation;
} {
  const json = JSON.parse(readFileSync(join(fixtureRoot, fixture), 'utf8')) as unknown;
  const { words, cues } = parseYouTubeJson3(json);
  const chapters = chaptersOf(chapteredInitialData(fixture));
  if (chapters === null) throw new Error(`${fixture}: no chapters in the chaptered initial data`);
  const kind = KIND_BY_FIXTURE[fixture] ?? 'manual';
  const naturalRate =
    kind === 'asr' ? filteredTokensOverTrimmedSpan(cues) : manualCueRate(cues);
  if (naturalRate === null) throw new Error(`${fixture}: no natural rate`);
  const { tier } = asrTierInputs(kind, words, cues);
  const whole = recommend({
    naturalRate,
    tier,
    contentType: 'generic',
    platformMax: 2,
    userTarget: resolveUserTarget(defaultSettings(), 'youtube.com', 'generic'),
  });
  const rates = segmentRates(cues, chapters, kind, undefined, {
    platformMax: 2,
    contentType: 'generic',
    userTarget: resolveUserTarget(defaultSettings(), 'youtube.com', 'generic'),
  });
  // The plan must actually diverge per segment — otherwise the step
  // assertions below cannot distinguish a working scheduler from a no-op.
  const multipliers = new Set(rates.map((rate) => rate.multiplier));
  if (multipliers.size < 3) {
    throw new Error(`${fixture}: segment multipliers must diverge: ${JSON.stringify(rates)}`);
  }
  if (!rates.some((rate) => rate.mode === 'music')) {
    throw new Error(`${fixture}: expected a music segment in the plan`);
  }
  return { rates, whole };
}

export async function runChapterSpecs(driver: E2EDriver): Promise<void> {
  const fixture = 'synthetic/chaptered.json';
  const { rates, whole } = expectedChapterPlan(fixture);
  const first = rates[0]!;
  const music = rates[1]!;
  const last = rates[2]!;

  // (a) The pill advertises the toggle and the hook exposes the plan; a
  // fixture without chapter markers exposes neither.
  await driver.navigateToWatch(fixture);
  const state = expectState(await driver.readPillState(), fixture);
  if (state.chaptersAvailable !== true) {
    throw new Error(`${fixture}: chaptersAvailable ${state.chaptersAvailable}, expected true`);
  }
  if (state.autoAdjust === true) {
    throw new Error(`${fixture}: autoAdjust true before any consent`);
  }
  const hook = await driver.readChapterHook();
  if (hook === null) throw new Error(`${fixture}: chapter hook missing`);
  if (hook.activeIndex !== -1) {
    throw new Error(`${fixture}: activeIndex ${hook.activeIndex}, expected -1 before any tick`);
  }
  const multOf = (list: typeof hook.rates): number[] => list.map((rate) => rate.multiplier);
  if (JSON.stringify(multOf(hook.rates)) !== JSON.stringify(rates.map((rate) => rate.multiplier))) {
    throw new Error(
      `${fixture}: hook rates ${JSON.stringify(multOf(hook.rates))}, expected ${JSON.stringify(rates.map((rate) => rate.multiplier))}`,
    );
  }
  await driver.navigateToWatch('real/asr-word.json');
  const plain = expectState(await driver.readPillState(), 'real/asr-word.json');
  if (plain.chaptersAvailable === true) {
    throw new Error('real/asr-word.json: chaptersAvailable true without chapter markers');
  }

  // (b) No consent: even with auto-apply holding the whole-video rate, a
  // boundary crossing leaves the rate untouched.
  await driver.navigateToWatch(fixture);
  expectState(await driver.readPillState(), fixture);
  try {
    await driver.writeSettings({
      ...defaultSettings(),
      contentType: 'talk',
      autoApply: { enabled: true, contentTypes: {} },
    });
    await driver.navigateToWatch(fixture);
    const auto = expectState(await driver.readPillState(), fixture);
    if (auto.applied !== 'auto') {
      throw new Error(`${fixture}: pill applied ${auto.applied}, expected auto before the no-consent step`);
    }
    await driver.waitForPlaybackRate(whole.multiplier);
    await driver.chapterApplyFor(40); // crosses into the music segment
    const untouched = await driver.readPlaybackRate();
    if (untouched === null || Math.abs(untouched - whole.multiplier) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: rate ${untouched} after a boundary without consent, expected ${whole.multiplier} (no step without consent)`,
      );
    }
  } finally {
    await driver.writeSettings(defaultSettings());
  }

  // (c) Consent on: the scheduler steps to each segment's multiplier on
  // boundary crossings; the music segment lands at 1×.
  await driver.navigateToWatch(fixture);
  expectState(await driver.readPillState(), fixture);
  await driver.setChapterConsent(true);
  const consented = expectState(await driver.readPillState(), fixture);
  if (consented.autoAdjust !== true) {
    throw new Error(`${fixture}: autoAdjust ${consented.autoAdjust}, expected true after the toggle`);
  }
  const idle = await driver.readPlaybackRate();
  if (idle === null || Math.abs(idle - 1) > RATE_TOLERANCE) {
    throw new Error(`${fixture}: consent alone changed the rate to ${idle}, expected 1`);
  }
  await driver.chapterApplyFor(10);
  await driver.waitForPlaybackRate(first.multiplier);
  await driver.chapterApplyFor(40);
  await driver.waitForPlaybackRate(music.multiplier);
  const musicState = expectState(await driver.readPillState(), fixture);
  if (musicState.chapterStatus !== 'music') {
    throw new Error(`${fixture}: pill chapterStatus ${musicState.chapterStatus}, expected music`);
  }
  const musicHook = await driver.readChapterHook();
  if (musicHook === null || musicHook.activeIndex !== 1) {
    throw new Error(`${fixture}: activeIndex ${musicHook?.activeIndex}, expected 1 in the music segment`);
  }
  await driver.chapterApplyFor(70);
  await driver.waitForPlaybackRate(last.multiplier);

  // (d) A manual rate yields the scheduler until the next boundary; the
  // pill shows the paused status.
  await driver.chapterApplyFor(10);
  await driver.waitForPlaybackRate(first.multiplier);
  await driver.setPlaybackRate(1.25);
  const manual = await driver.readPlaybackRate();
  if (manual === null || Math.abs(manual - 1.25) > RATE_TOLERANCE) {
    throw new Error(`${fixture}: playbackRate ${manual}, expected 1.25 after the manual change`);
  }
  await driver.chapterApplyFor(20); // same segment — no boundary to step on
  const held = await driver.readPlaybackRate();
  if (held === null || Math.abs(held - 1.25) > RATE_TOLERANCE) {
    throw new Error(
      `${fixture}: playbackRate ${held} after an in-segment tick, expected 1.25 (yielded scheduler must not re-assert)`,
    );
  }
  const yieldedState = expectState(await driver.readPillState(), fixture);
  if (yieldedState.chapterStatus !== 'yielded') {
    throw new Error(`${fixture}: pill chapterStatus ${yieldedState.chapterStatus}, expected yielded`);
  }
  await driver.chapterApplyFor(40); // the next boundary re-arms the plan
  await driver.waitForPlaybackRate(music.multiplier);

  // (e) Consent off stops the scheduler: a later boundary does nothing.
  await driver.setChapterConsent(false);
  const off = expectState(await driver.readPillState(), fixture);
  if (off.autoAdjust !== false) {
    throw new Error(`${fixture}: autoAdjust ${off.autoAdjust}, expected false after the toggle`);
  }
  await driver.chapterApplyFor(70);
  const stopped = await driver.readPlaybackRate();
  if (stopped === null || Math.abs(stopped - music.multiplier) > RATE_TOLERANCE) {
    throw new Error(
      `${fixture}: rate ${stopped} after a boundary with consent off, expected ${music.multiplier} (scheduler stopped)`,
    );
  }
}

/**
 * Skip-silence e2e: with the toggle on and a rate applied, a timeupdate
 * inside the fixture's caption gap dips the rate to the pause target and
 * restores the applied rate outside it; the toggle off never dips; music
 * and live streams are no-ops. Expected rates are recomputed from the same
 * pure lib functions the content script uses (recommend over the fixture,
 * pauseRateFor over the applied multiplier), so the assertions are
 * math-level. The fixture video never plays — the driver steps through
 * time with the chapter hook's applyFor (currentTime + timeupdate).
 */
export async function runSkipSpecs(driver: E2EDriver): Promise<void> {
  const fixture = 'synthetic/gapped.json';
  const on = { ...defaultSkipSilence(), enabled: true };
  await driver.navigateToWatch(fixture);
  expectState(await driver.readPillState(), fixture);
  try {
    // (a) Toggle on: apply, step inside the gap span [1.2, 2.7) → the pause
    // rate; step outside → the applied rate; back inside → the dip repeats.
    await driver.writeSkipPrefs(on);
    await driver.navigateToWatch(fixture);
    const state = expectState(await driver.readPillState(), fixture);
    const { rec } = expectedRecommendation(fixture);
    if (state.mode !== rec.mode) {
      throw new Error(`${fixture}: pill mode ${state.mode}, expected ${rec.mode}`);
    }
    await driver.applyPill();
    const applied = await driver.readPlaybackRate();
    if (applied === null || Math.abs(applied - state.multiplier) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: playbackRate ${applied} after apply, expected ${state.multiplier} ± ${RATE_TOLERANCE}`,
      );
    }
    const pause = pauseRateFor(state.multiplier, on);
    if (pause >= state.multiplier) {
      throw new Error(`${fixture}: fixture must produce a dip (pause ${pause} >= applied ${state.multiplier})`);
    }
    await driver.chapterApplyFor(2.0);
    const dipped = await driver.readPlaybackRate();
    if (dipped === null || Math.abs(dipped - pause) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: in-gap playbackRate ${dipped}, expected the pause rate ${pause} ± ${RATE_TOLERANCE}`,
      );
    }
    await driver.chapterApplyFor(1.0);
    const restored = await driver.readPlaybackRate();
    if (restored === null || Math.abs(restored - state.multiplier) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: out-of-gap playbackRate ${restored}, expected the applied ${state.multiplier} ± ${RATE_TOLERANCE}`,
      );
    }
    await driver.chapterApplyFor(2.0);
    const redipped = await driver.readPlaybackRate();
    if (redipped === null || Math.abs(redipped - pause) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: in-gap playbackRate ${redipped}, expected the pause rate ${pause} ± ${RATE_TOLERANCE} (repeat)`,
      );
    }

    // (b) Toggle off: no plan, so the rate never dips.
    await driver.writeSkipPrefs(defaultSkipSilence());
    await driver.navigateToWatch(fixture);
    expectState(await driver.readPillState(), fixture);
    await driver.applyPill();
    await driver.chapterApplyFor(2.0);
    const held = await driver.readPlaybackRate();
    if (held === null || Math.abs(held - state.multiplier) > RATE_TOLERANCE) {
      throw new Error(
        `${fixture}: toggle-off in-gap playbackRate ${held}, expected the applied ${state.multiplier} ± ${RATE_TOLERANCE}`,
      );
    }

    // (c) Music: apply is a no-op, so no dip can ever attach.
    await driver.writeSkipPrefs(on);
    const musicFixture = 'synthetic/music-lyrics.json';
    await driver.navigateToWatch(musicFixture);
    const music = expectState(await driver.readPillState(), musicFixture);
    if (music.mode !== 'music') {
      throw new Error(`${musicFixture}: pill mode ${music.mode}, expected music`);
    }
    await driver.applyPill();
    await driver.chapterApplyFor(2.0);
    const musicRate = await driver.readPlaybackRate();
    if (musicRate === null || Math.abs(musicRate - 1) > RATE_TOLERANCE) {
      throw new Error(
        `${musicFixture}: playbackRate ${musicRate} after an in-gap tick, expected 1 (no dip on music)`,
      );
    }

    // (d) Live: the badge suppresses the pill; apply is a no-op.
    await driver.navigateToWatch(fixture);
    await driver.setLiveStream();
    let live: PillState | null = null;
    for (let i = 0; i < 20 && (live === null || live.mode !== 'none'); i++) {
      live = await driver.readPillState();
      if (live === null || live.mode !== 'none') await driver.sleep(250);
    }
    if (live === null || live.mode !== 'none') {
      throw new Error(`live: pill mode ${live?.mode}, expected none after the live badge`);
    }
    await driver.applyPill();
    await driver.chapterApplyFor(2.0);
    const liveRate = await driver.readPlaybackRate();
    if (liveRate === null || Math.abs(liveRate - 1) > RATE_TOLERANCE) {
      throw new Error(
        `live: playbackRate ${liveRate} after an in-gap tick, expected 1 (no dip on live)`,
      );
    }
  } finally {
    await driver.navigateToWatch(fixture);
    expectState(await driver.readPillState(), fixture);
    await driver.writeSkipPrefs(defaultSkipSilence());
  }
}

/**
 * Live-suppression e2e — the regression lane for the scoped-badge fix:
 * (a) a stray page-level .ytp-live-badge OUTSIDE the player must not
 * suppress the pill on a normal VOD (the pre-fix document-wide query did —
 * this is the fail-without-fix assertion), (b) the player response's
 * authoritative isLiveContent flag suppresses it, and (c) the badge inside
 * the active player still suppresses it. The classic in-player lane (c) is
 * also pinned inside runSkipSpecs; (a) and (b) have no other coverage.
 */
export async function runLiveSuppressionSpecs(driver: E2EDriver): Promise<void> {
  // (a) Stray badge outside the player + a normal VOD response: the pill
  // must render (mode = the fixture's recommendation).
  {
    const fixture = 'real/manual-cue.json';
    await driver.navigateToWatch(fixture, 'straybadge=1');
    const state = expectState(await driver.readPillState(), fixture);
    const { rec } = expectedRecommendation(fixture);
    if (state.mode !== rec.mode) {
      throw new Error(
        `${fixture}: pill mode ${state.mode}, expected ${rec.mode} (a stray page-level badge must not suppress)`,
      );
    }
  }

  // (b) isLiveContent in the player response: the pill stays suppressed
  // (mode none) even with no badge anywhere in the DOM.
  {
    const fixture = 'real/manual-cue.json';
    await driver.navigateToWatch(fixture, 'live=1');
    let live: PillState | null = null;
    for (let i = 0; i < 20 && (live === null || live.mode !== 'none'); i++) {
      live = await driver.readPillState();
      if (live === null || live.mode !== 'none') await driver.sleep(250);
    }
    if (live === null || live.mode !== 'none') {
      throw new Error(
        `live: pill mode ${live?.mode}, expected none (isLiveContent suppresses)`,
      );
    }
  }

  // (c) Badge inside the active player (the classic setLiveStream lane):
  // still suppressed.
  {
    const fixture = 'real/manual-cue.json';
    await driver.navigateToWatch(fixture);
    await driver.setLiveStream();
    let live: PillState | null = null;
    for (let i = 0; i < 20 && (live === null || live.mode !== 'none'); i++) {
      live = await driver.readPillState();
      if (live === null || live.mode !== 'none') await driver.sleep(250);
    }
    if (live === null || live.mode !== 'none') {
      throw new Error(
        `live: pill mode ${live?.mode}, expected none after the in-player live badge`,
      );
    }
  }
}
