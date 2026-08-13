// Phase-0 measurement hook, moved out of entrypoints/content.ts so the
// watch-page script stays under the file-size gate: the E2E wpm summaries
// (one-line console.info lines compiled out of the store bundle, SEC-2) and
// the player-response wait. Runs in the MAIN world with the pipeline.
// aislop-ignore-file console-leftover

import type { PlayerResponse } from './youtube';

export const PLAYER_RESPONSE_TIMEOUT_MS = 10_000;

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

/** E2E hook: logs the wpm line and dispatches 'speedwatcher:measure' — the
 * fixture page listens for the event because WebDriver has no console API. */
export function logWpm(
  videoId: string,
  kind: string,
  lang: string,
  stats: MeasureEventDetail['stats'],
): void {
  const fmt = (value: number | null | undefined): string =>
    value === undefined || value === null ? 'n/a' : value.toFixed(1);
  const line =
    `[speed-watcher] video=${videoId} kind=${kind} lang=${lang} ` +
    `wpm word-level=${fmt(stats.word)} cue-level=${fmt(stats.cue)} ` +
    `corrected=${fmt(stats.corrected)} nWords=${stats.nWords}`;
  if (__E2E__) console.info(line);
  window.dispatchEvent(
    new CustomEvent('speedwatcher:measure', {
      detail: { videoId, kind, lang, stats, line } satisfies MeasureEventDetail,
    }),
  );
}

export async function waitForPlayerResponse(): Promise<PlayerResponse | undefined> {
  const deadline = Date.now() + PLAYER_RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}
