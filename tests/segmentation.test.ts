import { describe, expect, it } from 'vitest';
import type { Segment } from '../lib/captions';
import { clusterSegments, cuesInRange, MIN_CLUSTER_SEC, segmentRates } from '../lib/chapters';
import { recommend } from '../lib/recommend';
import { filteredTokensOverTrimmedSpan, manualCueRate } from '../lib/wpm';
import type { ChapterSegment } from '../lib/youtube';

const opts = { platformMax: 2, contentType: 'lecture' as const };

function cue(text: string, startSec: number, durSec?: number): Segment {
  return { text, startSec, durSec };
}

const w5 = 'w '.repeat(5).trim();
const w8 = 'w '.repeat(8).trim();
const w20 = 'w '.repeat(20).trim();

/** Fixture rates are guaranteed measurable; narrow for the compiler. */
function measurable(rate: number | null): number {
  expect(rate).not.toBeNull();
  return rate!;
}

/** Uniform 8-word cues every 4 s over 0..116, duration 4 s. */
function denseCues(): Segment[] {
  const cues: Segment[] = [];
  for (let t = 0; t <= 116; t += 4) cues.push(cue(w8, t, 4));
  return cues;
}

describe('cuesInRange', () => {
  it('returns cues with startSec in [start, end)', () => {
    const cues = denseCues();
    expect(cuesInRange(cues, 30, 70).map((c) => c.startSec)).toEqual([32, 36, 40, 44, 48, 52, 56, 60, 64, 68]);
    expect(cuesInRange(cues, 0, 0)).toEqual([]);
    expect(cuesInRange(cues, 120, 200)).toEqual([]);
  });
});

describe('segmentRates', () => {
  const chapters: ChapterSegment[] = [
    { title: 'A', startSec: 0, endSec: 60 },
    { title: 'B', startSec: 60, endSec: 0 },
  ];

  it('recommends per chapter exactly as recomputing on the sub-slice does', () => {
    const cues = denseCues();
    const segments = segmentRates(cues, chapters, 'asr', undefined, opts);
    const expectedA = recommend({
      naturalRate: measurable(filteredTokensOverTrimmedSpan(cuesInRange(cues, 0, 60))),
      tier: 'asr-cue',
      contentType: opts.contentType,
      platformMax: opts.platformMax,
    });
    const expectedB = recommend({
      naturalRate: measurable(filteredTokensOverTrimmedSpan(cuesInRange(cues, 60, 120))),
      tier: 'asr-cue',
      contentType: opts.contentType,
      platformMax: opts.platformMax,
    });
    expect(segments[0]).toEqual({ startSec: 0, endSec: 60, multiplier: expectedA.multiplier, mode: expectedA.mode });
    expect(segments[1]).toEqual({ startSec: 60, endSec: 120, multiplier: expectedB.multiplier, mode: expectedB.mode });
  });

  it('uses the manual-cue rule for non-asr kinds', () => {
    const cues = denseCues();
    const segments = segmentRates(cues, chapters, 'manual', undefined, opts);
    const expectedA = recommend({
      naturalRate: measurable(manualCueRate(cuesInRange(cues, 0, 60))),
      tier: 'manual-cue',
      contentType: opts.contentType,
      platformMax: opts.platformMax,
    });
    expect(segments[0]!.multiplier).toBe(expectedA.multiplier);
    expect(segments[0]!.mode).toBe(expectedA.mode);
  });

  it('falls back to the whole-video recommendation under a noise floor', () => {
    const cues = denseCues();
    const shortChapters: ChapterSegment[] = [
      { title: 'Short', startSec: 0, endSec: 20 },
      { title: 'Long', startSec: 20, endSec: 0 },
    ];
    const segments = segmentRates(cues, shortChapters, 'asr', undefined, opts);
    const whole = recommend({
      naturalRate: measurable(filteredTokensOverTrimmedSpan(cues)),
      tier: 'asr-cue',
      contentType: opts.contentType,
      platformMax: opts.platformMax,
    });
    expect(segments[0]).toEqual({ startSec: 0, endSec: 20, multiplier: whole.multiplier, mode: whole.mode });

    // Token floor: a 40 s chapter with two sparse cues inherits the whole rec.
    const sparse = [cue(w8, 0, 4), cue(w8, 40, 4), cue(w8, 80, 4)];
    const sparseChapters: ChapterSegment[] = [{ title: 'Sparse', startSec: 0, endSec: 60 }];
    const sparseSegments = segmentRates(sparse, sparseChapters, 'asr', undefined, opts);
    const sparseWhole = recommend({
      naturalRate: measurable(filteredTokensOverTrimmedSpan(sparse)),
      tier: 'asr-cue',
      contentType: opts.contentType,
      platformMax: opts.platformMax,
    });
    expect(sparseSegments[0]!.multiplier).toBe(sparseWhole.multiplier);
    expect(sparseSegments[0]!.mode).toBe(sparseWhole.mode);
  });
});

/** 5-word cues every 2 s to 104, then 20-word cues from 105; withGap skips
 * 72/74 so a 6 s silence opens at ~72 — the step where the rate jump first
 * shows up in the rolling window. */
function splitCues(withGap: boolean): Segment[] {
  const cues: Segment[] = [];
  for (let t = 0; t <= 104; t += 2) {
    if (withGap && (t === 72 || t === 74)) continue;
    cues.push(cue(w5, t));
  }
  for (let t = 105; t <= 200; t += 2) cues.push(cue(w20, t));
  return cues;
}

describe('clusterSegments', () => {
  it('accepts a boundary only when the rate delta AND a structural gap align', () => {
    const split = clusterSegments(splitCues(true), 'asr', undefined, opts);
    expect(split).toHaveLength(2);
    expect(split[0]).toMatchObject({ startSec: 0, endSec: 72 });
    expect(split[1]).toMatchObject({ startSec: 72 });

    // Same rate jump without the pause: no boundary, single whole segment.
    const unsplit = clusterSegments(splitCues(false), 'asr', undefined, opts);
    expect(unsplit).toHaveLength(1);
    const whole = recommend({
      naturalRate: measurable(filteredTokensOverTrimmedSpan(splitCues(false))),
      tier: 'asr-cue',
      contentType: opts.contentType,
      platformMax: opts.platformMax,
    });
    expect(unsplit[0]).toMatchObject({ startSec: 0, multiplier: whole.multiplier, mode: whole.mode });
  });

  it('ignores a structural gap without a rate jump', () => {
    const cues = splitCues(true).map((c) => (c.startSec >= 105 ? cue(w5, c.startSec) : c));
    expect(clusterSegments(cues, 'asr', undefined, opts)).toHaveLength(1);
  });

  it('merges clusters shorter than MIN_CLUSTER_SEC into the whole', () => {
    const cues: Segment[] = [];
    for (let t = 0; t <= 180; t += 2) {
      if (t === 152 || t === 154) continue;
      cues.push(cue(w5, t, 1.5));
    }
    for (let t = 183; t <= 200; t += 2) cues.push(cue(w20, t, 1.5));
    const segments = clusterSegments(cues, 'asr', undefined, opts);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startSec: 0, endSec: 200.5 });
    expect(segments[0]!.endSec - segments[0]!.startSec).toBeGreaterThan(MIN_CLUSTER_SEC);
  });

  it('returns 1x music for a music cluster', () => {
    const cues: Segment[] = [];
    for (let t = 0; t <= 68; t += 4) cues.push(cue(t % 8 === 0 ? '[Music]' : 'la la la', t));
    for (let t = 76; t <= 200; t += 2) cues.push(cue(w20, t));
    const segments = clusterSegments(cues, 'asr', undefined, opts);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startSec: 0, multiplier: 1, mode: 'music' });
    // The speech half runs far above the safe zone — the rec slows it down.
    expect(segments[1]!.multiplier).toBeLessThan(1);
  });
});
