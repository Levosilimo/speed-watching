// Chapter segmentation: per-chapter rate recommendations (segmentRates)
// and the cue-driven fallback when chapters are absent (clusterSegments).
// Pure module — DOM-free, unit-testable against caption payloads. Mirrors
// the wpm.ts/recommend.ts split: rate rules come from lib/wpm.ts, the
// safe-zone math from lib/recommend.ts, and the slice-level music guard
// from lib/music.ts.

import type { Segment } from './captions';
import type { LanguageModel } from './languages';
import { detectMusic, type ContentType } from './music';
import { recommend, type RecommendationMode, type RateTier } from './recommend';
import { filteredTokensOverTrimmedSpan, manualCueRate, unitTokens } from './wpm';
import type { ChapterSegment } from './youtube';

/** One schedulable rate span: the multiplier to hold while playback is in
 * [startSec, endSec). endSec 0 means "to the end of the video". */
export interface RateSegment {
  startSec: number;
  endSec: number;
  multiplier: number;
  mode: RecommendationMode;
}

export interface SegmentRatesOptions {
  platformMax: number;
  userTarget?: number;
  contentType: ContentType;
}

/** Noise floors for per-chapter segmentation: a chapter below either one
 * is too sparse to trust, so it inherits the whole-video recommendation. */
export const MIN_SEGMENT_SEC = 30;
export const MIN_SEGMENT_TOKENS = 30;

/** Clustering windows for the no-chapters fallback. */
export const ROLLING_WINDOW_SEC = 45;
export const ROLLING_STEP_SEC = 12;
export const SPLIT_RATE_DELTA = 0.3;
export const STRUCTURAL_GAP_SEC = 2.5;
export const GAP_LOOKAROUND_SEC = 5;
export const MIN_CLUSTER_SEC = 60;

/** Cues whose start falls in [start, end). */
export function cuesInRange(
  cues: readonly Segment[],
  start: number,
  end: number,
): Segment[] {
  return cues.filter((cue) => cue.startSec >= start && cue.startSec < end);
}

/** The kind's rate rule over a cue slice, in the language's unit. */
function rateOf(
  slice: readonly Segment[],
  kind: string,
  language: LanguageModel | undefined,
): number | null {
  return kind === 'asr'
    ? filteredTokensOverTrimmedSpan(slice, language)
    : manualCueRate(slice, language);
}

/** No measurable speech anywhere — a safe no-op rather than a fabricated
 * rate. Mode 'recommend' reads as "nothing to do" to the pill UI. */
const NO_OP: { multiplier: number; mode: RecommendationMode } = { multiplier: 1, mode: 'recommend' };

function recFor(
  slice: readonly Segment[],
  rate: number | null,
  tier: RateTier,
  language: LanguageModel | undefined,
  opts: SegmentRatesOptions,
  timingCoverageOk: boolean | undefined,
): { multiplier: number; mode: RecommendationMode } {
  if (rate === null) return NO_OP;
  const unit = language?.unit ?? 'wpm';
  if (detectMusic(slice, rate, unit)) return { multiplier: 1, mode: 'music' };
  const rec = recommend({
    naturalRate: rate,
    tier,
    contentType: opts.contentType,
    platformMax: opts.platformMax,
    userTarget: opts.userTarget,
    language,
    timingCoverageOk,
  });
  return { multiplier: rec.multiplier, mode: rec.mode };
}

/** Concrete span end: the chapter end, or the last cue's end for the
 * unbounded final chapter (endSec 0 → through the cues). */
function spanEndSec(slice: readonly Segment[], startSec: number, endSec: number): number {
  if (endSec !== Number.POSITIVE_INFINITY) return endSec;
  const last = slice.at(-1);
  return last === undefined ? startSec : last.startSec + (last.durSec ?? 0);
}

/**
 * One recommendation per chapter: the slice's rate through the kind's rule,
 * then recommend() with the caller's platformMax/userTarget/contentType and
 * the track language. Chapters under a noise floor (span < MIN_SEGMENT_SEC
 * or < MIN_SEGMENT_TOKENS tokens), or whose slice has no measurable rate,
 * inherit the whole-video recommendation; the sub-30 s floor also suppresses
 * the articulatory warning (timingCoverageOk false — a boundary-cut slice
 * cannot vouch for pause structure). Music slices return 1x.
 */
export function segmentRates(
  cues: readonly Segment[],
  chapters: readonly ChapterSegment[],
  kind: string,
  language: LanguageModel | undefined,
  opts: SegmentRatesOptions,
): RateSegment[] {
  const tier: RateTier = kind === 'asr' ? 'asr-cue' : 'manual-cue';
  const wholeRate = rateOf(cues, kind, language);
  const whole = recFor(cues, wholeRate, tier, language, opts, false);
  return chapters.map((chapter) => {
    const endSec = chapter.endSec > chapter.startSec ? chapter.endSec : Number.POSITIVE_INFINITY;
    const slice = cuesInRange(cues, chapter.startSec, endSec);
    const concreteEnd = spanEndSec(slice, chapter.startSec, endSec);
    const tokens = slice.reduce((sum, cue) => sum + unitTokens(cue.text, language), 0);
    const belowFloor =
      concreteEnd - chapter.startSec < MIN_SEGMENT_SEC || tokens < MIN_SEGMENT_TOKENS;
    const sliceRate = rateOf(slice, kind, language);
    const rec =
      belowFloor || sliceRate === null
        ? whole
        : recFor(slice, sliceRate, tier, language, opts, undefined);
    return { startSec: chapter.startSec, endSec: concreteEnd, ...rec };
  });
}

/** Silence between consecutive cues must overlap the lookaround window
 * around a candidate boundary — the pause that marks a real section break. */
function hasStructuralGap(cues: readonly Segment[], position: number): boolean {
  for (let i = 0; i < cues.length - 1; i++) {
    const cur = cues[i]!;
    const next = cues[i + 1]!;
    if (next.startSec - cur.startSec < STRUCTURAL_GAP_SEC) continue;
    if (
      cur.startSec + (cur.durSec ?? 0) <= position + GAP_LOOKAROUND_SEC &&
      next.startSec >= position - GAP_LOOKAROUND_SEC
    ) {
      return true;
    }
  }
  return false;
}

/** Boundaries where the rolling-window rate jumped and a structural pause
 * confirms the break: at each step, the window rate must move more than
 * SPLIT_RATE_DELTA relative to the previous window AND a gap ≥
 * STRUCTURAL_GAP_SEC must sit within GAP_LOOKAROUND_SEC of the step. */
function rollingBoundaries(
  cues: readonly Segment[],
  kind: string,
  language: LanguageModel | undefined,
): number[] {
  const boundaries: number[] = [];
  let prevRate: number | null = null;
  for (let start = 0; start + ROLLING_WINDOW_SEC <= cueSpanEnd(cues); start += ROLLING_STEP_SEC) {
    const rate = rateOf(cuesInRange(cues, start, start + ROLLING_WINDOW_SEC), kind, language);
    if (rate === null) {
      prevRate = null;
      continue;
    }
    if (
      prevRate !== null &&
      Math.abs(rate - prevRate) / Math.max(rate, prevRate) > SPLIT_RATE_DELTA &&
      hasStructuralGap(cues, start)
    ) {
      boundaries.push(start);
    }
    prevRate = rate;
  }
  return boundaries;
}

/** Wall-clock end of the cue timeline: last cue end, null without cues. */
function cueSpanEnd(cues: readonly Segment[]): number {
  const last = cues.at(-1);
  return last === undefined ? 0 : last.startSec + (last.durSec ?? 0);
}

/** Drops boundaries whose cluster is shorter than minSec, folding the short
 * cluster into its predecessor; a short trailing cluster folds back too. */
function mergeShortClusters(boundaries: readonly number[], minSec: number): number[] {
  const merged = [boundaries[0]!];
  for (let i = 1; i < boundaries.length - 1; i++) {
    if (boundaries[i]! - merged.at(-1)! >= minSec) merged.push(boundaries[i]!);
  }
  merged.push(boundaries.at(-1)!);
  if (merged.length > 2 && merged.at(-1)! - merged.at(-2)! < minSec) {
    merged.splice(merged.length - 2, 1);
  }
  return merged;
}

/**
 * Fallback segmentation when chaptersOf returned null: rolling-window
 * boundaries (rate delta AND structural gap, see rollingBoundaries),
 * merged up to MIN_CLUSTER_SEC, one recommendation per cluster. Music
 * clusters return 1x. Fewer than two stable clusters — no split found —
 * returns the single whole-video recommendation: the feature no-ops.
 */
export function clusterSegments(
  cues: readonly Segment[],
  kind: string,
  language: LanguageModel | undefined,
  opts: SegmentRatesOptions,
): RateSegment[] {
  const tier: RateTier = kind === 'asr' ? 'asr-cue' : 'manual-cue';
  const wholeRate = rateOf(cues, kind, language);
  const whole = recFor(cues, wholeRate, tier, language, opts, undefined);
  const end = cueSpanEnd(cues);
  if (end <= 0) return [{ startSec: 0, endSec: 0, ...whole }];
  const merged = mergeShortClusters([0, ...rollingBoundaries(cues, kind, language), end], MIN_CLUSTER_SEC);
  if (merged.length < 3) return [{ startSec: 0, endSec: end, ...whole }];
  const segments: RateSegment[] = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const startSec = merged[i]!;
    const endSec = merged[i + 1]!;
    const slice = cuesInRange(cues, startSec, endSec);
    const rate = rateOf(slice, kind, language);
    const rec = rate === null ? whole : recFor(slice, rate, tier, language, opts, undefined);
    segments.push({ startSec, endSec, ...rec });
  }
  return segments;
}
