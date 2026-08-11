import type { ContentType } from './music';

export type RecommendationMode = 'recommend' | 'warning' | 'unreachable' | 'music';

/** Natural-rate measurement tier; picks the clamp and the tier label. */
export type RateTier = 'asr-word' | 'asr-cue' | 'manual-cue' | 'estimated';

export const TARGET_WPM = 250;
export const ROUNDING_STEP = 0.05;
export const MANUAL_CUE_CLAMP = 1.5;
export const SLOW_DOWN_FLOOR = 0.5;

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
}

export interface Recommendation {
  multiplier: number;
  effectiveWpm: number;
  mode: RecommendationMode;
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
 * recommends a speed. Warning when a clamp keeps the effective rate below
 * the target.
 */
export function recommend(input: RecommendInput): Recommendation {
  const { naturalRate, tier, contentType, platformMax, userTarget } = input;
  const target = userTarget ?? TARGET_WPM;
  const tierLabel = TIER_LABELS[tier];

  if (contentType === 'music') {
    return {
      multiplier: 1,
      effectiveWpm: naturalRate,
      mode: 'music',
      label: 'music — speed not recommended',
      tierLabel,
    };
  }

  if (naturalRate * platformMax < target) {
    return {
      multiplier: platformMax,
      effectiveWpm: naturalRate * platformMax,
      mode: 'unreachable',
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
  const mode: RecommendationMode =
    clampedBelowZone && effectiveWpm < target ? 'warning' : 'recommend';

  let label = `→ ${formatMultiplier(multiplier)}x ≈ ${Math.round(effectiveWpm)} wpm`;
  if (mode === 'warning') label += ' (capped below safe zone)';
  return { multiplier, effectiveWpm, mode, label, tierLabel };
}
