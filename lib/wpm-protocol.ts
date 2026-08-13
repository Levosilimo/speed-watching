// Measured-rate provider protocol (docs/provider-integration.md): the
// wire contract a partner extension's wpm:get request follows on its way
// background → bridge → window channel → MAIN-world measurement context,
// and the shape of the answer. Data minimization: no videoId and no URL in
// the response. Lives apart from lib/messaging.ts so the window-bridge
// module stays under the aislop size budget.
//
// Bounds shared with the bridge protocol (NATURAL_RATE_MIN/MAX,
// RECOMMENDATION_MODES, the numeric validators) come from lib/messaging.ts.

import { isContentType, type ContentType } from './music';
import { SLOW_DOWN_FLOOR, type RateTier, type RecommendationMode } from './recommend';
import { PLATFORM_MAX_MAX, PLATFORM_MAX_MIN, TARGET_WPM_MAX, TARGET_WPM_MIN } from './settings';
import {
  isFiniteNumberIn,
  isRecord,
  NATURAL_RATE_MAX,
  NATURAL_RATE_MIN,
  RECOMMENDATION_MODES,
} from './messaging';

export const WPM_GET = 'wpm:get';
export const WPM_PROTOCOL_VERSION = 1;

/** Window channel the ISOLATED bridge relays wpm:get requests and answers on. */
export const WPM_CHANNEL = 'speedwatcher:wpm';

/** Bridge wait for the MAIN-world answer before reporting no-active-video. */
export const WPM_RELAY_TIMEOUT_MS = 1500;

export interface WpmGetRequest {
  type: typeof WPM_GET;
  version: typeof WPM_PROTOCOL_VERSION;
}

export function isWpmGetRequest(value: unknown): value is WpmGetRequest {
  return isRecord(value) && value.type === WPM_GET && value.version === WPM_PROTOCOL_VERSION;
}

/** Window envelope for the wpm:get round trip: the request in, the response out. */
export interface WpmEnvelope {
  channel: typeof WPM_CHANNEL;
  message: unknown;
}

export function isWpmEnvelope(value: unknown): value is WpmEnvelope {
  return isRecord(value) && value.channel === WPM_CHANNEL && isRecord(value.message);
}

export interface WpmGetResponseOk {
  ok: true;
  version: typeof WPM_PROTOCOL_VERSION;
  ts: number;
  site: string;
  naturalRate: number;
  unit: string;
  /** Resolved language-model code; null when none maps (English defaults). */
  language: string | null;
  tier: RateTier;
  contentType: ContentType;
  platformMax: number;
  recommendation: {
    target: number;
    recommendedMultiplier: number;
    mode: RecommendationMode;
  };
}

export type WpmGetResponse = WpmGetResponseOk | { ok: false; error: string };

const RATE_TIERS = new Set<RateTier>(['asr-word', 'asr-cue', 'manual-cue', 'estimated']);

/** Runtime shape check for wpm:get responses crossing the window boundary
 * (SEC pattern): the page world can post arbitrary JSON, so every field
 * the bridge forwards to the background is validated first. */
export function isWpmGetResponse(value: unknown): value is WpmGetResponse {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.error === 'string' && value.error.length > 0;
  if (value.ok !== true) return false;
  const recommendation = value.recommendation;
  return (
    value.version === WPM_PROTOCOL_VERSION &&
    typeof value.ts === 'number' && Number.isFinite(value.ts) && value.ts >= 0 &&
    typeof value.site === 'string' && value.site.length > 0 &&
    isFiniteNumberIn(value.naturalRate, NATURAL_RATE_MIN, NATURAL_RATE_MAX) &&
    typeof value.unit === 'string' && value.unit.length > 0 &&
    (value.language === null || typeof value.language === 'string') &&
    typeof value.tier === 'string' && RATE_TIERS.has(value.tier as RateTier) &&
    isContentType(value.contentType) &&
    isFiniteNumberIn(value.platformMax, PLATFORM_MAX_MIN, PLATFORM_MAX_MAX) &&
    isRecord(recommendation) &&
    isFiniteNumberIn(recommendation.target, TARGET_WPM_MIN, TARGET_WPM_MAX) &&
    isFiniteNumberIn(recommendation.recommendedMultiplier, SLOW_DOWN_FLOOR, PLATFORM_MAX_MAX) &&
    typeof recommendation.mode === 'string' && RECOMMENDATION_MODES.has(recommendation.mode)
  );
}

/** Numeric bounds the background applies before the wpm:get response
 * crosses to the external caller — the extension boundary is the trust
 * boundary. Error responses pass through untouched. */
export function clampWpmResponse(response: WpmGetResponse, now = Date.now()): WpmGetResponse {
  if (!response.ok) return response;
  const platformMax = Math.min(Math.max(response.platformMax, PLATFORM_MAX_MIN), PLATFORM_MAX_MAX);
  return {
    ...response,
    ts: Math.min(Math.max(response.ts, 0), now),
    naturalRate: Math.min(Math.max(response.naturalRate, NATURAL_RATE_MIN), NATURAL_RATE_MAX),
    platformMax,
    recommendation: {
      ...response.recommendation,
      recommendedMultiplier: Math.min(
        Math.max(response.recommendation.recommendedMultiplier, SLOW_DOWN_FLOOR),
        platformMax,
      ),
    },
  };
}
