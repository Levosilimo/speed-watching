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

import { defineContentScript } from 'wxt/utils/define-content-script';
import { harvestCaptions, type VttHost } from '@/lib/captions-harvest';
import { priorMidpoint } from '@/lib/heuristics';
import { RateReapplier, selectVideo } from '@/lib/matcher';
import { createBridgeClient } from '@/lib/messaging';
import type { ContentType } from '@/lib/music';
import { detectMusic } from '@/lib/music';
import { recommend, type RateTier, type Recommendation } from '@/lib/recommend';
import {
  defaultSettings,
  resolveContentType,
  resolvePlatformMax,
  resolveTarget,
  type Settings,
} from '@/lib/settings';
import { manualCueRate } from '@/lib/wpm';
import { createPill, type PillApi, type PillState } from '@/ui/pill';

const RESOURCE_WAIT_MS = 2000;
const RESOURCE_POLL_MS = 250;

const bridge = createBridgeClient(window);

/** Current video's recommendation context; null until the first measure. */
let current: {
  site: string;
  contentType: ContentType;
  naturalRate: number;
  platformMax: number;
  recommendation: Recommendation;
} | null = null;

let pill: { api: PillApi; host: HTMLElement } | null = null;
let activeVideo: HTMLVideoElement | null = null;
let measuring = false;
let remeasureQueued = false;
const reapplier = new RateReapplier();

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
}

declare global {
  interface Window {
    __speedwatcherPill?: PillTestHook;
    __speedwatcherCaptionTier?: 'captions' | 'estimated';
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
      };
    }
    // Player elements appear and disappear dynamically (embeds mount late,
    // SPA navigation swaps them): re-measure when the active element changes.
    const observer = new MutationObserver(() => {
      const active = selectVideo([...document.querySelectorAll('video')], activeVideo);
      if (active === null) {
        if (pill !== null) {
          pill.api.update(NONE_STATE);
          pill.api.destroy();
          pill = null;
        }
        reapplier.stop();
        current = null;
        return;
      }
      if (active !== activeVideo) {
        activeVideo = active;
        void measure();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void measure();
  },
});

function onMediaEvent(event: Event): void {
  // Multi-video pages: the last element to fire a media event is the one
  // the user is watching; a swap re-measures.
  if (event.target instanceof HTMLVideoElement && event.target !== activeVideo) {
    activeVideo = event.target;
    void measure();
  }
}

async function measure(): Promise<void> {
  if (measuring) {
    remeasureQueued = true;
    return;
  }
  measuring = true;
  try {
    await measureOnce();
  } finally {
    measuring = false;
    if (remeasureQueued) {
      remeasureQueued = false;
      void measure();
    }
  }
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
  const segments = await harvestCaptions({
    videoSrc: video.getAttribute('src'),
    resourceUrls: await captionResourceUrls(),
    hostname: location.hostname,
    pageOrigin: location.origin,
    vimeoConfig: vimeo === undefined ? null : { __vimeo_player_config__: vimeo },
    vttHost: vttHost(),
    fetchImpl: (url) => fetch(url),
  });
  if (segments !== null) {
    if (__E2E__) window.__speedwatcherCaptionTier = 'captions';
    const naturalRate = manualCueRate(segments);
    if (naturalRate !== null) {
      const detected = detectMusic(segments, naturalRate) ? 'music' : 'generic';
      renderRecommendation(naturalRate, 'manual-cue', detected, settings, site);
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
): void {
  const platformMax = resolvePlatformMax(settings, site);
  const recommendation = recommend({
    naturalRate,
    tier,
    contentType,
    platformMax,
    userTarget: resolveTarget(settings, site, contentType),
  });
  current = { site, contentType, naturalRate, platformMax, recommendation };
  showPill({
    mode: recommendation.mode,
    rateWpm: naturalRate,
    multiplier: recommendation.multiplier,
    effectiveWpm: recommendation.effectiveWpm,
    tierLabel: recommendation.tierLabel,
    label: recommendation.label,
    reason: recommendation.reason ?? undefined,
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
    onApply: (multiplier) => applyMultiplier(multiplier),
    onDismiss: () => dismissCurrent(),
  });
  api.mount();
  pill = { api, host };
  return pill.api;
}

function showPill(state: PillState): void {
  ensurePill().update(state);
  if (__E2E__ && window.__speedwatcherPill !== undefined) window.__speedwatcherPill.state = state;
}

function applyMultiplier(multiplier: number): void {
  if (current === null) return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  // start() applies the multiplier and re-asserts it (ratechange/play/pause
  // listeners + the re-check interval) until dismiss.
  reapplier.start(video, multiplier, current.platformMax);
  void logAction('apply', multiplier);
}

function dismissCurrent(): void {
  if (current === null) return;
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
