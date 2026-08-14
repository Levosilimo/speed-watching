// Auto-apply: per-video, opt-in application of the fresh recommendation.
// Pure module shared by both content scripts (entrypoints/content.ts and
// entrypoints/generic.content.ts) — no DOM, no chrome.*, unit-testable.
//
// Honest limits: auto keys on the RESOLVED content type (generic/news
// resolve → pill-only unless the user forces a type); mode 'recommend'
// guarantees reason===null but the multiplier may still be clamp-capped
// (MANUAL_CUE_CLAMP 1.5) — auto applies that same value; a manual reset to
// exactly 1.0 is not an override (sentinel semantics) — YouTube leaves auto
// armed at 1x, generic re-asserts to the auto rate; auto applies log as
// userAction 'apply' and count toward the recall nudge — deliberate, the
// user opted in (a distinct 'auto' variant would widen the log schema);
// Stop-auto never reverts the rate, only disengages auto for this video.
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
