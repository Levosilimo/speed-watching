// E2E hooks: one-line console.info wpm summaries compiled out of the store
// bundle (SEC-2). MAIN world — the signed timedtext fetch needs page
// context; entrypoints/bridge.content.ts is the ISOLATED sibling.
// The file also carries the time-saved accrual plumbing (lib-13) on top of
// the measurement pipeline, which keeps it past the 440-line reviewability
// budget; the suppression mirrors the console-leftover one — reviewed
// exceptions, not license to grow further.
// aislop-ignore-file console-leftover, file-too-large
import { defineContentScript } from 'wxt/utils/define-content-script';
import { fetchAndroidCaptions, fetchJson3 } from '@/lib/caption-fetch';
import { parseYouTubeJson3 } from '@/lib/captions';
import { cueSignal, detectContentType, priorMidpoint } from '@/lib/heuristics';
import { resolveLanguage, UNIT_LABELS, type LanguageModel, type RateRange } from '@/lib/languages';
import { logWpm, waitForPlayerResponse } from '@/lib/measure-hooks';
import { SerializedRunner } from '@/lib/measure-guard';
import { buildWpmResponse, type MeasurementContext } from '@/lib/wpm-provider';
import { createBridgeClient, isShortcutEnvelope, SHORTCUT_APPLY } from '@/lib/messaging';
import { isWpmEnvelope, isWpmGetRequest, WPM_CHANNEL } from '@/lib/wpm-protocol';
import type { ContentType } from '@/lib/music';
import { detectMusic } from '@/lib/music';
import { shouldAutoApply } from '@/lib/auto-apply';
import { recommend, SAFE_ZONE_CEILING_WPM, TARGET_WPM, type RateTier, type Recommendation } from '@/lib/recommend';
import { segmentRates, type RateSegment } from '@/lib/chapters';
import { ChapterScheduler } from '@/lib/chapter-scheduler';
import {
  defaultSettings,
  resolveContentType,
  resolvePlatformMax,
  resolveUserTarget,
  type Settings,
} from '@/lib/settings';
import {
  asrTierInputs,
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  totalWords,
  wordLevelWpm,
} from '@/lib/wpm';
import type { CaptionTrack, PlayerResponse } from '@/lib/youtube';
import { channelKeyOf, chaptersOf } from '@/lib/youtube';
import { createPill, type AppliedSource, type LiveRate, type PillApi, type PillState } from '@/ui/pill';
import { createNudgeHost } from '@/ui/nudge-host';
import {
  RATE_EPSILON,
  savedSeconds,
  TimeSavedTracker,
  type SavedTick,
} from '@/lib/time-saved';

const bridge = createBridgeClient(window);
const nudgeSurface = createNudgeHost(bridge);

/** Current video's recommendation context; null until the first measure. */
let current: (MeasurementContext & {
  videoId: string;
  recommendation: Recommendation;
  /** The track language's safe zone — the pill warning and nudge copy key
   * on it (P0); en defaults when the track language is unmapped. */
  range: RateRange;
}) | null = null;
let pill: { api: PillApi; host: HTMLElement } | null = null;

/** Last rendered pill state — the shortcut handler and live line gate on it. */
let pillState: PillState | null = null;

/** The element that last fired a media event — the apply target on pages
 * with more than one video. */
let activeVideo: HTMLVideoElement | null = null;

// Auto-apply lifecycle (per video): 'pending' until the first measure, then
// 'auto' once a candidate recommendation applied itself, 'stopped' after a
// manual override, dismiss, or Stop-auto. A non-candidate measure leaves it
// 'pending' so a later re-measure can still auto.
let autoState: 'pending' | 'auto' | 'stopped' = 'pending';
/** How the current rate got applied — rides into the pill as applied. */
let appliedSource: AppliedSource = 'none';
/** The playback rate that was playing before auto applied it (P1a): the
 * Stop-auto/dismiss undo restores this, not a blind 1×. null while auto
 * never applied this video, and after the user takes over manually. */
let preAutoRate: number | null = null;

/** Navigation epoch: bumped by every video reset (onNavigationStart) so an
 * in-flight measure that began before the reset cannot render — or
 * auto-apply — after it. The stale measure's recommendation belongs to the
 * old video; without the guard it would apply the old multiplier to the new
 * video and set autoState='auto', blocking the fresh measure's apply. */
let epoch = 0;

// Time-saved session (lib/time-saved.ts): the tracker counts wall time at
// the applied rate; the pill shows the accumulated saved seconds of the
// current video (null before apply, while paused, or while the rate
// diverged), and the flushes ride the bridge to the background store.
const savedTracker = new TimeSavedTracker();
/** Saved seconds accumulated for the current video; null before apply. */
let savedSec: number | null = null;
/** The multiplier the session is gated on; null while no session runs. */
let savedMultiplier: number | null = null;

// Serializes measure() against overlapping triggers (initial load + SPA navigation).
const measureRunner = new SerializedRunner();

// Per-chapter rate plan (chapters feature): built once per measure when the
// page exposes chapter markers; null without them (or on the estimated tier).
let chapterRates: RateSegment[] | null = null;
/** Session-scoped consent: the pill toggle arms the scheduler per video. */
let chapterConsent = false;
/** Applies the current segment's multiplier at every chapter boundary. */
const chapterScheduler = new ChapterScheduler();

const NONE_STATE: PillState = {
  mode: 'none',
  rateWpm: 0,
  multiplier: 1,
  effectiveWpm: 0,
  label: '',
};

// E2E hooks (same pattern as the speedwatcher:measure event): the pill's
// shadow root is closed, so specs read state and trigger apply/dismiss here.

declare global {
  interface Window {
    __speedwatcherPill?: {
      state: PillState | null;
      apply(): void;
      dismiss(): void;
      stopAuto?(): void;
    };
    __speedwatcherCaptionSource?: 'web' | 'android' | 'none';
    // E2E hook: settings write through the bridge (same path the options
    // page uses) — the shared specs exercise the bridge in both browsers.
    __speedwatcherSettings?: { set(settings: Settings): Promise<void> };
    // E2E hook: the chapter scheduler's plan, the enforced segment, and a
    // seek+tick driver (currentTime + timeupdate) for boundary tests.
    __speedwatcherChapter?: {
      rates: RateSegment[];
      activeIndex: number;
      applyFor(sec: number): void;
    };
  }
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  world: 'MAIN',
  main() {
    if (!location.pathname.startsWith('/watch')) return;
    document.addEventListener('play', onMediaEvent, true);
    document.addEventListener('playing', onMediaEvent, true);
    document.addEventListener('timeupdate', onMediaEvent, true);
    // Live-rate line: ratechange and pause also drive the throttled refresh.
    document.addEventListener('ratechange', onMediaEvent, true);
    document.addEventListener('pause', onMediaEvent, true);
    // Keyboard shortcuts (chrome.commands): the background → bridge → window
    // chain delivers the envelope here — chrome.* is unavailable in this
    // world. Gated like the pill's Apply button.
    window.addEventListener('message', (event: MessageEvent): void => {
      if (!isShortcutEnvelope(event.data)) return;
      const message = event.data.message;
      if (message.type === SHORTCUT_APPLY) {
        if (current === null || pillState === null || (pillState.mode !== 'recommend' && pillState.mode !== 'warning')) return;
        autoState = 'stopped';
        appliedSource = 'user';
        preAutoRate = null;
        applyMultiplier(current.recommendation.multiplier);
      } else if (pillState !== null && pillState.mode !== 'none') dismissCurrent();
    });
    // Measured-rate provider (Tier 4): relays wpm:get to the answer builder;
    // no source guard, like the shortcut relay (the bridge validates the
    // response, and the channel carries only the minimized measurement).
    window.addEventListener('message', (event: MessageEvent): void => {
      if (!isWpmEnvelope(event.data) || !isWpmGetRequest(event.data.message)) return;
      window.postMessage({ channel: WPM_CHANNEL, message: buildWpmResponse(current) }, '*');
    });
    // E2E-only hooks (SEC-2): the store bundle ships without these.
    if (__E2E__) {
      window.__speedwatcherPill = {
        state: null,
        // Mirrors the pill's own Apply gate (ui/pill.ts wireEvents): music and
        // unreachable states must not touch playbackRate.
        apply: () => {
          if (current === null) return;
          if (current.recommendation.mode === 'music' || current.recommendation.mode === 'unreachable') return;
          applyMultiplier(current.recommendation.multiplier);
        },
        dismiss: () => dismissCurrent(),
        stopAuto: () => stopAutoForVideo(),
      };
      window.__speedwatcherSettings = {
        set: (settings) => bridge.request({ type: 'settings:set', settings }).then(() => undefined),
      };
      window.__speedwatcherChapter = {
        get rates() {
          return chapterRates ?? [];
        },
        get activeIndex() {
          return chapterScheduler.activeIndex;
        },
        // Seek + tick: the scheduler steps on timeupdate, so the driver
        // crosses boundaries without the fixture video ever playing.
        applyFor: (sec: number) => {
          const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
          if (video === null) return;
          video.currentTime = sec;
          video.dispatchEvent(new Event('timeupdate'));
        },
      };
    }
    void measure();
    // SPA navigation: invalidate the old video's recommendation before the
    // next measure lands, so a fast Apply cannot use the previous multiplier.
    document.addEventListener('yt-navigate-start', onNavigationStart);
    document.addEventListener('yt-navigate-finish', () => void measure());
  },
});

function onNavigationStart(): void {
  epoch += 1;
  current = null;
  activeVideo = null;
  savedTracker.detach();
  savedSec = null;
  savedMultiplier = null;
  autoState = 'pending';
  appliedSource = 'none';
  preAutoRate = null;
  chapterRates = null;
  chapterConsent = false;
  chapterScheduler.stop();
  showPill(NONE_STATE);
  nudgeSurface.teardown();
}

function onMediaEvent(event: Event): void {
  if (event.target instanceof HTMLVideoElement) activeVideo = event.target;
  markUserOverride();
  refreshLiveRate();
  refreshSavedSec();
  refreshChapterStatus();
}

function isLive(): boolean {
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video?.duration === Infinity) return true;
  return document.querySelector('.ytp-live-badge') !== null;
}

function measure(): void {
  measureRunner.run(measureOnce);
}

async function measureOnce(): Promise<void> {
  const startedAt = epoch;
  const response = await waitForPlayerResponse();
  if (!response) {
    if (__E2E__) console.info('[speed-watcher] wpm: player response never appeared');
    return;
  }
  if (isLive()) {
    if (__E2E__) console.info('[speed-watcher] wpm: live stream — pill suppressed');
    showPill(NONE_STATE);
    return;
  }
  const videoId = response.videoDetails?.videoId ?? '?';
  const settings = await loadSettings();
  // Options-page overrides key on the bare hostname ('youtube.com').
  const site = location.hostname.replace(/^www\./, '');
  const track = response.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
  const language = resolveLanguage(track?.languageCode) ?? undefined;
  if (track === undefined) {
    if (__E2E__) console.info('[speed-watcher] wpm: no caption tracks for this video — estimated');
    void showEstimatedPill(videoId, settings, site, undefined, response.videoDetails, startedAt);
    return;
  }
  const json = await fetchCaptions(track, videoId);
  if (json === null) {
    if (__E2E__) console.info('[speed-watcher] wpm: caption fetch failed — estimated');
    void showEstimatedPill(videoId, settings, site, language, response.videoDetails, startedAt);
    return;
  }
  const { words, cues } = parseYouTubeJson3(json);
  // Chapter markers ride the page's ytInitialData (not the player response);
  // absent → null and the feature stays off for this video.
  chapterRates = null; // any earlier plan belongs to a previous measure
  const chapters = chaptersOf(window.ytInitialData);
  const kind = track.kind ?? 'manual';
  const lang = track.languageCode ?? '?';
  if (words.length >= 2) {
    logWpm(videoId, kind, lang, {
      word: wordLevelWpm(words),
      cue: cueLevelWpm(cues),
      corrected: correctedCueLevelWpm(cues),
      nWords: totalWords(words),
    });
  } else if (cues.length > 0) {
    logWpm(videoId, kind, lang, {
      cue: cueLevelWpm(cues),
      corrected: correctedCueLevelWpm(cues),
      nWords: totalWords(cues),
    });
  } else {
    if (__E2E__) {
      console.info(`[speed-watcher] video=${videoId} kind=${kind} lang=${lang}: captions parsed but empty — estimated`);
    }
    void showEstimatedPill(videoId, settings, site, language, response.videoDetails, startedAt);
    return;
  }

  const naturalRate =
    kind === 'asr' ? filteredTokensOverTrimmedSpan(cues, language) : manualCueRate(cues, language);
  if (naturalRate === null) {
    void showEstimatedPill(videoId, settings, site, language, response.videoDetails, startedAt);
    return;
  }
  // Auto-detect the register from the measured signal; the user/site
  // preference still outranks it in resolveContentType. Music is checked
  // first — lyric tracks share no speech register (detectContentType
  // never returns 'music').
  const signal = cueSignal(cues, naturalRate, language);
  let detected: ContentType = signal === null ? 'generic' : detectContentType(signal);
  if (detectMusic(cues, naturalRate, language?.unit ?? 'wpm')) detected = 'music';
  const contentType = resolveContentType(settings, site, detected);
  const { tier, wordInputs } = asrTierInputs(kind, words, cues);
  // The per-chapter plan: one rate per chapter through the same per-kind rule
  // and recommend() inputs as the whole-video recommendation below. Sub-floor
  // chapters inherit the whole-video recommendation inside segmentRates.
  if (chapters !== null) {
    chapterRates = segmentRates(cues, chapters, kind, language, {
      platformMax: resolvePlatformMax(settings, site),
      contentType,
      userTarget: resolveUserTarget(settings, site, contentType),
    });
  }
  renderRecommendation(videoId, naturalRate, tier, contentType, settings, site, wordInputs, language, startedAt);
  rememberChannelRate(response.videoDetails, naturalRate, language);
}

/** No usable caption rate: heuristic prior midpoint for the content type,
 * in the language's unit when the track language is known — or the
 * channel's last measured rate when it was measured in the same language. */
async function showEstimatedPill(
  videoId: string,
  settings: Settings,
  site: string,
  language?: LanguageModel,
  videoDetails?: PlayerResponse['videoDetails'],
  startedAt?: number,
): Promise<void> {
  const contentType = resolveContentType(settings, site, 'generic');
  const seeded = await channelSeededRate(videoDetails, language);
  renderRecommendation(videoId, seeded ?? priorMidpoint(contentType, language), 'estimated', contentType, settings, site, null, language, startedAt);
  // Demand proxy (Phase-2 STT gate): one local count per estimated render.
  // Best-effort like logAction — a dead bridge must not suppress the pill.
  void bridge
    .request({ type: 'demand:increment', contentType })
    .catch(() => undefined);
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
): void {
  // The video reset while this measure was in flight (navigation epoch):
  // the recommendation belongs to the old video — render nothing.
  if (startedAt !== undefined && epoch !== startedAt) return;
  const platformMax = resolvePlatformMax(settings, site);
  const range: RateRange = {
    lo: language?.target ?? TARGET_WPM,
    hi: language?.ceiling ?? SAFE_ZONE_CEILING_WPM,
    unit: language?.unit ?? 'wpm',
  };
  const recommendation = recommend({
    naturalRate,
    tier,
    contentType,
    platformMax,
    userTarget: resolveUserTarget(settings, site, contentType),
    language,
    ...wordInputs,
  });
  current = { videoId, site, contentType, naturalRate, platformMax, tier,
    unit: UNIT_LABELS[language?.unit ?? 'wpm'], language: language?.code ?? null,
    target: resolveUserTarget(settings, site, contentType) ?? language?.target ?? TARGET_WPM,
    recommendation, range };
  if (autoState === 'pending' && shouldAutoApply(settings, recommendation, tier, contentType)) {
    // The undo anchor: the rate the user was at before auto took over.
    preAutoRate =
      (activeVideo ?? document.querySelector<HTMLVideoElement>('video'))?.playbackRate ?? null;
    applyMultiplier(recommendation.multiplier);
    autoState = 'auto';
    appliedSource = 'auto';
  }
  // P1c: the one-time first-run explainer rides the first recommend-mode
  // render of a MEASURED tier (the copy promises a measurement; estimated
  // priors are not one). The flag persists via the bridge — best-effort, a
  // dead bridge only re-shows it on the next video.
  const firstRun =
    settings.seenFirstRun !== true && tier !== 'estimated' && recommendation.mode === 'recommend';
  if (firstRun) {
    void bridge.request({ type: 'settings:seenFirstRun' }).catch(() => undefined);
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
    chaptersAvailable: chapterRates !== null,
    autoAdjust: chapterConsent,
    chapterStatus: chapterConsent ? chapterStatusNow() : undefined,
  });
}

async function loadSettings(): Promise<Settings> {
  try {
    return await bridge.request({ type: 'settings:get' });
  } catch {
    // Bridge dead or timed out: recommend against the lib defaults.
    return defaultSettings();
  }
}

// ── Caption fetch: WEB primary, ANDROID innertube fallback ────────────────

async function fetchCaptions(track: CaptionTrack, videoId: string): Promise<unknown | null> {
  const web = await fetchJson3(track.baseUrl);
  if (web !== null) {
    if (__E2E__) window.__speedwatcherCaptionSource = 'web';
    return web;
  }
  const android = await fetchAndroidCaptions(videoId);
  if (android !== null) {
    if (__E2E__) window.__speedwatcherCaptionSource = 'android';
    return android;
  }
  if (__E2E__) window.__speedwatcherCaptionSource = 'none';
  return null;
}

// ── Pill ──────────────────────────────────────────────────────────────────

/** Host wrapper inside the player area; the pill's shadow root lives here.
 * Positioning only — ui/pill.ts owns the look. */
function pillHost(): HTMLElement {
  const anchor = document.querySelector<HTMLElement>('#movie_player') ?? document.body;
  const existing = anchor.querySelector<HTMLElement>(':scope > .speedwatcher-pill-host');
  if (existing !== null) return existing;
  const wrapper = document.createElement('div');
  wrapper.className = 'speedwatcher-pill-host';
  wrapper.style.cssText = 'position:absolute;top:0;right:0;width:0;height:0;pointer-events:none;';
  anchor.appendChild(wrapper);
  return wrapper;
}

function ensurePill(): PillApi {
  const host = pillHost();
  if (pill !== null && pill.host === host && host.isConnected) return pill.api;
  // The player was replaced (SPA navigation): rebuild on the fresh host.
  pill?.api.destroy();
    const api = createPill(host, {
    onApply: (multiplier) => {
      autoState = 'stopped';
      appliedSource = 'user';
      preAutoRate = null;
      applyMultiplier(multiplier);
    },
    onDismiss: () => dismissCurrent(),
    onStopAuto: () => stopAutoForVideo(),
    onAutoAdjust: (enabled: boolean) => {
      chapterConsent = enabled;
      if (enabled) {
        startChapterScheduler();
      } else {
        chapterScheduler.stop();
      }
      // Re-render so the toggle's aria-pressed and the status line flip.
      if (pillState !== null) {
        showPill({
          ...pillState,
          autoAdjust: enabled,
          chapterStatus: enabled ? chapterStatusNow() : undefined,
        });
      }
    },
  });
  api.mount();
  pill = { api, host };
  return pill.api;
}

function showPill(state: PillState): void {
  pillState = state;
  ensurePill().update(state);
  if (__E2E__ && window.__speedwatcherPill !== undefined) window.__speedwatcherPill.state = state;
}

// ── Live effective rate (secondary pill line) ─────────────────────────────

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

/** The saved time on the current video: the session's accumulated flushes,
 * null before apply, while paused, or while the rate diverged from the
 * applied multiplier (the tracker's accrual gates, mirrored for display). */
function computeSavedSec(): number | null {
  if (current === null || savedSec === null || savedMultiplier === null) return null;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null || video.paused) return null;
  if (Math.abs(video.playbackRate - savedMultiplier) > RATE_EPSILON) return null;
  return savedSec;
}

function refreshSavedSec(): void {
  // Never create the pill from a tick — that would mount an empty one pre-measure.
  if (pill === null) return;
  pill.api.updateSavedSec(computeSavedSec());
}

/** Disengages auto-apply for this video: the auto-applied rate is undone
 * back to the pre-auto rate (P1a — the in-pill escape hatch; a manual
 * override already means the user took over) and the pill drops its
 * stop-auto state. Not logged — auto's own log entries already exist. */
function stopAutoForVideo(): void {
  if (current === null) return;
  const wasAuto = appliedSource === 'auto';
  autoState = 'stopped';
  appliedSource = 'none';
  if (wasAuto && preAutoRate !== null) restorePreAutoRate();
  preAutoRate = null;
  if (pillState !== null) showPill({ ...pillState, applied: 'none', undoRate: undefined });
}

/** Restores the pre-auto playback rate on the current video. */
function restorePreAutoRate(): void {
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  video.playbackRate = preAutoRate ?? 1;
}

/** Manual-override detection on ratechange: while auto applied a rate, any
 * divergence from the clamped applied value (except a reset to exactly 1.0)
 * is the user taking over — auto stops for this video and the pill re-labels
 * the source as user. */
function markUserOverride(): void {
  if (autoState !== 'auto') return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null || video.paused) return;
  if (video.playbackRate === 1) return; // reset, not an override
  if (savedMultiplier === null) return;
  if (Math.abs(video.playbackRate - savedMultiplier) <= RATE_EPSILON) return; // our own apply
  autoState = 'stopped';
  appliedSource = 'user';
  preAutoRate = null; // the user took over — no undo anchor left
  if (pillState !== null) showPill({ ...pillState, applied: 'user', undoRate: undefined });
}

function applyMultiplier(multiplier: number): void {
  applyAndTrack(multiplier, 'apply');
}

/** Shared apply choke point: the platformMax clamp, the time-saved session
 * and its tracker attach, the live-rate and saved-time refresh, the nudge
 * report, and the override log. `action` distinguishes user/auto applies
 * ('apply') from scheduler boundary steps ('adjust') in the log. Returns
 * the clamped rate actually applied (the scheduler's read-back contract). */
function applyAndTrack(multiplier: number, action: 'apply' | 'adjust'): number {
  if (current === null) return multiplier;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return multiplier;
  // recommend() already clamps to platformMax; min() re-states the invariant.
  const applied = Math.min(multiplier, current.platformMax);
  video.playbackRate = applied;
  // Time-saved session: count wall time at the applied rate from now on.
  savedSec = 0;
  savedMultiplier = applied;
  savedTracker.attach(video, applied, flushSavedTick);
  // Show the live line immediately; steady-state ticks are throttled in the pill.
  refreshLiveRate();
  refreshSavedSec();
  void logAction(action, multiplier);
  nudgeSurface.reportApply(multiplier, current.range);
  return applied;
}

/** Arms the per-chapter scheduler on the current video's plan; a no-op
 * without a plan or a video element. The callback routes every boundary
 * step through the shared apply choke point as an 'adjust'. */
function startChapterScheduler(): void {
  if (chapterRates === null) return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  chapterScheduler.start(video, chapterRates, (multiplier) => applyAndTrack(multiplier, 'adjust'));
}

/** The scheduler's status for the pill line: paused after a manual rate,
 * 1× in a music segment, plain running otherwise. Undefined while the
 * scheduler is not armed (or the plan is missing). */
function chapterStatusNow(): 'active' | 'yielded' | 'music' | undefined {
  if (chapterRates === null || !chapterScheduler.active) return undefined;
  if (chapterScheduler.hasYielded) return 'yielded';
  const segment = chapterRates[chapterScheduler.activeIndex];
  if (segment !== undefined && segment.mode === 'music') return 'music';
  return 'active';
}

/** Pushes a pill re-render only when the scheduler status changed (the
 * boundary steps and rate changes flow through onMediaEvent). */
function refreshChapterStatus(): void {
  if (!chapterConsent || pillState === null) return;
  const status = chapterStatusNow();
  if (pillState.chapterStatus !== status) showPill({ ...pillState, chapterStatus: status });
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
  if (wasAuto && preAutoRate !== null) restorePreAutoRate();
  preAutoRate = null;
  showPill(NONE_STATE);
  void logAction('dismiss', current.recommendation.multiplier);
}

/** Best-effort: a dead bridge must not undo the playback change. */
function logAction(userAction: 'apply' | 'dismiss' | 'adjust', multiplier: number): void {
  if (current === null) return;
  void bridge
    .request({
      type: 'log:append',
      entry: {
        videoId: current.videoId,
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

/** Tracker flush → the background store (fire-and-forget like logAction);
 * the same delta also advances the pill's per-video accumulator. */
function flushSavedTick(tick: SavedTick): void {
  if (savedSec !== null) savedSec += savedSeconds(tick.deltaSec, tick.multiplier);
  void bridge
    .request({ type: 'timeSaved:accrue', deltaSec: tick.deltaSec, multiplier: tick.multiplier })
    .catch(() => undefined);
}

// ── Channel rate memory (YouTube) ─────────────────────────────────────────

/** Best-effort: remember the measured rate for the channel, seeding the
 * estimated tier of its captionless videos; a dead bridge must not block
 * the pill. Measured tiers only — call sites gate on naturalRate. */
function rememberChannelRate(
  videoDetails: PlayerResponse['videoDetails'],
  naturalRate: number,
  language: LanguageModel | undefined,
): void {
  const channelKey = channelKeyOf(videoDetails);
  if (channelKey === undefined) return;
  void bridge
    .request({
      type: 'channel:put',
      channelKey,
      record: {
        rate: naturalRate,
        unit: UNIT_LABELS[language?.unit ?? 'wpm'],
        language: language?.code ?? '?',
        ts: Date.now(),
      },
    })
    .catch(() => undefined);
}

/** The channel's last measured rate, when it was measured in this video's
 * language — the estimated prior gets smarter, the tier stays 'estimated'
 * (the rate is a prior, not this video's measurement). */
async function channelSeededRate(
  videoDetails: PlayerResponse['videoDetails'],
  language: LanguageModel | undefined,
): Promise<number | null> {
  const channelKey = channelKeyOf(videoDetails);
  if (channelKey === undefined || language === undefined) return null;
  try {
    const record = await bridge.request({ type: 'channel:get', channelKey });
    if (record === null || record.language !== language.code) return null;
    return record.rate;
  } catch {
    return null;
  }
}

