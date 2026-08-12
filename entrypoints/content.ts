// The console.info lines in this file are the Phase-0 measurement hook
// (one-line wpm summary per video, per spike-lane spec) — not leftovers.
// aislop-ignore-file console-leftover
//
// World choice: the WEB caption fetch (signed timedtext baseUrl with pot)
// only succeeds from the page context, so the measurement pipeline runs in
// the MAIN world — where chrome.* is unavailable. A single ISOLATED-world
// sibling (entrypoints/bridge.ts) hosts a chrome-backed SettingsStore +
// OverrideLog and answers the window CustomEvents defined in lib/messaging.ts.
// Routing through the background was rejected because chrome.storage.local
// already satisfies lib's StorageLike: the bridge needs no SW round trip and
// the background stays the audio-probe orchestrator.
import { defineContentScript } from 'wxt/utils/define-content-script';
import { parseYouTubeJson3 } from '@/lib/captions';
import { priorMidpoint } from '@/lib/heuristics';
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
import {
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  totalWords,
  wordLevelWpm,
} from '@/lib/wpm';
import type { CaptionTrack, PlayerResponse } from '@/lib/youtube';
import { createPill, type PillApi, type PillState } from '@/ui/pill';

const PLAYER_RESPONSE_TIMEOUT_MS = 10_000;

// ANDROID innertube fallback (plan-v3): the WEB timedtext endpoint returns
// 200-with-empty-body / 400/403 from some IPs, while the ANDROID
// youtubei/v1/player POST returns real caption tracks (proven from hostile
// IPs in Phase 0). ToS gray area: the ANDROID client designation is not a
// public API. The fallback only reads captions — the same data the WEB path
// would serve — and never touches playback or DRM surfaces.
const ANDROID_CLIENT_NAME = 'ANDROID';
const ANDROID_CLIENT_VERSION = '20.10.31';

const bridge = createBridgeClient(window);

/** Current video's recommendation context; null until the first measure. */
let current: {
  videoId: string;
  site: string;
  contentType: ContentType;
  naturalRate: number;
  platformMax: number;
  recommendation: Recommendation;
} | null = null;

let pill: { api: PillApi; host: HTMLElement } | null = null;

/** The element that last fired a media event — the apply target on pages
 * with more than one video. */
let activeVideo: HTMLVideoElement | null = null;

const NONE_STATE: PillState = {
  mode: 'none',
  rateWpm: 0,
  multiplier: 1,
  effectiveWpm: 0,
  label: '',
};

// E2E hooks (same pattern as the speedwatcher:measure event): the pill's
// shadow root is closed, so specs read state and trigger apply/dismiss here.
interface PillTestHook {
  state: PillState | null;
  apply(): void;
  dismiss(): void;
}

declare global {
  interface Window {
    __speedwatcherPill?: PillTestHook;
    __speedwatcherCaptionSource?: 'web' | 'android' | 'none';
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
    window.__speedwatcherPill = {
      state: null,
      // Mirrors the pill's own Apply gate (ui/pill.ts wireEvents): music and
      // unreachable states must not touch playbackRate.
      apply: () => {
        if (current === null) return;
        if (current.recommendation.mode === 'music' || current.recommendation.mode === 'unreachable') {
          return;
        }
        applyMultiplier(current.recommendation.multiplier);
      },
      dismiss: () => dismissCurrent(),
    };
    void measure();
    document.addEventListener('yt-navigate-finish', () => void measure());
  },
});

function onMediaEvent(event: Event): void {
  if (event.target instanceof HTMLVideoElement) activeVideo = event.target;
}

function isLive(): boolean {
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video?.duration === Infinity) return true;
  return document.querySelector('.ytp-live-badge') !== null;
}

async function measure(): Promise<void> {
  const response = await waitForPlayerResponse();
  if (!response) {
    console.info('[speed-watcher] wpm: player response never appeared');
    return;
  }
  if (isLive()) {
    console.info('[speed-watcher] wpm: live stream — pill suppressed');
    showPill(NONE_STATE);
    return;
  }
  const videoId = response.videoDetails?.videoId ?? '?';
  const settings = await loadSettings();
  // Options-page overrides key on the bare hostname ('youtube.com').
  const site = location.hostname.replace(/^www\./, '');
  const track = response.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
  if (track === undefined) {
    console.info('[speed-watcher] wpm: no caption tracks for this video — estimated');
    showEstimatedPill(videoId, settings, site);
    return;
  }
  const json = await fetchCaptions(track, videoId);
  if (json === null) {
    console.info('[speed-watcher] wpm: caption fetch failed — estimated');
    showEstimatedPill(videoId, settings, site);
    return;
  }
  const { words, cues } = parseYouTubeJson3(json);
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
    console.info(
      `[speed-watcher] video=${videoId} kind=${kind} lang=${lang}: captions parsed but empty — estimated`,
    );
    showEstimatedPill(videoId, settings, site);
    return;
  }

  const naturalRate =
    kind === 'asr' ? filteredTokensOverTrimmedSpan(cues) : manualCueRate(cues);
  if (naturalRate === null) {
    showEstimatedPill(videoId, settings, site);
    return;
  }
  const detected = detectMusic(cues, naturalRate) ? 'music' : 'generic';
  const contentType = resolveContentType(settings, site, detected);
  renderRecommendation(
    videoId,
    naturalRate,
    kind === 'asr' ? 'asr-cue' : 'manual-cue',
    contentType,
    settings,
    site,
  );
}

/** No usable caption rate: heuristic prior midpoint for the content type. */
function showEstimatedPill(
  videoId: string,
  settings: Settings,
  site: string,
): void {
  const contentType = resolveContentType(settings, site, 'generic');
  renderRecommendation(videoId, priorMidpoint(contentType), 'estimated', contentType, settings, site);
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
): void {
  const platformMax = resolvePlatformMax(settings, site);
  const recommendation = recommend({
    naturalRate,
    tier,
    contentType,
    platformMax,
    userTarget: resolveTarget(settings, site, contentType),
  });
  current = { videoId, site, contentType, naturalRate, platformMax, recommendation };
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

// ── Caption fetch: WEB primary, ANDROID innertube fallback ────────────────

async function fetchCaptions(track: CaptionTrack, videoId: string): Promise<unknown | null> {
  const web = await fetchJson3(track.baseUrl);
  if (web !== null) {
    window.__speedwatcherCaptionSource = 'web';
    return web;
  }
  const android = await fetchAndroidCaptions(videoId);
  if (android !== null) {
    window.__speedwatcherCaptionSource = 'android';
    return android;
  }
  window.__speedwatcherCaptionSource = 'none';
  return null;
}

async function fetchAndroidCaptions(videoId: string): Promise<unknown | null> {
  try {
    // youtubei/v1/player is the watch page's own innertube endpoint, so it
    // is built from the page origin (works on m./other youtube hosts; in
    // E2E the fixture's http origin keeps the POST inside the PAC proxy /
    // route interception instead of hitting real YouTube).
    const response = await fetch(new URL('/youtubei/v1/player', location.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: { clientName: ANDROID_CLIENT_NAME, clientVersion: ANDROID_CLIENT_VERSION },
        },
        videoId,
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as PlayerResponse;
    const track = data.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
    if (track === undefined) return null;
    return fetchJson3(track.baseUrl);
  } catch {
    return null;
  }
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
    onApply: (multiplier) => applyMultiplier(multiplier),
    onDismiss: () => dismissCurrent(),
  });
  api.mount();
  pill = { api, host };
  return pill.api;
}

function showPill(state: PillState): void {
  ensurePill().update(state);
  if (window.__speedwatcherPill !== undefined) window.__speedwatcherPill.state = state;
}

function applyMultiplier(multiplier: number): void {
  if (current === null) return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  // recommend() already clamps to platformMax; min() re-states the invariant.
  video.playbackRate = Math.min(multiplier, current.platformMax);
  void logAction('apply', multiplier);
}

function dismissCurrent(): void {
  if (current === null) return;
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

// ── Measurement hook (unchanged from Phase 0) ─────────────────────────────

function logWpm(
  videoId: string,
  kind: string,
  lang: string,
  stats: {
    word?: number | null;
    cue?: number | null;
    corrected?: number | null;
    nWords: number;
  },
): void {
  const fmt = (value: number | null | undefined): string =>
    value === undefined || value === null ? 'n/a' : value.toFixed(1);
  const line =
    `[speed-watcher] video=${videoId} kind=${kind} lang=${lang} ` +
    `wpm word-level=${fmt(stats.word)} cue-level=${fmt(stats.cue)} ` +
    `corrected=${fmt(stats.corrected)} nWords=${stats.nWords}`;
  console.info(line);
  // E2E hook: the fixture page listens for this event; the console line
  // alone is not assertable from WebDriver (no console API in Selenium).
  window.dispatchEvent(
    new CustomEvent('speedwatcher:measure', {
      detail: { videoId, kind, lang, stats, line } satisfies MeasureEventDetail,
    }),
  );
}

export interface MeasureEventDetail {
  videoId: string;
  kind: string;
  lang: string;
  stats: {
    word?: number | null;
    cue?: number | null;
    corrected?: number | null;
    nWords: number;
  };
  line: string;
}

async function waitForPlayerResponse(): Promise<PlayerResponse | undefined> {
  const deadline = Date.now() + PLAYER_RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function fetchJson3(baseUrl: string): Promise<unknown | null> {
  const url = new URL(baseUrl, location.href);
  if (!url.searchParams.has('fmt')) url.searchParams.set('fmt', 'json3');
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
