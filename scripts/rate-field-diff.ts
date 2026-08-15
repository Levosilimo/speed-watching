// Field-diff of the realsite runner's measured rates against the golden-master
// registry (Wave 3): the classification split out of realsite-runner-lib.ts
// to keep both files under the repo's 400-line cap.

import { rateInTolerance } from './drift-classify';
import { bestRate, type RealsiteRecord } from './realsite-runner-lib';
import type { RegistryRow } from '../tests/fixtures/registry';

/** The registry's recorded-rate field for a measured metric class. The
 * pins' own rates are computed from the truncated (first 20 events) fixture
 * and do not represent the full-video rate (iG9CE55wbtY: pinned wordLevelWpm
 * 111.7 vs recorded wordWpm 140.5 — a 20% span gap), so the field-diff
 * anchors on the row's recorded full-payload rate, the same span class the
 * runner measures. */
const RECORDED_RATE_FIELD = {
  word: 'wordWpm',
  cue: 'cueWpm',
  corrected: 'cueWpmCorrected',
} as const;

export type RateFieldMetric = keyof typeof RECORDED_RATE_FIELD;

/** One speech record's measured rate vs the golden-master registry anchor. */
export interface RateFieldDiff {
  videoId: string;
  metric: RateFieldMetric;
  pinnedWpm: number;
  measuredWpm: number;
  relDeltaPct: number;
  /** The anchor row's pinned ratesRel band the verdict was computed with. */
  ratesRel: number;
  verdict: 'benign' | 'breaking';
}

/** Classify a speech record's measured rate against the registry: within
 * the anchor row's ratesRel band → benign, outside → breaking; null when no
 * anchor exists. The drift-triage runner and this share the vocabulary
 * (scripts/drift-classify.ts) — same band math, different anchor (a
 * re-captured truncated pin there, a recorded full-payload rate here). */
export function classifyRateFieldDiff(
  record: RealsiteRecord,
  rows: readonly RegistryRow[],
): RateFieldDiff | null {
  if (record.kind !== 'speech' || record.measure === null) return null;
  const stats = record.measure.stats;
  const metric: RateFieldMetric | null =
    typeof stats.word === 'number'
      ? 'word'
      : typeof stats.cue === 'number'
        ? 'cue'
        : typeof stats.corrected === 'number'
          ? 'corrected'
          : null;
  const measured = bestRate(stats);
  if (metric === null || measured === null) return null;
  const field = RECORDED_RATE_FIELD[metric];
  let anchor: { pinnedWpm: number; ratesRel: number } | null = null;
  for (const row of rows) {
    if (row.provenance.source !== 'real' || row.provenance.videoId !== record.videoId) continue;
    const pinned = row.recorded?.fields[field];
    if (typeof pinned === 'number' && Number.isFinite(pinned)) {
      anchor = { pinnedWpm: pinned, ratesRel: row.pins.tolerance.ratesRel };
      break;
    }
  }
  if (anchor === null) return null;
  return {
    videoId: record.videoId,
    metric,
    pinnedWpm: anchor.pinnedWpm,
    measuredWpm: measured,
    relDeltaPct: ((measured - anchor.pinnedWpm) / Math.abs(anchor.pinnedWpm)) * 100,
    ratesRel: anchor.ratesRel,
    verdict: rateInTolerance(anchor.pinnedWpm, measured, anchor.ratesRel) ? 'benign' : 'breaking',
  };
}

