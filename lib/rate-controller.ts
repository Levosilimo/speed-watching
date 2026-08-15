// Shared per-video rate controller: the auto-apply lifecycle, the pill host
// with its live-rate and saved-time lines, the override/undo plumbing, and
// the override log that both content scripts run. The page deltas are deps
// (lib/rate-controller-types.ts): the pill anchor, the apply mechanism, and
// the current-video context.

import { createPill, type AppliedSource, type CaptionStatus, type LiveRate, type PillApi, type PillEvents, type PillState } from '../ui/pill';
import { OVERLAY_Z_INDEX, ensureAutohideCouplingCss } from '../ui/styles';
import { shouldAutoApply } from './auto-apply';
import type { LanguageModel, RateRange } from './languages';
import { SerializedRunner } from './measure-guard';
import type { ContentType } from './music';
import { recommend, SAFE_ZONE_CEILING_WPM, TARGET_WPM, type RateTier } from './recommend';
import { defaultSettings, resolvePlatformMax, resolveUserTarget, type Settings } from './settings';
import { RATE_EPSILON, savedSeconds, TimeSavedTracker, type SavedTick } from './time-saved';
import type { PillTestHook, RateControllerDeps, RateCurrent } from './rate-controller-types';

export function createRateController<C extends RateCurrent>(deps: RateControllerDeps<C>) {
  const chapter = deps.chapter;

  /** Current video's recommendation context; null until the first measure. */
  let current: C | null = null;
  let pill: { api: PillApi; host: HTMLElement } | null = null;
  /** Last rendered pill state — the shortcut handler and live line gate on it. */
  let pillState: PillState | null = null;
  /** The element that last fired a media event — the apply target. */
  let activeVideo: HTMLVideoElement | null = null;

  // Auto-apply lifecycle (per video): 'pending' until the first measure, 'auto' after a self-apply, 'stopped' after override/dismiss/Stop-auto.
  let autoState: 'pending' | 'auto' | 'stopped' = 'pending';
  /** How the current rate got applied — rides into the pill as applied. */
  let appliedSource: AppliedSource = 'none';
  /** The pre-auto playback rate the Stop-auto/dismiss undo restores (P1a). */
  let preAutoRate: number | null = null;

  /** Video epoch: bumped by every reset so an in-flight measure goes stale. */
  let epoch = 0;

  // Time-saved session (lib/time-saved.ts): the tracker counts wall time at
  // the applied rate; flushes ride the bridge to the background store.
  const savedTracker = new TimeSavedTracker();
  /** Saved seconds accumulated for the current video; null before apply. */
  let savedSec: number | null = null;
  /** The multiplier the session is gated on; null while no session runs. */
  let savedMultiplier: number | null = null;

  const measureRunner = new SerializedRunner();

  const NONE_STATE: PillState = { mode: 'none', rateWpm: 0, multiplier: 1, effectiveWpm: 0, label: '' };

  /** E2E hook (SEC-2); showPill keeps its state in sync — the apply gate mirrors ui/pill.ts wireEvents (music/unreachable never touch the rate). */
  const pillHook: PillTestHook = {
    state: null,
    apply: () => {
      if (current === null) return;
      if (current.recommendation.mode === 'music' || current.recommendation.mode === 'unreachable') return;
      applyMultiplier(current.recommendation.multiplier);
    },
    dismiss: () => dismissCurrent(),
    stopAuto: () => stopAutoForVideo(),
  };

  async function loadSettings(): Promise<Settings> {
    try {
      return await deps.bridge.request({ type: 'settings:get' });
    } catch {
      return defaultSettings(); // dead or timed-out bridge
    }
  }

  /** Serializes a measure; startedAt is the epoch at launch, the staleness guard. */
  function runMeasure(fn: (startedAt: number) => Promise<void>): void {
    measureRunner.run(() => fn(epoch));
  }

  /** Host wrapper inside the anchor; positioning only — ui/pill.ts owns the look. */
  function pillHost(): HTMLElement {
    const anchor = deps.hostAnchor();
    const existing = anchor.querySelector<HTMLElement>(':scope > .speedwatcher-pill-host');
    if (existing !== null) return existing;
    const wrapper = document.createElement('div');
    wrapper.className = 'speedwatcher-pill-host';
    wrapper.style.zIndex = String(OVERLAY_Z_INDEX);
    ensureAutohideCouplingCss(wrapper.ownerDocument);
    return anchor.appendChild(wrapper) as HTMLElement;
  }

  /** User-initiated apply (pill button, shortcut): auto stops, source user. */
  function userApply(multiplier: number): void {
    autoState = 'stopped';
    appliedSource = 'user';
    preAutoRate = null;
    applyMultiplier(multiplier);
  }

  const pillEvents: PillEvents = { onApply: userApply, onDismiss: dismissCurrent, onStopAuto: stopAutoForVideo };
  if (chapter !== undefined) {
    pillEvents.onAutoAdjust = (enabled: boolean): void => {
      const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
      chapter.onConsent(enabled, video, (multiplier) => applyAndTrack(multiplier, 'adjust'));
      if (pillState !== null) {
        const extras = chapter.extras();
        showPill({ ...pillState, autoAdjust: enabled, chapterStatus: extras.chapterStatus });
      }
    };
  }

  function ensurePill(): PillApi {
    const host = pillHost();
    if (pill !== null && pill.host === host && host.isConnected) return pill.api;
    // The player was replaced (SPA navigation): rebuild on the fresh host.
    pill?.api.destroy();
    const api = createPill(host, pillEvents);
    api.mount();
    pill = { api, host };
    return pill.api;
  }

  function showPill(state: PillState): void {
    pillState = state;
    ensurePill().update(state);
    if (__E2E__) pillHook.state = state;
  }

  function showNone(): void {
    showPill(NONE_STATE);
  }

  function computeLiveRate(): LiveRate | null {
    if (current === null) return null;
    const mode = current.recommendation.mode;
    if (mode !== 'recommend' && mode !== 'warning') return null;
    // Estimated-tier rates are priors, not measurements — never present one as live.
    if (current.tier === 'estimated') return null;
    const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
    if (video === null || video.paused || video.playbackRate === 1) return null;
    return { rate: current.naturalRate * video.playbackRate, multiplier: video.playbackRate, unit: current.unit };
  }

  function refreshLiveRate(): void {
    // Never create the pill from a tick — that would mount an empty one pre-measure.
    if (pill === null) return;
    pill.api.updateLiveRate(computeLiveRate());
  }

  /** The session's accumulated flushes, null before apply, while paused, or the rate diverged. */
  function computeSavedSec(): number | null {
    if (current === null || savedSec === null || savedMultiplier === null) return null;
    const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
    if (video === null || video.paused) return null;
    if (Math.abs(video.playbackRate - savedMultiplier) > RATE_EPSILON) return null;
    return savedSec;
  }

  function refreshSavedSec(): void {
    if (pill === null) return;
    pill.api.updateSavedSec(computeSavedSec());
  }

  /** Disengages auto-apply: the auto rate is undone to the pre-auto rate
   * (P1a) and the pill drops its stop-auto state. Not logged — auto's own
   * entries already exist. */
  function stopAutoForVideo(): void {
    if (current === null) return;
    const wasAuto = appliedSource === 'auto';
    autoState = 'stopped';
    appliedSource = 'none';
    // Detach the loop and the skip actuator BEFORE restoring: the reapplier's
    // ratechange listener would otherwise treat the restored 1.0 as a reset
    // and re-assert it, and the actuator would re-dip it inside gaps.
    deps.stopRateApplies();
    deps.skip.detach();
    if (wasAuto && preAutoRate !== null) restorePreAutoRate();
    preAutoRate = null;
    if (pillState !== null) showPill({ ...pillState, applied: 'none', undoRate: undefined });
  }

  function restorePreAutoRate(): void {
    const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
    if (video === null) return;
    video.playbackRate = preAutoRate ?? 1;
  }

  /** Manual-override detection on ratechange: divergence from the applied
   * value (except a reset to exactly 1.0) labels the source user. */
  function markUserOverride(): void {
    if (autoState !== 'auto') return;
    const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
    if (video === null || video.paused) return;
    if (video.playbackRate === 1) return; // reset, not an override
    if (savedMultiplier === null) return;
    if (Math.abs(video.playbackRate - savedMultiplier) <= RATE_EPSILON) return; // our own apply
    // Our own skip-silence dip is not an override — the actuator holds the
    // pause target inside a gap.
    if (deps.skip.isOwnDip(video.playbackRate)) return;
    autoState = 'stopped';
    appliedSource = 'user';
    preAutoRate = null; // the user took over — no undo anchor left
    // The user took over: detach the re-assert loop and the skip actuator,
    // or a later reset to exactly 1.0 would fight back (mirror of stopAutoForVideo).
    deps.stopRateApplies();
    deps.skip.detach();
    if (pillState !== null) showPill({ ...pillState, applied: 'user', undoRate: undefined });
  }

  /** Shared apply choke point: clamp, tracker attach, live/saved refresh,
   * nudge report, override log. `action` distinguishes user/auto applies
   * ('apply') from scheduler steps ('adjust'); returns the applied rate. */
  function applyAndTrack(multiplier: number, action: 'apply' | 'adjust'): number {
    if (current === null) return multiplier;
    const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
    if (video === null) return multiplier;
    // recommend() already clamps to platformMax; min() re-states the invariant.
    const applied = Math.min(multiplier, current.platformMax);
    deps.applyRate(video, applied, current.platformMax);
    savedSec = 0;
    savedMultiplier = applied;
    savedTracker.attach(video, applied, flushSavedTick);
    // Skip-silence: arm the actuator for this video's gap plan (no-op without one).
    deps.skip.attach(video, applied);
    // Show the live line immediately; steady-state ticks are throttled in the pill.
    refreshLiveRate();
    refreshSavedSec();
    void logAction(action, multiplier);
    deps.nudgeSurface.reportApply(multiplier, current.range);
    return applied;
  }

  function applyMultiplier(multiplier: number): void {
    applyAndTrack(multiplier, 'apply');
  }

  function applyAdjust(multiplier: number): number {
    return applyAndTrack(multiplier, 'adjust');
  }

  function dismissCurrent(): void {
    if (current === null) return;
    const wasAuto = appliedSource === 'auto';
    autoState = 'stopped';
    appliedSource = 'none';
    // Detach first: the unflushed tail is credited to the store before the
    // pill hides.
    savedTracker.detach();
    savedSec = null;
    savedMultiplier = null;
    deps.stopRateApplies();
    deps.skip.detach();
    if (wasAuto && preAutoRate !== null) restorePreAutoRate();
    preAutoRate = null;
    showPill(NONE_STATE);
    void logAction('dismiss', current.recommendation.multiplier);
  }

  /** Best-effort: a dead bridge must not undo the playback change. */
  function logAction(userAction: 'apply' | 'dismiss' | 'adjust', multiplier: number): void {
    if (current === null) return;
    void deps.bridge
      .request({
        type: 'log:append',
        entry: {
          videoId: deps.videoIdOf(current),
          site: current.site,
          contentType: current.contentType,
          naturalRate: current.naturalRate,
          multiplier,
          mode: current.recommendation.mode,
          userAction,
        },
      })
      .catch(() => undefined);
  }

  /** Tracker flush → the background store (fire-and-forget like logAction). */
  function flushSavedTick(tick: SavedTick): void {
    if (savedSec !== null) savedSec += savedSeconds(tick.deltaSec, tick.multiplier);
    void deps.bridge
      .request({ type: 'timeSaved:accrue', deltaSec: tick.deltaSec, multiplier: tick.multiplier })
      .catch(() => undefined);
  }

  /** Re-renders only when the scheduler status changed (steps flow through onMediaEvent). */
  function refreshChapterStatus(): void {
    if (chapter === undefined || pillState === null) return;
    const extras = chapter.extras();
    if (!extras.autoAdjust) return;
    if (pillState.chapterStatus !== extras.chapterStatus) {
      showPill({ ...pillState, chapterStatus: extras.chapterStatus });
    }
  }

  function onMediaEvent(event: Event): void {
    if (event.target instanceof HTMLVideoElement && event.target !== activeVideo) {
      activeVideo = event.target;
      deps.onVideoSwap?.(endSession);
    }
    markUserOverride();
    refreshLiveRate();
    refreshSavedSec();
    refreshChapterStatus();
  }

  /** Ends the session (tracker, lifecycle, nudge) and bumps the epoch — the
   * generic path's video-swap/removal subset of reset(). */
  function endSession(): void {
    savedTracker.detach();
    savedSec = null;
    savedMultiplier = null;
    deps.skip.detach();
    epoch += 1;
    autoState = 'pending';
    appliedSource = 'none';
    preAutoRate = null;
    deps.nudgeSurface.teardown();
  }

  /** Full video reset (YouTube navigation): recommendation, element, pill. */
  function reset(): void {
    current = null;
    activeVideo = null;
    endSession();
    showPill(NONE_STATE);
    chapter?.onReset();
  }

  /** Adopts a new active element and ends the old session; the caller re-measures. */
  function adoptVideo(video: HTMLVideoElement): void {
    activeVideo = video;
    endSession();
  }

  /** The active video left the DOM: destroy the pill, drop the re-assert loop and the recommendation. */
  function onVideoRemoved(): void {
    if (pill !== null) {
      pill.api.update(NONE_STATE);
      pill.api.destroy();
      pill = null;
    }
    deps.stopRateApplies();
    current = null;
    endSession();
  }

  function renderRecommendation(
    videoId: string,
    naturalRate: number,
    tier: RateTier,
    contentType: ContentType,
    settings: Settings,
    site: string,
    wordInputs?: { articulatoryWpm: number; timingCoverageOk: boolean } | null,
    language?: LanguageModel,
    startedAt?: number,
    captionStatus?: CaptionStatus,
  ): void {
    // The video reset while this measure was in flight: render nothing.
    if (startedAt !== undefined && epoch !== startedAt) return;
    const platformMax = resolvePlatformMax(settings, site);
    const range: RateRange = {
      lo: language?.target ?? TARGET_WPM,
      hi: language?.ceiling ?? SAFE_ZONE_CEILING_WPM,
      unit: language?.unit ?? 'wpm',
    };
    const userTarget = resolveUserTarget(settings, site, contentType);
    const recommendation = recommend({
      naturalRate,
      tier,
      contentType,
      platformMax,
      userTarget,
      language,
      ...wordInputs,
    });
    current = deps.makeCurrent({
      videoId,
      site,
      contentType,
      naturalRate,
      platformMax,
      tier,
      unit: language?.unit ?? 'wpm',
      language,
      userTarget,
      recommendation,
      range,
    });
    if (autoState === 'pending' && shouldAutoApply(settings, recommendation, tier, contentType)) {
      // The undo anchor: the rate the user was at before auto took over.
      preAutoRate = (activeVideo ?? document.querySelector<HTMLVideoElement>('video'))?.playbackRate ?? null;
      applyMultiplier(recommendation.multiplier);
      autoState = 'auto';
      appliedSource = 'auto';
    }
    // P1c: the one-time first-run explainer rides the first recommend-mode
    // render of a MEASURED tier (estimated priors are not one). The flag
    // persists via the bridge — best-effort.
    const firstRun = settings.seenFirstRun !== true && tier !== 'estimated' && recommendation.mode === 'recommend';
    if (firstRun) {
      void deps.bridge.request({ type: 'settings:seenFirstRun' }).catch(() => undefined);
    }
    showPill({
      mode: recommendation.mode,
      rateWpm: naturalRate,
      multiplier: recommendation.multiplier,
      effectiveWpm: recommendation.effectiveWpm,
      tierLabel: recommendation.tierLabel,
      label: recommendation.label,
      reason: recommendation.reason ?? undefined,
      range,
      applied: appliedSource,
      undoRate: appliedSource === 'auto' ? preAutoRate ?? 1 : undefined,
      firstRun,
      captionStatus,
      ...chapter?.extras(),
    });
  }

  return {
    reset,
    endSession,
    adoptVideo,
    onVideoRemoved,
    onMediaEvent,
    showPill,
    showNone,
    renderRecommendation,
    refreshChapterStatus,
    applyMultiplier,
    applyAdjust,
    userApply,
    dismissCurrent,
    stopAutoForVideo,
    runMeasure,
    loadSettings,
    pillHook,
    get current() { return current; },
    get pillState() { return pillState; },
    get activeVideo() { return activeVideo; },
  };
}
