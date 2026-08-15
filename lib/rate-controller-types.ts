// Rate-controller types (lib/rate-controller.ts): the shared deps contract
// and the E2E hook shape. Split out because the factory plus the verbatim
// moves from the entrypoints would otherwise exceed the aislop file-size
// budget — the same reason ui/pill-css.ts and ui/nudge-host.ts exist.

import type { NudgeSurface } from '../ui/nudge-host';
import type { PillState } from '../ui/pill';
import type { LanguageModel, RateRange, RateUnit } from './languages';
import type { BridgeClient } from './messaging';
import type { ContentType } from './music';
import type { RateTier, Recommendation } from './recommend';

export type { CaptionStatus } from '../ui/pill';

/** The empty pill state every reset/teardown shows (rate 0, no label). */
export const NONE_PILL_STATE: PillState = { mode: 'none', rateWpm: 0, multiplier: 1, effectiveWpm: 0, label: '' };

/** The current-video context; the content side extends it with the
 * videoId/language/target the wpm:get answer builder reads. */
export interface RateCurrent {
  site: string;
  contentType: ContentType;
  naturalRate: number;
  platformMax: number;
  tier: RateTier;
  /** Rate-unit display label, resolved by the track language when known. */
  unit: string;
  recommendation: Recommendation;
  /** The track language's safe zone — the pill warning and nudge copy key
   * on it (P0); en defaults when the track language is unmapped. */
  range: RateRange;
}

/** Everything renderRecommendation hands to makeCurrent; each side picks
 * the fields it keeps in its context. */
interface RecommendationParts extends RateCurrent {
  videoId: string;
  /** The track language's unit code; the display label is RateCurrent.unit. */
  unit: RateUnit;
  language?: LanguageModel;
  /** The resolved user target (settings override, else the language's); the
   * content side keeps it as the wpm:get answer's target. */
  userTarget: number | undefined;
}

/** The pill's chapter-plan fields; the generic path has no chapter hooks. */
interface ChapterExtras {
  chaptersAvailable: boolean;
  autoAdjust: boolean;
  chapterStatus?: 'active' | 'yielded' | 'music';
}

/** YouTube-only chapter wiring: the plan rides the pill render, the consent
 * toggle arms the scheduler, and navigation drops both. */
interface ChapterHooks {
  extras(): ChapterExtras;
  /** Consent toggle: arms the scheduler on the active video (a no-op
   * without a plan or element), or stops it. The apply callback routes
   * boundary steps through the shared apply choke point as 'adjust'. */
  onConsent(enabled: boolean, video: HTMLVideoElement | null, apply: (multiplier: number) => number): void;
  /** Navigation reset: drop the plan and consent, stop the scheduler. */
  onReset(): void;
}

export interface RateControllerDeps<C extends RateCurrent> {
  bridge: BridgeClient;
  nudgeSurface: NudgeSurface;
  /** The pill's mount anchor: #movie_player on YouTube, body elsewhere. */
  hostAnchor(): HTMLElement;
  /** Applies the clamped rate: direct assignment on YouTube, the re-assert
   * loop on the generic path (Vimeo resets playbackRate on pause/play). */
  applyRate(video: HTMLVideoElement, rate: number, platformMax: number): void;
  /** Detaches the re-assert loop before an undo or override (generic); a
   * no-op on YouTube, which has no loop. */
  stopRateApplies(): void;
  makeCurrent(parts: RecommendationParts): C;
  /** The override log's video id: the measured videoId on YouTube, the page
   * href on the generic path. */
  videoIdOf(current: C): string;
  /** Skip-silence wiring: the actuator's lifecycle rides the controller's
   * apply/undo plumbing, but the actuator and the gap plan stay page-side
   * (the generic path pairs it with the re-assert loop). */
  skip: SkipHooks;
  /** A media event fired on a NEW active element (already adopted). The
   * generic path ends the old video's session and re-measures; the youtube
   * path omits it. endSession is the controller's own. */
  onVideoSwap?(endSession: () => void): void;
  chapter?: ChapterHooks;
}

/** E2E hook (SEC-2): the pill's shadow root is closed, so the specs read
 * state and trigger apply/dismiss here. The store bundle ships without it. */
export interface PillTestHook {
  state: PillState | null;
  apply(): void;
  dismiss(): void;
  stopAuto?(): void;
}

/** Skip-silence wiring: the actuator dips the rate inside caption gaps
 * after an apply; the content scripts own the actuator and the gap plan. */
export interface SkipHooks {
  /** Arms the actuator for this apply; a no-op without a gap plan. */
  attach(video: HTMLVideoElement, applied: number): void;
  /** Detaches the actuator (session end, override, dismiss, stop-auto). */
  detach(): void;
  /** True when `rate` is the actuator's own dip — the override guard treats
   * it as our own write, not a user takeover. */
  isOwnDip(rate: number): boolean;
}
