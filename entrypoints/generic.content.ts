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
// only — SEC-2, same gate as content.ts). The per-video rate controller
// lives in lib/rate-controller.ts; this file keeps the measurement
// pipeline, the skip-silence actuator wiring, and the video-observer wiring.

import { defineContentScript } from 'wxt/utils/define-content-script';
import { harvestCaptions, type VttHost } from '@/lib/captions-harvest';
import { priorMidpoint } from '@/lib/heuristics';
import { resolveLanguage } from '@/lib/languages';
import { RateReapplier, selectVideo } from '@/lib/matcher';
import { createBridgeClient } from '@/lib/messaging';
import { detectMusic } from '@/lib/music';
import type { RateTier } from '@/lib/recommend';
import {
  pauseRateFor,
  planSkipSilence,
  SkipSilenceActuator,
  type GapSpan,
  type SkipSilencePrefs,
} from '@/lib/skip-silence';
import { resolveContentType } from '@/lib/settings';
import { RATE_EPSILON } from '@/lib/time-saved';
import { asrTierInputs, filteredTokensOverTrimmedSpan, manualCueRate } from '@/lib/wpm';
import { createNudgeHost } from '@/ui/nudge-host';
import { createRateController } from '@/lib/rate-controller';
import type { PillTestHook, RateCurrent } from '@/lib/rate-controller-types';

const RESOURCE_WAIT_MS = 2000;
const RESOURCE_POLL_MS = 250;
/** DOM-churn throttle for the video observer (see main()). */
const OBSERVER_DEBOUNCE_MS = 300;

const bridge = createBridgeClient(window);
const reapplier = new RateReapplier();

// Skip-silence session (lib/skip-silence.ts): mirror of content.ts — the
// actuator dips the rate inside caption gaps; the reapplier holds the
// base-vs-pause pair so its loop re-asserts the OUT-OF-GAP rate on resets.
const skipActuator = new SkipSilenceActuator();
/** The current video's gap plan; null when the toggle is off or the
 * timeline has no gap >= minGapSec. */
let skipPlan: { index: GapSpan[]; prefs: SkipSilencePrefs } | null = null;

const controller = createRateController<RateCurrent>({
  bridge,
  nudgeSurface: createNudgeHost(bridge),
  hostAnchor: () => document.body,
  // The re-assert loop: Vimeo resets playbackRate on pause/play and re-init.
  applyRate: (video, rate, platformMax) => {
    reapplier.start(video, rate, platformMax);
  },
  stopRateApplies: () => reapplier.stop(),
  makeCurrent: (parts) => ({
    site: parts.site,
    contentType: parts.contentType,
    naturalRate: parts.naturalRate,
    platformMax: parts.platformMax,
    tier: parts.tier,
    unit: parts.unit,
    recommendation: parts.recommendation,
    range: parts.range,
  }),
  videoIdOf: () => location.href,
  // Skip-silence wiring: the actuator's dip is written through the
  // reapplier's pair, so the re-assert loop restores the out-of-gap rate.
  skip: {
    attach: (video, applied) => attachSkip(video, applied),
    detach: () => skipActuator.detach(),
    isOwnDip: (rate) =>
      skipActuator.active && Math.abs(rate - reapplier.currentRateFor(skipActuator.inGapNow)) <= RATE_EPSILON,
  },
  // A new element means the user switched videos: end the old session and
  // re-measure (the observer's handleVideoMutations does the same).
  onVideoSwap: (endSession) => {
    endSession();
    void measure();
  },
});

declare global {
  interface Window {
    __speedwatcherPill?: PillTestHook;
    __speedwatcherCaptionTier?: RateTier;
    /** E2E hook (SEC-2): the reapplier's read-only witness — active plus
     * when it last ran — so the specs can assert loop absence via state
     * and tick presence via the timestamp delta instead of sleeping. */
    __speedwatcherReapplier?: { active: boolean; lastAssertAt: number | null; intervalMs: number };
    __vimeo_player_config__?: { player?: { config_url?: string } };
  }
}

let observerTimer: ReturnType<typeof setTimeout> | null = null;
let hasSeenVideo = false;

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
    document.addEventListener('play', controller.onMediaEvent, true);
    document.addEventListener('playing', controller.onMediaEvent, true);
    document.addEventListener('timeupdate', controller.onMediaEvent, true);
    // Live-rate line: ratechange and pause also drive the throttled refresh
    // (mirror of entrypoints/content.ts).
    document.addEventListener('ratechange', controller.onMediaEvent, true);
    document.addEventListener('pause', controller.onMediaEvent, true);
    // E2E-only hook (SEC-2): the store bundle must not expose page-callable
    // playback controls — see entrypoints/content.ts for the gate.
    if (__E2E__) {
      window.__speedwatcherPill = controller.pillHook;
      window.__speedwatcherReapplier = {
        get active() {
          return reapplier.active;
        },
        get lastAssertAt() {
          return reapplier.lastAssertAt;
        },
        get intervalMs() {
          return reapplier.intervalMs;
        },
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
  const active = selectVideo([...document.querySelectorAll('video')], controller.activeVideo);
  if (active === null) {
    controller.onVideoRemoved();
    return;
  }
  if (active !== controller.activeVideo) {
    controller.adoptVideo(active);
    void measure();
  }
}

function measure(): void {
  controller.runMeasure((startedAt) => measureOnce(startedAt));
}

async function measureOnce(startedAt: number): Promise<void> {
  skipPlan = null;
  const video = controller.activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  // Live streams have no finite rate target; suppress the pill like the
  // youtube path does.
  if (video.duration === Infinity) {
    controller.showNone();
    return;
  }
  const settings = await controller.loadSettings();
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
      const detected = detectMusic(harvest.cues, naturalRate, language?.unit ?? 'wpm') ? 'music' : 'generic';
      // The user/site content-type preference outranks the detected default
      // (mirror of content.ts): auto-apply gates on this resolved type.
      const contentType = resolveContentType(settings, site, detected);
      const { tier, wordInputs } = asrTierInputs(asr ? 'asr' : 'manual', harvest.words, harvest.cues);
      if (__E2E__) window.__speedwatcherCaptionTier = tier;
      // Skip-silence plan: the toggle and this video's gap index (see
      // planSkipSilence); null when the toggle is off or no gap clears minGapSec.
      skipPlan = await planSkipSilence(harvest.words, harvest.cues, settings, site, bridge);
      controller.renderRecommendation(location.href, naturalRate, tier, contentType, settings, site, wordInputs, language, startedAt);
      return;
    }
  }
  if (__E2E__) window.__speedwatcherCaptionTier = 'estimated';
  const contentType = resolveContentType(settings, site, 'generic');
  controller.renderRecommendation(location.href, priorMidpoint(contentType), 'estimated', contentType, settings, site, undefined, undefined, startedAt);
}

/** Arms skip-silence on an apply: the reapplier's pair (base = the applied
 * rate, pause = the dip target) and the actuator's timeupdate listener.
 * DRM content (mediaKeys) and dip targets that equal the applied rate
 * never attach. */
function attachSkip(video: HTMLVideoElement, applied: number): void {
  if (skipPlan === null) return;
  // Chrome reports mediaKeys as undefined until EME is used, so the DRM
  // gate is a truthy check, not a null check.
  if (video.mediaKeys) return;
  const pause = pauseRateFor(applied, skipPlan.prefs);
  if (pause >= applied) return;
  reapplier.setRates(applied, pause);
  skipActuator.attach(video, skipPlan.index, skipPlan.prefs, applied, (inGap) => {
    // Re-render the slowed-silence indicator only on gap transitions.
    const state = controller.pillState;
    if (state !== null) controller.showPill({ ...state, skipSlowed: inGap });
  });
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
