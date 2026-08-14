// Auto-apply: per-video, opt-in application of the fresh recommendation.
// Pure module shared by both content scripts (entrypoints/content.ts and
// entrypoints/generic.content.ts) — no DOM, no chrome.*, unit-testable.
//
// Why there is no videospeed-style echo token (no fight-count, no
// USER_INTENT): our design has no continuous loop on YouTube — auto-apply
// fires ONCE per navigation, so there is nothing to re-arm and no feedback
// loop an echo token would break. On the generic path the sentinel
// (lib/matcher.ts) re-asserts ONLY a reset to exactly 1.0, which our own
// apply can never produce (we apply a clamped non-1 multiplier), so a
// divergent rate is by definition user action, never our echo. The per-video
// respect rule IS the mechanism: any non-1.0 rate left alone, explicit
// actions (Apply / Dismiss / Stop-auto) or non-1.0 divergence stop auto.

import type { Recommendation, RateTier } from './recommend';
import type { Settings } from './settings';
import type { ContentType } from './music';

/** Content types auto-apply covers when the user has not picked per-type
 * prefs. Music is never included; generic/news (and the estimated tier)
 * stay pill-only unless the user forces a content type. */
export const DEFAULT_AUTO_TYPES: ReadonlySet<ContentType> = new Set([
  'talk',
  'lecture',
  'explainer',
  'podcast',
]);

/** Per-type opt-in: an explicit user choice wins, absent → the default set. */
export function isAutoContentType(settings: Settings, contentType: ContentType): boolean {
  return settings.autoApply.contentTypes[contentType] ?? DEFAULT_AUTO_TYPES.has(contentType);
}

/** The auto-apply safety gate, evaluated at measure time. Every condition is
 * a strict consent/safety check: the master toggle, the resolved content
 * type, a confident 'recommend' mode (excludes music, unreachable, and all
 * warnings — above-zone and pause-diluted), and a measured tier (estimated
 * priors never auto-apply). */
export function shouldAutoApply(
  settings: Settings,
  recommendation: Recommendation,
  tier: RateTier,
  contentType: ContentType,
): boolean {
  if (!settings.autoApply.enabled) return false;
  if (!isAutoContentType(settings, contentType)) return false;
  if (recommendation.mode !== 'recommend') return false;
  return tier === 'asr-word' || tier === 'asr-cue' || tier === 'manual-cue';
}
