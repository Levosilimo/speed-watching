// Shared E2E specs, framework-agnostic: the chromium runner drives them with
// Playwright, the firefox runner with selenium-webdriver. Each runner only
// supplies navigation + a way to read the page-side measurement payload.
//
// Everything is asserted against local fixtures (e2e/server.ts) — no real
// YouTube traffic. Expected wpm values are recomputed in this process from
// the same pure lib functions the content script uses, so the assertion is
// math-level: fixture JSON → reported wpm.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYouTubeJson3 } from '../../lib/captions';
import {
  correctedCueLevelWpm,
  cueLevelWpm,
  totalWords,
  wordLevelWpm,
} from '../../lib/wpm';
import type { MeasureEventDetail } from '../../entrypoints/content';

export type Measurement = MeasureEventDetail;

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

const WPM_TOLERANCE = 0.5;

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
