// Measured-rate provider answer assembly (docs/provider-integration.md):
// maps the content script's measurement context onto the wpm:get response
// wire format. Chrome-free and DOM-free like the rest of lib/ — the same
// module is unit-testable in node (tests/core-surface.test.ts).
//
// The content script keeps `current` (the live measurement) in the
// entrypoint; this module only knows the slice the protocol carries.

import { WPM_PROTOCOL_VERSION, type WpmGetResponse } from './wpm-protocol';
import type { ContentType } from './music';
import type { RateTier, RecommendationMode } from './recommend';

/** The slice of the measurement context the wpm:get response carries. */
export interface MeasurementContext {
  site: string;
  contentType: ContentType;
  naturalRate: number;
  platformMax: number;
  tier: RateTier;
  /** Rate-unit display label ('wpm' | 'cpm' | 'syl/min' | 'morae/min'). */
  unit: string;
  /** Resolved language-model code; null when none maps (English defaults). */
  language: string | null;
  /** The resolved safe-zone target the recommendation steers toward. */
  target: number;
  recommendation: { multiplier: number; mode: RecommendationMode };
}

/** The current measurement per the wpm:get protocol; no-active-video when
 * no measurement exists (pre-measure or a navigated-away video). */
export function buildWpmResponse(current: MeasurementContext | null): WpmGetResponse {
  if (current === null) return { ok: false, error: 'no-active-video' };
  return {
    ok: true,
    version: WPM_PROTOCOL_VERSION,
    ts: Date.now(),
    site: current.site,
    naturalRate: current.naturalRate,
    unit: current.unit,
    language: current.language,
    tier: current.tier,
    contentType: current.contentType,
    platformMax: current.platformMax,
    recommendation: {
      target: current.target,
      recommendedMultiplier: current.recommendation.multiplier,
      mode: current.recommendation.mode,
    },
  };
}
