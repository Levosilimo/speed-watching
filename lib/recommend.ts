import { UNIT_LABELS, type LanguageModel } from './languages';
import type { ContentType } from './music';

export type RecommendationMode = 'recommend' | 'warning' | 'unreachable' | 'music';

/** Natural-rate measurement tier; picks the clamp and the tier label. */
export type RateTier = 'asr-word' | 'asr-cue' | 'manual-cue' | 'estimated';

export const TARGET_WPM = 250;
/**
 * Presentation-rate ceiling above which the recommendation warns. From
 * Chen et al. 2024 (Educ Psychol Rev 36:79, doi 10.1007/s10648-024-09917-7
 * — first author Chen, senior author Murphy; earlier notes cite it as
 * "Murphy et al."): comprehension holds near 250–275 wpm at speed. 275
 * is a heuristic pick from that band, not a crisp measured threshold —
 * Tharumalingam & Risko 2025 (Educ Psychol Rev, doi
 * 10.1007/s10648-025-10003-9) meta-analysis finds speed increases can
 * impair test performance.
 */
export const SAFE_ZONE_CEILING_WPM = 275;
export const ROUNDING_STEP = 0.05;
export const MANUAL_CUE_CLAMP = 1.5;
export const SLOW_DOWN_FLOOR = 0.5;

/**
 * Multimedia-ceiling modulation: lecture/explainer slide-heavy visuals
 * offload processing at speed, audio-only podcasts get no such offload —
 * the direction is Chen et al. 2024's comprehension-at-speed finding
 * (same study as SAFE_ZONE_CEILING_WPM's). The ±5% magnitudes are a
 * model choice, not sourced from the paper; the countervailing evidence
 * (Tharumalingam & Risko 2025: speed increases can impair test
 * performance) is why the modulation only moves the warning ceilings —
 * never the target or the multiplier bounds.
 */
export const MULTIMEDIA_CEILING_FACTOR = 1.05;
export const PODCAST_CEILING_FACTOR = 0.95;

const CONTENT_TYPE_CEILING_FACTOR: Partial<Record<ContentType, number>> = {
  lecture: MULTIMEDIA_CEILING_FACTOR,
  explainer: MULTIMEDIA_CEILING_FACTOR,
  podcast: PODCAST_CEILING_FACTOR,
};

/**
 * Default pause share of the stimulus on word-timed tracks, for languages
 * without a measured share. Measured pause:speech median is 44.8% (≈31%
 * pause share of span; range ~9–50%, 11/17 speech videos above 25%) —
 * lower bounds, since sub-second micro-pauses stay inside the inter-start
 * spans. The corpus languages carry their measured medians instead
 * (LanguageModel.pauseShare: ar 0.51, ko 0.41, pl 0.38, ru 0.36, cs 0.35,
 * id 0.34, uk 0.32, ja 0.23, vi 0.17, th 0.15 — from each corpus's
 * pauseBiasPct median, s = −b/(1−b)). Low-pause ja/vi/th run articulatory
 * ≈ presentation, so the fixed 0.3 leaves their warning threshold too
 * high — the under-warn direction; ar at 0.51 over-warns on the 0.3
 * default, the safe direction. The per-video ceiling/(1−share) upgrade
 * (measuring the video's own pause share from word timing) is the
 * documented future path.
 */
export const P_STIMULUS = 0.3;

/**
 * Articulatory ceiling under the default 0.3 pause share: the ~275 wpm
 * presentation limit mapped onto the pause-excluded speech rate
 * (275 / (1 − 0.3) ≈ 393 wpm). Above it the speech itself runs faster
 * than the comprehension limit even when the presentation rate stays in
 * the safe zone. recommend() replaces 0.3 with the language's measured
 * pauseShare when present — th's 0.15 tightens the threshold to
 * ceiling/0.85, ar's 0.51 relaxes it to ceiling/0.49.
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
  /** Language model for non-English tracks; absent → English defaults. */
  language?: LanguageModel;
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
 * Multiplier = target / naturalRate, rounded to 0.05 and clamped per
 * tier: manual-cue ≤1.5x, every tier within [slow-down floor, platformMax].
 * Target and ceiling come from the language model when present (English
 * defaults otherwise), so naturalRate must be measured in the language's
 * unit. Unreachable when even platformMax cannot reach the target; music
 * never recommends a speed. Warning when the effective rate crosses the
 * comprehension ceiling ('above-zone'), when a clamp keeps it below the
 * target ('capped-below'), or — asr-word tier only, and only when word
 * timing is adequate — when the multiplier pushes the pause-excluded
 * articulatory rate past its ceiling ('pause-diluted').
 */
export function recommend(input: RecommendInput): Recommendation {
  const { naturalRate, tier, contentType, platformMax, userTarget, articulatoryWpm, timingCoverageOk, language } = input;
  const unit = language?.unit ?? 'wpm';
  const unitLabel = UNIT_LABELS[unit];
  // userTarget is interpreted in the language's unit when set on a
  // non-English track (the options slider is wpm-labeled regardless).
  const target = userTarget ?? language?.target ?? TARGET_WPM;
  // The comprehension ceiling is content-type modulated: slide-heavy
  // lectures/explainers offload processing (factor up), podcasts don't
  // (factor down). The pause-diluted articulatory ceiling scales with the
  // same modulated ceiling and the language's pause share (measured per
  // language, 0.3 default): ceiling / (1 − pauseShare).
  const ceiling =
    (language?.ceiling ?? SAFE_ZONE_CEILING_WPM) *
    (CONTENT_TYPE_CEILING_FACTOR[contentType] ?? 1);
  const articulatoryCeiling = ceiling / (1 - (language?.pauseShare ?? P_STIMULUS));
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
      label: `safe zone unreachable — ${formatMultiplier(platformMax)}x ≈ ${Math.round(naturalRate * platformMax)} ${unitLabel}`,
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
  if (effectiveWpm > ceiling) {
    reason = 'above-zone';
  } else if (
    tier === 'asr-word' &&
    timingCoverageOk === true &&
    articulatoryWpm !== null &&
    articulatoryWpm !== undefined &&
    multiplier * articulatoryWpm > articulatoryCeiling
  ) {
    reason = 'pause-diluted';
  } else if (clampedBelowZone && effectiveWpm < target) {
    reason = 'capped-below';
  }
  const mode: RecommendationMode = reason === null ? 'recommend' : 'warning';

  let label = `→ ${formatMultiplier(multiplier)}x ≈ ${Math.round(effectiveWpm)} ${unitLabel}`;
  if (reason === 'capped-below') label += ' (capped below safe zone)';
  return { multiplier, effectiveWpm, mode, reason, label, tierLabel };
}
