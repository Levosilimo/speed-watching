import type { ContentType } from './music';

export type RecommendationMode = 'recommend' | 'warning' | 'unreachable' | 'music';

/** Natural-rate measurement tier; picks the clamp and the tier label. */
export type RateTier = 'asr-word' | 'asr-cue' | 'manual-cue' | 'estimated';

export const TARGET_WPM = 250;
/** Comprehension cliff (Murphy et al.): above this, warning mode. */
export const SAFE_ZONE_CEILING_WPM = 275;
export const ROUNDING_STEP = 0.05;
export const MANUAL_CUE_CLAMP = 1.5;
export const SLOW_DOWN_FLOOR = 0.5;

/**
 * Assumed pause share of the stimulus on word-timed tracks. Measured
 * pause:speech median is 44.8% (≈31% pause share of span; range ~9–50%,
 * 11/17 speech videos above 25%) — lower bounds, since sub-second
 * micro-pauses stay inside the inter-start spans. 0.3 is the round
 * working assumption the safe-zone mapping below is built on.
 */
export const P_STIMULUS = 0.3;

/**
 * Articulatory ceiling: the ~275 wpm presentation limit mapped onto the
 * pause-excluded speech rate (275 / (1 − 0.3) ≈ 393 wpm). Above it the
 * speech itself runs faster than the comprehension limit even when the
 * presentation rate stays in the safe zone.
 */
export const ARTICULATORY_CEILING_WPM = SAFE_ZONE_CEILING_WPM / (1 - P_STIMULUS);

export const TIER_LABELS: Record<RateTier, string> = {
  'asr-word': 'from captions',
  'asr-cue': 'from captions',
  'manual-cue': 'from captions (corrected)',
  estimated: 'estimated',
};

export interface RecommendInput {
  naturalRate: number;
  tier: RateTier;
  contentType: ContentType;
  platformMax: number;
  userTarget?: number;
  /**
   * Pause-excluded articulatory rate (asr-word tier only): filtered cue
   * tokens over speechDurationSec(words). Null/absent when word timing is
   * too sparse to estimate speech duration.
   */
  articulatoryWpm?: number | null;
  /**
   * Word-timing coverage sanity (timed tokens / cue tokens; phase-0 mean
   * 83.6%). Sparse coverage misestimates speechDur, so the articulatory
   * warning stays off unless the caller confirms coverage.
   */
  timingCoverageOk?: boolean;
}

export interface Recommendation {
  multiplier: number;
  effectiveWpm: number;
  mode: RecommendationMode;
  /** Why warning mode fired; null in every other mode. */
  reason: 'above-zone' | 'capped-below' | 'pause-diluted' | null;
  /** User-facing pill string, e.g. '→ 1.6x ≈ 240 wpm'. */
  label: string;
  /** 'from captions' | 'from captions (corrected)' | 'estimated'. */
  tierLabel: string;
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function formatMultiplier(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Multiplier = userTarget / naturalRate, rounded to 0.05 and clamped per
 * tier: manual-cue ≤1.5x, every tier within [slow-down floor, platformMax].
 * Unreachable when even platformMax cannot reach the target; music never
 * recommends a speed. Warning when the effective rate crosses the ~275 wpm
 * comprehension cliff ('above-zone'), when a clamp keeps it below the
 * target ('capped-below'), or — asr-word tier only, and only when word
 * timing is adequate — when the multiplier pushes the pause-excluded
 * articulatory rate past its ceiling ('pause-diluted').
 */
export function recommend(input: RecommendInput): Recommendation {
  const { naturalRate, tier, contentType, platformMax, userTarget, articulatoryWpm, timingCoverageOk } = input;
  const target = userTarget ?? TARGET_WPM;
  const tierLabel = TIER_LABELS[tier];

  if (contentType === 'music') {
    return {
      multiplier: 1,
      effectiveWpm: naturalRate,
      mode: 'music',
      reason: null,
      label: 'music — speed not recommended',
      tierLabel,
    };
  }

  if (naturalRate * platformMax < target) {
    return {
      multiplier: platformMax,
      effectiveWpm: naturalRate * platformMax,
      mode: 'unreachable',
      reason: null,
      label: `safe zone unreachable — ${formatMultiplier(platformMax)}x ≈ ${Math.round(naturalRate * platformMax)} wpm`,
      tierLabel,
    };
  }

  let multiplier = roundToStep(target / naturalRate, ROUNDING_STEP);
  if (tier === 'manual-cue') multiplier = Math.min(multiplier, MANUAL_CUE_CLAMP);
  const floor = Math.min(SLOW_DOWN_FLOOR, platformMax);
  multiplier = Math.min(Math.max(multiplier, floor), platformMax);

  const effectiveWpm = naturalRate * multiplier;
  const clampedBelowZone =
    (tier === 'manual-cue' && multiplier === MANUAL_CUE_CLAMP) ||
    (multiplier === SLOW_DOWN_FLOOR && floor === SLOW_DOWN_FLOOR);
  // The cliff outranks the clamp when both apply: crossing ~275 wpm is the
  // safety-critical message even on a clamp-capped recommendation. The
  // articulatory warning is additive and report-only; precedence is
  // above-zone > pause-diluted > capped-below — the cliff is the
  // safety-critical message, the articulatory ceiling reports speech
  // outrunning comprehension, the clamp only says the target was missed.
  let reason: Recommendation['reason'] = null;
  if (effectiveWpm > SAFE_ZONE_CEILING_WPM) {
    reason = 'above-zone';
  } else if (
    tier === 'asr-word' &&
    timingCoverageOk === true &&
    articulatoryWpm !== null &&
    articulatoryWpm !== undefined &&
    multiplier * articulatoryWpm > ARTICULATORY_CEILING_WPM
  ) {
    reason = 'pause-diluted';
  } else if (clampedBelowZone && effectiveWpm < target) {
    reason = 'capped-below';
  }
  const mode: RecommendationMode = reason === null ? 'recommend' : 'warning';

  let label = `→ ${formatMultiplier(multiplier)}x ≈ ${Math.round(effectiveWpm)} wpm`;
  if (reason === 'capped-below') label += ' (capped below safe zone)';
  return { multiplier, effectiveWpm, mode, reason, label, tierLabel };
}
