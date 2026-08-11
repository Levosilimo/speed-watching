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
 * Natural-rate range for the 'estimated' tier: measured anchors from the
 * Phase-0 corpus; unmeasured types fall back to the generic default.
 */
export function priorRange(contentType: ContentType): WpmRange {
  const measured = MEASURED_PRIORS[contentType];
  if (measured !== undefined) return measured;
  if (contentType === 'podcast') return PODCAST_PRIOR;
  return GENERIC_PRIOR;
}
