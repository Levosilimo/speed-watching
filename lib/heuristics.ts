import type { LanguageModel } from './languages';
import type { ContentType } from './music';

export interface WpmRange {
  min: number;
  max: number;
}

const MEASURED_PRIORS: Partial<Record<ContentType, WpmRange>> = {
  talk: { min: 140, max: 206 },
  lecture: { min: 110, max: 188 },
  explainer: { min: 103, max: 191 },
  news: { min: 127, max: 150 },
};

const GENERIC_PRIOR: WpmRange = { min: 130, max: 190 };
const PODCAST_PRIOR: WpmRange = { min: 140, max: 200 };

/**
 * Natural-rate range for the 'estimated' tier. Language priors win for
 * known non-English tracks — the Phase-0 anchors are an English-corpus
 * measurement. A register band (language.registerPriors) applies when the
 * language carries one and the caller resolved a concrete type
 * (detectContentType or a user/site preference); everything else on the
 * language falls back to its generic band. English and unmapped tracks
 * keep the measured anchors and the generic default.
 */
export function priorRange(contentType: ContentType, language?: LanguageModel): WpmRange {
  if (language !== undefined && language.code !== 'en') {
    const register = language.registerPriors?.[contentType];
    if (register !== undefined) return register;
    return language.priors;
  }
  const measured = MEASURED_PRIORS[contentType];
  if (measured !== undefined) return measured;
  if (contentType === 'podcast') return PODCAST_PRIOR;
  return GENERIC_PRIOR;
}

/** Best-guess natural rate for the 'estimated' tier: prior-range midpoint. */
export function priorMidpoint(contentType: ContentType, language?: LanguageModel): number {
  const { min, max } = priorRange(contentType, language);
  return (min + max) / 2;
}
