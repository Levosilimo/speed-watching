// Generic player matcher (Phase 3): rate control for every non-YouTube
// <video> — native elements, Vimeo, Twitch, MOOC players, embeds. Runs in
// all frames because every embedded player measured in the Phase-0 probe
// lives in a cross-origin iframe, and bails on YouTube watch pages, which
// entrypoints/content.ts owns. YouTube embeds (youtube.com/embed,
// youtube-nocookie.com) expose no ytInitialPlayerResponse, so the generic
// path serves them too.
//
// Measurement is tier 2/3: captions come from the page's network layer
// (lib/captions-harvest.ts) when the player exposes them, otherwise the
// estimated heuristic tier. Apply rides lib/matcher.ts's re-apply loop
// because Vimeo resets playbackRate on pause/play and on re-init — a
// one-shot assignment does not stick.
//
// Same world/wiring pattern as content.ts: MAIN world, chrome-backed
// settings via the window-event bridge (lib/messaging.ts), and the
// __speedwatcherPill test hook the shared e2e specs assert on (E2E builds
// only — SEC-2, same gate as content.ts).
// The file carries the auto-apply lifecycle and the saved-time accrual
// plumbing on top of the measurement pipeline, which keeps it past the
// 440-line reviewability budget; the suppression mirrors content.ts's — a
// reviewed exception, not license to grow further.
// aislop-ignore-file file-too-large

import { defineContentScript } from 'wxt/utils/define-content-script';
import { harvestCaptions, type VttHost } from '@/lib/captions-harvest';
import { priorMidpoint } from '@/lib/heuristics';
import { resolveLanguage, type LanguageModel } from '@/lib/languages';
import { SerializedRunner } from '@/lib/measure-guard';
import { RateReapplier, selectVideo } from '@/lib/matcher';
import { createBridgeClient } from '@/lib/messaging';
import type { ContentType } from '@/lib/music';
import { detectMusic } from '@/lib/music';
import { recommend, type RateTier, type Recommendation } from '@/lib/recommend';
import { shouldAutoApply } from '@/lib/auto-apply';
import {
  defaultSettings,
  resolveContentType,
  resolvePlatformMax,
  resolveUserTarget,
  type Settings,
} from '@/lib/settings';
import { asrTierInputs, filteredTokensOverTrimmedSpan, manualCueRate } from '@/lib/wpm';
import { createPill, type AppliedSource, type LiveRate, type PillApi, type PillState } from '@/ui/pill';
import {
  RATE_EPSILON,
  savedSeconds,
  TimeSavedTracker,
  type SavedTick,
} from '@/lib/time-saved';

const RESOURCE_WAIT_MS = 2000;
const RESOURCE_POLL_MS = 250;
/** DOM-churn throttle for the video observer (see main()). */
const OBSERVER_DEBOUNCE_MS = 300;

const bridge = createBridgeClient(window);

/** Current video's recommendation context; null until the first measure. */
let current: {
  site: string;
  contentType: ContentType;
  naturalRate: number;
  platformMax: number;
  tier: RateTier;
  /** Rate-unit display label; the track language resolves it when the
   * track declares one (Dzen's ru → wpm), else the wpm default. */
  unit: string;
  recommendation: Recommendation;
} | null = null;

let pill: { api: PillApi; host: HTMLElement } | null = null;
let activeVideo: HTMLVideoElement | null = null;
/** Last rendered pill state — stop-auto and override detection re-render it. */
let pillState: PillState | null = null;

// Auto-apply lifecycle (per video): mirror of entrypoints/content.ts —
// 'pending' until the first measure, 'auto' after a self-apply, 'stopped'
// after manual override, dismiss, or Stop-auto.
let autoState: 'pending' | 'auto' | 'stopped' = 'pending';
/** How the current rate got applied — rides into the pill as applied. */
let appliedSource: AppliedSource = 'none';
let observerTimer: ReturnType<typeof setTimeout> | null = null;
let hasSeenVideo = false;
const reapplier = new RateReapplier();
const measureRunner = new SerializedRunner();

// Time-saved session (lib/time-saved.ts): mirror of entrypoints/content.ts —
// the tracker counts wall time at the applied rate, the pill shows the
// current video's accumulated saved seconds, and the flushes ride the
// bridge to the background store.
const savedTracker = new TimeSavedTracker();
/** Saved seconds accumulated for the current video; null before apply. */
let savedSec: number | null = null;
/** The multiplier the session is gated on; null while no session runs. */
let savedMultiplier: number | null = null;

const NONE_STATE: PillState = {
  mode: 'none',
  rateWpm: 0,
  multiplier: 1,
  effectiveWpm: 0,
  label: '',
};

interface PillTestHook {
  state: PillState | null;
  apply(): void;
  dismiss(): void;
  stopAuto?(): void;
}

declare global {
  interface Window {
    __speedwatcherPill?: PillTestHook;
    __speedwatcherCaptionTier?: RateTier;
    __vimeo_player_config__?: { player?: { config_url?: string } };
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  world: 'MAIN',
  main() {
    // Watch pages are the youtube pipeline's; everything else — including
    // youtube.com/embed frames — is generic territory.
    if (location.hostname.endsWith('youtube.com') && location.pathname.startsWith('/watch')) {
      return;
    }
    document.addEventListener('play', onMediaEvent, true);
    document.addEventListener('playing', onMediaEvent, true);
    document.addEventListener('timeupdate', onMediaEvent, true);
    // Live-rate line: ratechange and pause also drive the throttled refresh
    // (mirror of entrypoints/content.ts).
    document.addEventListener('ratechange', onMediaEvent, true);
    document.addEventListener('pause', onMediaEvent, true);
    // E2E-only hook (SEC-2): the store bundle must not expose page-callable
    // playback controls — see entrypoints/content.ts for the gate.
    if (__E2E__) {
      window.__speedwatcherPill = {
        state: null,
        apply: () => {
          if (current === null) return;
          if (current.recommendation.mode === 'music' || current.recommendation.mode === 'unreachable') {
            return;
          }
          applyMultiplier(current.recommendation.multiplier);
        },
        dismiss: () => dismissCurrent(),
        stopAuto: () => stopAutoForVideo(),
      };
    }
    // Player elements appear and disappear dynamically (embeds mount late,
    // SPA navigation swaps them): re-measure when the active element changes.
    // The callback runs on every DOM mutation on every page, so it skips the
    // full scan until a video has ever appeared and throttles it afterwards.
    const observer = new MutationObserver(() => {
      if (!hasSeenVideo && document.querySelector('video') === null) return;
      if (observerTimer !== null) clearTimeout(observerTimer);
      observerTimer = setTimeout(handleVideoMutations, OBSERVER_DEBOUNCE_MS);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void measure();
  },
});

function handleVideoMutations(): void {
  hasSeenVideo = true;
  const active = selectVideo([...document.querySelectorAll('video')], activeVideo);
  if (active === null) {
    if (pill !== null) {
      pill.api.update(NONE_STATE);
      pill.api.destroy();
      pill = null;
    }
    reapplier.stop();
    savedTracker.detach();
    savedSec = null;
    savedMultiplier = null;
    current = null;
    autoState = 'pending';
    appliedSource = 'none';
    return;
  }
  if (active !== activeVideo) {
    activeVideo = active;
    savedTracker.detach();
    savedSec = null;
    savedMultiplier = null;
    autoState = 'pending';
    appliedSource = 'none';
    void measure();
  }
}

function onMediaEvent(event: Event): void {
  // Multi-video pages: the last element to fire a media event is the one
  // the user is watching; a swap re-measures and ends the old session.
  if (event.target instanceof HTMLVideoElement && event.target !== activeVideo) {
    activeVideo = event.target;
    savedTracker.detach();
    savedSec = null;
    savedMultiplier = null;
    autoState = 'pending';
    appliedSource = 'none';
    void measure();
  }
  markUserOverride();
  refreshLiveRate();
  refreshSavedSec();
}

function measure(): void {
  measureRunner.run(measureOnce);
}

async function measureOnce(): Promise<void> {
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  // Live streams have no finite rate target; suppress the pill like the
  // youtube path does.
  if (video.duration === Infinity) {
    showPill(NONE_STATE);
    return;
  }
  const settings = await loadSettings();
  const site = location.hostname.replace(/^www\./, '');
  const vimeo = window.__vimeo_player_config__;
  // Track-src probe inputs: the src attributes of every video > track[src]
  // on the page (Dzen's signed OK.ru VTT, Rutube's pic.rtbcdn.ru SRT). The
  // first track also names the caption language for rate/unit resolution.
  const trackSrcs = [...document.querySelectorAll('video')]
    .flatMap((el) => [...el.querySelectorAll<HTMLTrackElement>(':scope > track[src]')])
    .map((track) => track.getAttribute('src'))
    .filter((src): src is string => src !== null && src !== '');
  const track = video.querySelector<HTMLTrackElement>(':scope > track[src]');
  const language =
    resolveLanguage(track?.srclang || track?.getAttribute('lang') || undefined) ?? undefined;
  const harvest = await harvestCaptions({
    videoSrc: video.getAttribute('src'),
    resourceUrls: await captionResourceUrls(),
    hostname: location.hostname,
    pageOrigin: location.origin,
    vimeoConfig: vimeo === undefined ? null : { __vimeo_player_config__: vimeo },
    vttHost: vttHost(),
    fetchImpl: (url) => fetch(url),
    trackSrcs,
  });
  if (harvest !== null) {
    // Word-timed tracks (Dzen's `<TS><c>word</c>` VTT) take the asr branch:
    // presentation rate over the cue span, asr-word when ≥2 words timed
    // (mirror of content.ts). Cue-only payloads (Rutube SRT) keep the
    // manual-cue path.
    const asr = harvest.words.length > 0;
    const naturalRate = asr
      ? filteredTokensOverTrimmedSpan(harvest.cues, language)
      : manualCueRate(harvest.cues, language);
    if (naturalRate !== null) {
      const detected = detectMusic(harvest.cues, naturalRate) ? 'music' : 'generic';
      // The user/site content-type preference outranks the detected default
      // (mirror of content.ts): auto-apply gates on this resolved type.
      const contentType = resolveContentType(settings, site, detected);
      const { tier, wordInputs } = asrTierInputs(asr ? 'asr' : 'manual', harvest.words, harvest.cues);
      if (__E2E__) window.__speedwatcherCaptionTier = tier;
      renderRecommendation(naturalRate, tier, contentType, settings, site, wordInputs, language);
      return;
    }
  }
  if (__E2E__) window.__speedwatcherCaptionTier = 'estimated';
  const contentType = resolveContentType(settings, site, 'generic');
  renderRecommendation(priorMidpoint(contentType), 'estimated', contentType, settings, site);
}

/** Resource-timeline URLs naming caption sources, waiting briefly for the
 * player's late manifest fetches (the page loads before the player does). */
async function captionResourceUrls(): Promise<string[]> {
  const deadline = Date.now() + RESOURCE_WAIT_MS;
  const hasCaptionResource = (urls: string[]): boolean =>
    urls.some((url) => /\.m3u8(\?|$)|\.vtt(\?|$)|\/api\/transcripts\//.test(url));
  while (Date.now() < deadline) {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    if (hasCaptionResource(urls)) return urls;
    await new Promise((resolve) => setTimeout(resolve, RESOURCE_POLL_MS));
  }
  return performance.getEntriesByType('resource').map((entry) => entry.name);
}

function vttHost(): VttHost {
  return { VTTCue: globalThis.VTTCue, document: window.document };
}

function renderRecommendation(
  naturalRate: number,
  tier: RateTier,
  contentType: ContentType,
  settings: Settings,
  site: string,
  wordInputs?: { articulatoryWpm: number; timingCoverageOk: boolean } | null,
  language?: LanguageModel,
): void {
  const platformMax = resolvePlatformMax(settings, site);
  const recommendation = recommend({
    naturalRate,
    tier,
    contentType,
    platformMax,
    userTarget: resolveUserTarget(settings, site, contentType),
    language,
    ...wordInputs,
  });
  current = { site, contentType, naturalRate, platformMax, tier, unit: language?.unit ?? 'wpm', recommendation };
  if (autoState === 'pending' && shouldAutoApply(settings, recommendation, tier, contentType)) {
    applyMultiplier(recommendation.multiplier);
    autoState = 'auto';
    appliedSource = 'auto';
  }
  showPill({
    mode: recommendation.mode,
    rateWpm: naturalRate,
    multiplier: recommendation.multiplier,
    effectiveWpm: recommendation.effectiveWpm,
    tierLabel: recommendation.tierLabel,
    label: recommendation.label,
    reason: recommendation.reason ?? undefined,
    applied: appliedSource,
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

// ── Pill ──────────────────────────────────────────────────────────────────

/** Mount point for the pill; the pill positions itself (fixed, bottom-right). */
function pillHost(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
  if (existing !== null) return existing;
  const wrapper = document.createElement('div');
  wrapper.className = 'speedwatcher-pill-host';
  document.body.appendChild(wrapper);
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
      applyMultiplier(multiplier);
    },
    onDismiss: () => dismissCurrent(),
    onStopAuto: () => stopAutoForVideo(),
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

/** Same rule as content.ts: recommend/warning modes on a measured tier
 * while playing at a non-1 rate; the estimated tier's prior is never shown. */
function computeLiveRate(): LiveRate | null {
  if (current === null) return null;
  const mode = current.recommendation.mode;
  if (mode !== 'recommend' && mode !== 'warning') return null;
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

/** Disengages auto-apply for this video: rate untouched, re-assert loop
 * detached (a later reset to 1.0 sticks), pill drops its stop-auto state.
 * Not logged. */
function stopAutoForVideo(): void {
  if (current === null) return;
  autoState = 'stopped';
  appliedSource = 'none';
  reapplier.stop();
  if (pillState !== null) showPill({ ...pillState, applied: 'none' });
}

/** Manual-override detection on ratechange: mirror of entrypoints/content.ts
 * — divergence from the applied value (except a reset to exactly 1.0, which
 * the reapplier treats as its re-assert trigger) is the user taking over. */
function markUserOverride(): void {
  if (autoState !== 'auto') return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null || video.paused) return;
  if (video.playbackRate === 1) return; // reset, not an override
  if (savedMultiplier === null) return;
  if (Math.abs(video.playbackRate - savedMultiplier) <= RATE_EPSILON) return; // our own apply
  autoState = 'stopped';
  appliedSource = 'user';
  if (pillState !== null) showPill({ ...pillState, applied: 'user' });
}

function applyMultiplier(multiplier: number): void {
  if (current === null) return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  // start() applies the multiplier and re-asserts it (ratechange/play/pause
  // listeners + the re-check interval) until dismiss; the clamped value is
  // the tracker's accrual gate.
  const applied = Math.min(multiplier, current.platformMax);
  reapplier.start(video, applied, current.platformMax);
  savedSec = 0;
  savedMultiplier = applied;
  savedTracker.attach(video, applied, flushSavedTick);
  // Show the live line immediately; steady-state ticks are throttled in the pill.
  refreshLiveRate();
  refreshSavedSec();
  void logAction('apply', multiplier);
}

function dismissCurrent(): void {
  if (current === null) return;
  autoState = 'stopped';
  appliedSource = 'none';
  // Detach first: the unflushed tail is credited to the store before the
  // pill hides.
  savedTracker.detach();
  savedSec = null;
  savedMultiplier = null;
  reapplier.stop();
  showPill(NONE_STATE);
  void logAction('dismiss', current.recommendation.multiplier);
}

/** Best-effort: a dead bridge must not undo the playback change. */
function logAction(userAction: 'apply' | 'dismiss', multiplier: number): void {
  if (current === null) return;
  void bridge
    .request({
      type: 'log:append',
      entry: {
        videoId: location.href,
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
