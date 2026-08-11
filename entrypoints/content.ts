// The console.info lines in this file are the Phase-0 measurement hook
// (one-line wpm summary per video, per spike-lane spec) — not leftovers.
// aislop-ignore-file console-leftover
import { defineContentScript } from 'wxt/utils/define-content-script';
import { parseYouTubeJson3 } from '@/lib/captions';
import {
  correctedCueLevelWpm,
  cueLevelWpm,
  totalWords,
  wordLevelWpm,
} from '@/lib/wpm';
import type { PlayerResponse } from '@/lib/youtube';

const PLAYER_RESPONSE_TIMEOUT_MS = 10_000;

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  world: 'MAIN',
  main() {
    if (!location.pathname.startsWith('/watch')) return;
    void measure();
    document.addEventListener('yt-navigate-finish', () => void measure());
  },
});

async function measure(): Promise<void> {
  const response = await waitForPlayerResponse();
  if (!response) {
    console.info('[speed-watcher] wpm: player response never appeared');
    return;
  }
  const track = response.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
  if (!track) {
    console.info('[speed-watcher] wpm: no caption tracks for this video');
    return;
  }
  const json = await fetchJson3(track.baseUrl);
  if (json === null) {
    console.info('[speed-watcher] wpm: caption fetch failed');
    return;
  }
  const { words, cues } = parseYouTubeJson3(json);
  const videoId = response.videoDetails?.videoId ?? '?';
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
      `[speed-watcher] video=${videoId} kind=${kind} lang=${lang}: captions parsed but empty`,
    );
  }
}

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
