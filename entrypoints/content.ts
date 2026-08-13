// E2E hooks: one-line console.info wpm summaries compiled out of the store
// bundle (SEC-2). MAIN world — the signed timedtext fetch needs page
// context; entrypoints/bridge.content.ts is the ISOLATED sibling.
// aislop-ignore-file console-leftover
import { defineContentScript } from 'wxt/utils/define-content-script';
import { fetchAndroidCaptions, fetchJson3 } from '@/lib/caption-fetch';
import { parseYouTubeJson3 } from '@/lib/captions';
import { cueSignal, detectContentType, priorMidpoint } from '@/lib/heuristics';
import { resolveLanguage, UNIT_LABELS, type LanguageModel } from '@/lib/languages';
import { logWpm, waitForPlayerResponse } from '@/lib/measure-hooks';
import { SerializedRunner } from '@/lib/measure-guard';
import { buildWpmResponse, type MeasurementContext } from '@/lib/wpm-provider';
import { createBridgeClient, isShortcutEnvelope, isWpmEnvelope, isWpmGetRequest, SHORTCUT_APPLY, WPM_CHANNEL } from '@/lib/messaging';
import type { ContentType } from '@/lib/music';
import { detectMusic } from '@/lib/music';
import { recommend, TARGET_WPM, type RateTier, type Recommendation } from '@/lib/recommend';
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
import { channelKeyOf } from '@/lib/youtube';
import { createPill, type LiveRate, type PillApi, type PillState } from '@/ui/pill';

const bridge = createBridgeClient(window);

/** Current video's recommendation context; null until the first measure. */
let current: (MeasurementContext & { videoId: string; recommendation: Recommendation }) | null = null;
let pill: { api: PillApi; host: HTMLElement } | null = null;

/** Last rendered pill state — the shortcut handler and live line gate on it. */
let pillState: PillState | null = null;

/** The element that last fired a media event — the apply target on pages
 * with more than one video. */
let activeVideo: HTMLVideoElement | null = null;

// Serializes measure() against overlapping triggers (initial load + SPA navigation).
const measureRunner = new SerializedRunner();

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
    __speedwatcherPill?: { state: PillState | null; apply(): void; dismiss(): void };
    __speedwatcherCaptionSource?: 'web' | 'android' | 'none';
    // E2E hook: settings write through the bridge (same path the options
    // page uses) — the shared specs exercise the bridge in both browsers.
    __speedwatcherSettings?: { set(settings: Settings): Promise<void> };
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
      };
      window.__speedwatcherSettings = {
        set: (settings) => bridge.request({ type: 'settings:set', settings }).then(() => undefined),
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
  current = null;
  activeVideo = null;
  showPill(NONE_STATE);
}

function onMediaEvent(event: Event): void {
  if (event.target instanceof HTMLVideoElement) activeVideo = event.target;
  refreshLiveRate();
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
    void showEstimatedPill(videoId, settings, site, undefined, response.videoDetails);
    return;
  }
  const json = await fetchCaptions(track, videoId);
  if (json === null) {
    if (__E2E__) console.info('[speed-watcher] wpm: caption fetch failed — estimated');
    void showEstimatedPill(videoId, settings, site, language, response.videoDetails);
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
    if (__E2E__) {
      console.info(`[speed-watcher] video=${videoId} kind=${kind} lang=${lang}: captions parsed but empty — estimated`);
    }
    void showEstimatedPill(videoId, settings, site, language, response.videoDetails);
    return;
  }

  const naturalRate =
    kind === 'asr' ? filteredTokensOverTrimmedSpan(cues, language) : manualCueRate(cues, language);
  if (naturalRate === null) {
    void showEstimatedPill(videoId, settings, site, language, response.videoDetails);
    return;
  }
  // Auto-detect the register from the measured signal; the user/site
  // preference still outranks it in resolveContentType. Music is checked
  // first — lyric tracks share no speech register (detectContentType
  // never returns 'music').
  const signal = cueSignal(cues, naturalRate, language);
  let detected: ContentType = signal === null ? 'generic' : detectContentType(signal);
  if (detectMusic(cues, naturalRate)) detected = 'music';
  const contentType = resolveContentType(settings, site, detected);
  const { tier, wordInputs } = asrTierInputs(kind, words, cues);
  renderRecommendation(videoId, naturalRate, tier, contentType, settings, site, wordInputs, language);
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
): Promise<void> {
  const contentType = resolveContentType(settings, site, 'generic');
  const seeded = await channelSeededRate(videoDetails, language);
  renderRecommendation(videoId, seeded ?? priorMidpoint(contentType, language), 'estimated', contentType, settings, site, null, language);
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
  current = { videoId, site, contentType, naturalRate, platformMax, tier,
    unit: UNIT_LABELS[language?.unit ?? 'wpm'], language: language?.code ?? null,
    target: resolveUserTarget(settings, site, contentType) ?? language?.target ?? TARGET_WPM,
    recommendation };
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
    onApply: (multiplier) => applyMultiplier(multiplier),
    onDismiss: () => dismissCurrent(),
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

function applyMultiplier(multiplier: number): void {
  if (current === null) return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  // recommend() already clamps to platformMax; min() re-states the invariant.
  video.playbackRate = Math.min(multiplier, current.platformMax);
  // Show the live line immediately; steady-state ticks are throttled in the pill.
  refreshLiveRate();
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

