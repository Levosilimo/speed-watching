// Userscript port of the extension's YouTube measure flow (spec: ports.md §B).
// Runs in the page world on watch pages: reads the player response, captures
// the player's signed timedtext fetches (the POT gate 200-empties bare
// fetches) with the extension's capture-first chain (buffer → CC drive →
// WEB → ANDROID), measures the natural rate, and renders a minimal
// position:fixed pill (userscript/src/
// pill.ts). Storage is two optional GM keys (target + channel memory, see
// storage.ts); Greasemonkey 4's async API no-ops gracefully and the script
// still measures.
// aislop-ignore-file console-leftover

import { installCaptionCapture, TimedtextBuffer } from '../../lib/caption-capture';
import { fetchCaptions as fetchCaptionsWithContext } from '../../lib/caption-fetch';
import { parseYouTubeJson3 } from '../../lib/captions';
import { cueSignal, detectContentType, priorMidpoint } from '../../lib/heuristics';
import { resolveLanguage, UNIT_LABELS, type LanguageModel } from '../../lib/languages';
import { hasVisiblePlayerBadge } from '../../lib/live';
import { SerializedRunner } from '../../lib/measure-guard';
import { waitForPlayerResponse, type MeasureEventDetail } from '../../lib/measure-hooks';
import { detectMusic, type ContentType } from '../../lib/music';
import { recommend, type RateTier, type Recommendation } from '../../lib/recommend';
import type { LiveRate, PillState } from '../../ui/pill';
import {
  asrTierInputs,
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  totalWords,
  wordLevelWpm,
} from '../../lib/wpm';
import { channelKeyOf, type CaptionTrack, type PlayerResponse } from '../../lib/youtube';
import { createPill, type PillApi } from './pill';
import { channelMemory, readTarget, writeTarget } from './storage';

/** The userscript has no settings surface; recommend() caps at 2x like the
 * extension's default platformMax. */
const PLATFORM_MAX = 2;

interface CurrentContext {
  videoId: string;
  naturalRate: number;
  tier: RateTier;
  platformMax: number;
  unit: string;
  recommendation: Recommendation;
}

let current: CurrentContext | null = null;
let pillState: PillState | null = null;
let pillApi: PillApi | null = null;
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

/** E2E hooks (extension parity): the fixture page sets
 * window.__speedwatcherE2E before the bundle runs; production users never
 * see them. */
const e2e = __E2E__ || window.__speedwatcherE2E === true;

declare global {
  interface Window {
    __speedwatcherE2E?: boolean;
    __speedwatcherPill?: {
      state: PillState | null;
      apply(): void;
      dismiss(): void;
      stopAuto?(): void;
    };
    __speedwatcherCaptionSource?: 'web' | 'android' | 'capture' | 'none';
  }
}

function onNavigationStart(): void {
  // The capture buffer is keyed per video — a previous video's signed
  // captures must not masquerade as the next measure's (mirror of the
  // extension's yt-navigate-start clear).
  const videoId = new URLSearchParams(location.search).get('v');
  if (videoId !== null) captureBuffer.clear(videoId);
  current = null;
  activeVideo = null;
  showPill(NONE_STATE);
}

function onMediaEvent(event: Event): void {
  if (event.target instanceof HTMLVideoElement) activeVideo = event.target;
  refreshLiveRate();
}

function isLive(response?: PlayerResponse): boolean {
  if (response?.videoDetails?.isLiveContent === true) return true;
  if (response?.videoDetails?.isLiveBroadcast === true) return true;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video?.duration === Infinity) return true;
  return hasVisiblePlayerBadge(video);
}

function measure(): void {
  measureRunner.run(measureOnce);
}

/** E2E-only measurement line + event, same shape as lib/measure-hooks.ts. */
function logMeasure(
  videoId: string,
  kind: string,
  lang: string,
  stats: MeasureEventDetail['stats'],
): void {
  if (!e2e) return;
  const fmt = (value: number | null | undefined): string =>
    value === undefined || value === null ? 'n/a' : value.toFixed(1);
  const line =
    `[speed-watcher] video=${videoId} kind=${kind} lang=${lang} ` +
    `wpm word-level=${fmt(stats.word)} cue-level=${fmt(stats.cue)} ` +
    `corrected=${fmt(stats.corrected)} nWords=${stats.nWords}`;
  console.info(line);
  window.dispatchEvent(
    new CustomEvent<MeasureEventDetail>('speedwatcher:measure', {
      detail: { videoId, kind, lang, stats, line },
    }),
  );
}

async function measureOnce(): Promise<void> {
  const response = await waitForPlayerResponse();
  if (response === undefined) return;
  if (isLive(response)) {
    showPill(NONE_STATE);
    return;
  }
  const videoId = response.videoDetails?.videoId ?? '?';
  const userTarget = readTarget();
  const track = response.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
  const language = resolveLanguage(track?.languageCode) ?? undefined;
  if (track === undefined) {
    void showEstimatedPill(videoId, language, userTarget, response.videoDetails);
    return;
  }
  const json = await fetchCaptions(track, videoId);
  if (json === null) {
    void showEstimatedPill(videoId, language, userTarget, response.videoDetails);
    return;
  }
  const { words, cues } = parseYouTubeJson3(json);
  const kind = track.kind ?? 'manual';
  const lang = track.languageCode ?? '?';
  if (words.length >= 2) {
    logMeasure(videoId, kind, lang, {
      word: wordLevelWpm(words),
      cue: cueLevelWpm(cues),
      corrected: correctedCueLevelWpm(cues),
      nWords: totalWords(words),
    });
  } else if (cues.length > 0) {
    logMeasure(videoId, kind, lang, {
      cue: cueLevelWpm(cues),
      corrected: correctedCueLevelWpm(cues),
      nWords: totalWords(cues),
    });
  } else {
    void showEstimatedPill(videoId, language, userTarget, response.videoDetails);
    return;
  }

  const naturalRate =
    kind === 'asr' ? filteredTokensOverTrimmedSpan(cues, language) : manualCueRate(cues, language);
  if (naturalRate === null) {
    void showEstimatedPill(videoId, language, userTarget, response.videoDetails);
    return;
  }
  const signal = cueSignal(cues, naturalRate, language);
  let detected: ContentType = signal === null ? 'generic' : detectContentType(signal);
  if (detectMusic(cues, naturalRate, language?.unit ?? 'wpm')) detected = 'music';
  const { tier, wordInputs } = asrTierInputs(kind, words, cues);
  renderRecommendation(videoId, naturalRate, tier, detected, userTarget, wordInputs, language);
  rememberChannelRate(response.videoDetails, naturalRate, language);
}

/** No usable caption rate: heuristic prior midpoint for the content type,
 * in the language's unit when the track language is known — or the
 * channel's last measured rate when it was measured in the same language. */
async function showEstimatedPill(
  videoId: string,
  language: LanguageModel | undefined,
  userTarget: number | undefined,
  videoDetails?: PlayerResponse['videoDetails'],
): Promise<void> {
  const seeded = await channelSeededRate(videoDetails, language);
  renderRecommendation(
    videoId,
    seeded ?? priorMidpoint('generic', language),
    'estimated',
    'generic',
    userTarget,
    null,
    language,
  );
}

function renderRecommendation(
  videoId: string,
  naturalRate: number,
  tier: RateTier,
  contentType: ContentType,
  userTarget: number | undefined,
  wordInputs: { articulatoryWpm: number; timingCoverageOk: boolean } | null,
  language?: LanguageModel,
): void {
  const recommendation = recommend({
    naturalRate,
    tier,
    contentType,
    platformMax: PLATFORM_MAX,
    userTarget,
    language,
    ...wordInputs,
  });
  current = {
    videoId,
    naturalRate,
    tier,
    platformMax: PLATFORM_MAX,
    unit: UNIT_LABELS[language?.unit ?? 'wpm'],
    recommendation,
  };
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

// ── Caption fetch: capture-first, same chain as the extension ─────────────

/** Signed timedtext responses captured from the player (lib/caption-
 * capture.ts), keyed by video id — the only payload source on POT-gated
 * pages. */
const captureBuffer = new TimedtextBuffer();

async function fetchCaptions(track: CaptionTrack, videoId: string): Promise<unknown | null> {
  // The extension's capture-first order (lib/caption-fetch.ts fetchCaptions):
  // buffer pick → CC drive + word-timed wait → WEB → ANDROID. The lib sets
  // window.__speedwatcherCaptionSource under its own e2e gate.
  return fetchCaptionsWithContext(track, videoId, {
    buffer: captureBuffer,
    video: activeVideo ?? document.querySelector<HTMLVideoElement>('video'),
  });
}

// ── Pill wiring ───────────────────────────────────────────────────────────

function ensurePill(): PillApi {
  if (pillApi === null) {
    pillApi = createPill(
      {
        onApply: () => applyMultiplier(),
        onSaveTarget: (target) => {
          writeTarget(target);
          void measure();
        },
        onClearTarget: () => {
          writeTarget(undefined);
          void measure();
        },
      },
      readTarget,
    );
  }
  return pillApi;
}

function showPill(state: PillState): void {
  pillState = state;
  ensurePill().update(state);
  if (e2e && window.__speedwatcherPill !== undefined) window.__speedwatcherPill.state = state;
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
  if (pillApi === null) return;
  pillApi.updateLiveRate(computeLiveRate());
}

function applyMultiplier(): void {
  if (current === null || pillState === null) return;
  // Mirrors the extension's apply gates: music and unreachable states must
  // not touch playbackRate, and a dismissed pill stays dismissed.
  const mode = pillState.mode;
  if (mode !== 'recommend' && mode !== 'warning') return;
  const video = activeVideo ?? document.querySelector<HTMLVideoElement>('video');
  if (video === null) return;
  video.playbackRate = Math.min(current.recommendation.multiplier, current.platformMax);
  refreshLiveRate();
}

function dismissCurrent(): void {
  if (current === null) return;
  showPill(NONE_STATE);
}

// ── Channel rate memory (YouTube) ─────────────────────────────────────────

/** Remember the measured rate for the channel, seeding the estimated tier
 * of its captionless videos. Measured tiers only — call sites gate on
 * naturalRate. */
function rememberChannelRate(
  videoDetails: PlayerResponse['videoDetails'],
  naturalRate: number,
  language: LanguageModel | undefined,
): void {
  const channelKey = channelKeyOf(videoDetails);
  if (channelKey === undefined) return;
  void channelMemory.put(channelKey, {
    rate: naturalRate,
    unit: UNIT_LABELS[language?.unit ?? 'wpm'],
    language: language?.code ?? '?',
    ts: Date.now(),
  });
}

/** The channel's last measured rate, only when it was measured in this
 * video's language — the estimated prior gets smarter, the tier stays
 * 'estimated' (the rate is a prior, not this video's measurement). */
async function channelSeededRate(
  videoDetails: PlayerResponse['videoDetails'],
  language: LanguageModel | undefined,
): Promise<number | null> {
  const channelKey = channelKeyOf(videoDetails);
  if (channelKey === undefined || language === undefined) return null;
  const record = await channelMemory.get(channelKey);
  if (record === null || record.language !== language.code) return null;
  return record.rate;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────

function onKeyDown(event: KeyboardEvent): void {
  if (event.shiftKey && event.code === 'KeyW') {
    applyMultiplier();
  } else if (event.key === 'Escape') {
    if (pillApi !== null && pillApi.isMenuOpen()) {
      pillApi.closeMenu();
    } else {
      dismissCurrent();
    }
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────

function main(): void {
  if (!location.pathname.startsWith('/watch')) return;
  // The signed timedtext requests the player makes (POT-gated pages pay
  // only those) — patched once per document, as early as the bundle runs
  // (document-start; the guard flag in installCaptionCapture covers
  // re-runs). Same top-of-main install as the extension's content script.
  installCaptionCapture((capture) => {
    const videoId = new URLSearchParams(location.search).get('v');
    if (videoId !== null) captureBuffer.add(videoId, capture);
  });
  document.addEventListener('play', onMediaEvent, true);
  document.addEventListener('playing', onMediaEvent, true);
  document.addEventListener('timeupdate', onMediaEvent, true);
  document.addEventListener('ratechange', onMediaEvent, true);
  document.addEventListener('pause', onMediaEvent, true);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('yt-navigate-start', onNavigationStart);
  document.addEventListener('yt-navigate-finish', () => void measure());
  if (e2e) {
    window.__speedwatcherPill = {
      state: null,
      apply: () => applyMultiplier(),
      dismiss: () => dismissCurrent(),
    };
  }
  void measure();
}

main();
