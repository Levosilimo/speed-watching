// E2E hooks: one-line console.info wpm summaries compiled out of the store
// bundle (SEC-2). MAIN world — the signed timedtext fetch needs page
// context; entrypoints/bridge.content.ts is the ISOLATED sibling. The
// per-video rate controller (auto-apply lifecycle, pill, live/saved lines)
// lives in lib/rate-controller.ts; this file keeps the measurement
// pipeline, the chapter feature, and the shortcut/wpm relays.

import { defineContentScript } from 'wxt/utils/define-content-script';
import { fetchAndroidCaptions, fetchJson3 } from '@/lib/caption-fetch';
import { parseYouTubeJson3 } from '@/lib/captions';
import { cueSignal, detectContentType, priorMidpoint } from '@/lib/heuristics';
import { resolveLanguage, UNIT_LABELS, type LanguageModel, type RateRange } from '@/lib/languages';
import { logWpm, waitForPlayerResponse } from '@/lib/measure-hooks';
import { buildWpmResponse, type MeasurementContext } from '@/lib/wpm-provider';
import { createBridgeClient, isShortcutEnvelope, SHORTCUT_APPLY } from '@/lib/messaging';
import { isWpmEnvelope, isWpmGetRequest, WPM_CHANNEL } from '@/lib/wpm-protocol';
import type { ContentType } from '@/lib/music';
import { detectMusic } from '@/lib/music';
import { TARGET_WPM, type Recommendation } from '@/lib/recommend';
import { segmentRates, type RateSegment } from '@/lib/chapters';
import { ChapterScheduler } from '@/lib/chapter-scheduler';
import { resolveContentType, resolvePlatformMax, resolveUserTarget, type Settings } from '@/lib/settings';
import { asrTierInputs, correctedCueLevelWpm, cueLevelWpm, filteredTokensOverTrimmedSpan, manualCueRate, totalWords, wordLevelWpm } from '@/lib/wpm';
import type { CaptionTrack, PlayerResponse } from '@/lib/youtube';
import { channelKeyOf, chaptersOf } from '@/lib/youtube';
import { createNudgeHost } from '@/ui/nudge-host';
import { createRateController } from '@/lib/rate-controller';
import type { PillTestHook } from '@/lib/rate-controller-types';

/** The current-video context: the measurement plus the identity and
 * recommendation the wpm:get answer and the override log read. */
type Current = MeasurementContext & {
  videoId: string;
  recommendation: Recommendation;
  range: RateRange;
};

const bridge = createBridgeClient(window);

// Chapter feature state (content-only): the per-chapter rate plan, the
// session-scoped consent, and the scheduler that applies boundary steps.
let chapterRates: RateSegment[] | null = null;
let chapterConsent = false;
const chapterScheduler = new ChapterScheduler();

const controller = createRateController<Current>({
  bridge,
  nudgeSurface: createNudgeHost(bridge),
  // The player area anchors the pill; the controller positions the host inside it.
  hostAnchor: () => document.querySelector<HTMLElement>('#movie_player') ?? document.body,
  // YouTube holds the assigned rate; there is no re-assert loop to detach.
  applyRate: (video, rate) => {
    video.playbackRate = rate;
  },
  stopRateApplies: () => undefined,
  makeCurrent: (parts) => ({
    site: parts.site,
    contentType: parts.contentType,
    naturalRate: parts.naturalRate,
    platformMax: parts.platformMax,
    tier: parts.tier,
    unit: UNIT_LABELS[parts.unit],
    recommendation: parts.recommendation,
    range: parts.range,
    videoId: parts.videoId,
    language: parts.language?.code ?? null,
    target: parts.userTarget ?? parts.language?.target ?? TARGET_WPM,
  }),
  videoIdOf: (current) => current.videoId,
  chapter: {
    extras: () => ({
      chaptersAvailable: chapterRates !== null,
      autoAdjust: chapterConsent,
      chapterStatus: chapterConsent ? chapterStatusNow() : undefined,
    }),
    onConsent: (enabled, video, apply) => {
      chapterConsent = enabled;
      if (enabled && video !== null && chapterRates !== null) {
        chapterScheduler.start(video, chapterRates, apply);
      } else {
        chapterScheduler.stop();
      }
    },
    onReset: () => {
      chapterRates = null;
      chapterConsent = false;
      chapterScheduler.stop();
    },
  },
});

declare global {
  interface Window {
    __speedwatcherPill?: PillTestHook;
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
    document.addEventListener('play', controller.onMediaEvent, true);
    document.addEventListener('playing', controller.onMediaEvent, true);
    document.addEventListener('timeupdate', controller.onMediaEvent, true);
    // Live-rate line: ratechange and pause also drive the throttled refresh.
    document.addEventListener('ratechange', controller.onMediaEvent, true);
    document.addEventListener('pause', controller.onMediaEvent, true);
    // Keyboard shortcuts (chrome.commands): the background → bridge → window
    // chain delivers the envelope here — chrome.* is unavailable in this
    // world. Gated like the pill's Apply button.
    window.addEventListener('message', (event: MessageEvent): void => {
      if (!isShortcutEnvelope(event.data)) return;
      const message = event.data.message;
      if (message.type === SHORTCUT_APPLY) {
        const current = controller.current;
        const pillState = controller.pillState;
        if (current === null || pillState === null || (pillState.mode !== 'recommend' && pillState.mode !== 'warning')) return;
        controller.userApply(current.recommendation.multiplier);
      } else if (controller.pillState !== null && controller.pillState.mode !== 'none') controller.dismissCurrent();
    });
    // Measured-rate provider (Tier 4): relays wpm:get to the answer builder;
    // no source guard, like the shortcut relay (the bridge validates the
    // response, and the channel carries only the minimized measurement).
    window.addEventListener('message', (event: MessageEvent): void => {
      if (!isWpmEnvelope(event.data) || !isWpmGetRequest(event.data.message)) return;
      window.postMessage({ channel: WPM_CHANNEL, message: buildWpmResponse(controller.current) }, '*');
    });
    // E2E-only hooks (SEC-2): the store bundle ships without these.
    if (__E2E__) {
      window.__speedwatcherPill = controller.pillHook;
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
          const video = controller.activeVideo ?? document.querySelector<HTMLVideoElement>('video');
          if (video === null) return;
          video.currentTime = sec;
          video.dispatchEvent(new Event('timeupdate'));
        },
      };
    }
    void measure();
    // SPA navigation: invalidate the old video's recommendation before the
    // next measure lands, so a fast Apply cannot use the previous multiplier.
    document.addEventListener('yt-navigate-start', controller.reset);
    document.addEventListener('yt-navigate-finish', () => void measure());
  },
});

function measure(): void {
  controller.runMeasure((startedAt) => measureOnce(startedAt));
}

function isLive(): boolean {
  const video = controller.activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video?.duration === Infinity) return true;
  return document.querySelector('.ytp-live-badge') !== null;
}

async function measureOnce(startedAt: number): Promise<void> {
  const response = await waitForPlayerResponse();
  if (!response) {
    if (__E2E__) console.info('[speed-watcher] wpm: player response never appeared');
    return;
  }
  if (isLive()) {
    if (__E2E__) console.info('[speed-watcher] wpm: live stream — pill suppressed');
    controller.showNone();
    return;
  }
  const videoId = response.videoDetails?.videoId ?? '?';
  const settings = await controller.loadSettings();
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
  // The per-chapter plan: one rate per chapter through the same per-kind
  // rule and recommend() inputs as the whole-video recommendation below.
  // Sub-floor chapters inherit the whole-video recommendation inside
  // segmentRates.
  if (chapters !== null) {
    chapterRates = segmentRates(cues, chapters, kind, language, {
      platformMax: resolvePlatformMax(settings, site),
      contentType,
      userTarget: resolveUserTarget(settings, site, contentType),
    });
  }
  controller.renderRecommendation(videoId, naturalRate, tier, contentType, settings, site, wordInputs, language, startedAt);
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
  controller.renderRecommendation(videoId, seeded ?? priorMidpoint(contentType), 'estimated', contentType, settings, site, null, language, startedAt);
  // Demand proxy (Phase-2 STT gate): one local count per estimated render.
  // Best-effort like logAction — a dead bridge must not suppress the pill.
  void bridge
    .request({ type: 'demand:increment', contentType })
    .catch(() => undefined);
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
