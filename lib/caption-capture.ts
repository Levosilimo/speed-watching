// Player-side capture of signed /api/timedtext responses (fetch + XHR).
// YouTube's POT gate (mid-2026) answers bare captionTracks baseUrl fetches
// with HTTP 200 + empty body on logged-in pages; only the player's own
// signed requests return payloads. The extension hooks those requests
// instead of re-fetching. MAIN-world only: the wraps patch window.fetch and
// XMLHttpRequest.prototype, which the isolated world cannot reach.

import { parseYouTubeJson3 } from './captions';

/** Per-video capture cap: the player re-fetches signed timedtext on every
 * CC toggle, seek, and quality change, and add() used to append without
 * bound — pruned only by clear(videoId) at video change, so a long watch
 * session grew the list forever (the buffer-soak finding, Wave 3).
 * Overflow evicts by largest-N (see add). 16 covers a session's worth of
 * re-fetches while bounding memory per video. */
export const MAX_CAPTURES_PER_VIDEO = 16;

export interface CapturedTimedtext {
  url: string;
  httpStatus: number;
  body: string;
}

declare global {
  interface Window {
    /** Idempotence guard: the page is patched once even if the caller
     * re-runs (e.g. across SPA navigations). Kept out of the __speedwatcher
     * hook namespace: it is production behavior, not an E2E hook. */
    __swCaptionCaptureInstalled?: true;
  }
}

/** Host+path only — the pot proof-of-origin param (and any other query
 * string) is irrelevant to the match. */
function isTimedtextUrl(url: URL): boolean {
  const host = url.hostname;
  const onYoutube = host === 'youtube.com' || host.endsWith('.youtube.com');
  return (
    (onYoutube && url.pathname === '/api/timedtext') ||
    (host === 'video.google.com' && url.pathname === '/timedtext')
  );
}

export function installCaptionCapture(onCapture: (capture: CapturedTimedtext) => void): void {
  if (window.__swCaptionCaptureInstalled === true) return;
  window.__swCaptionCaptureInstalled = true;

  // Natives saved before patching so the wrappers (and any later re-fetch
  // in this or other modules) never self-intercept.
  const nativeFetch = window.fetch.bind(window);
  const nativeOpen = XMLHttpRequest.prototype.open as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) => void;
  const nativeSend = XMLHttpRequest.prototype.send;

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (response.status === 200 && isTimedtextUrl(new URL(response.url))) {
      // clone() before .text(): the body is a one-shot stream and the
      // original response must stay untouched for the player.
      onCapture({
        url: response.url,
        httpStatus: 200,
        body: await response.clone().text(),
      });
    }
    return response;
  };

  const pendingUrls = new WeakMap<XMLHttpRequest, string>();

  const wrappedOpen: typeof nativeOpen = function (
    this: XMLHttpRequest,
    method,
    url,
    async,
    username,
    password,
  ) {
    pendingUrls.set(this, String(url));
    return nativeOpen.call(this, method, url, async, username, password);
  };
  XMLHttpRequest.prototype.open = wrappedOpen;

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body) {
    const url = pendingUrls.get(this);
    if (url !== undefined) {
      this.addEventListener(
        'load',
        () => {
          pendingUrls.delete(this);
          if (this.status === 200 && isTimedtextUrl(new URL(url, location.href))) {
            // responseText is cached on the instance — safe to read here.
            onCapture({ url, httpStatus: 200, body: this.responseText });
          }
        },
        { once: true },
      );
    }
    nativeSend.call(this, body);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Word-timed payload: non-empty top-level `windows`, or any event seg with
 * a numeric tOffsetMs (parseYouTubeJson3's wordTokens drops untimed segs). */
function isWordTimed(body: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isRecord(payload)) return false;
  return asArray(payload.windows).length > 0 || parseYouTubeJson3(payload).words.length > 0;
}

export class TimedtextBuffer {
  private readonly byVideo = new Map<string, CapturedTimedtext[]>();

  add(videoId: string, capture: CapturedTimedtext): void {
    const list = this.byVideo.get(videoId);
    if (list === undefined) {
      this.byVideo.set(videoId, [capture]);
      return;
    }
    list.push(capture);
    if (list.length <= MAX_CAPTURES_PER_VIDEO) return;
    // Overflow: evict the smallest body, preferring non-word-timed
    // victims — the largest word-timed capture is never the smallest
    // non-word-timed body, and when every survivor is word-timed it is
    // the largest, hence never the victim — so pickWordTimed's contract
    // survives eviction pressure.
    let victimIndex = -1;
    for (let i = 0; i < list.length; i++) {
      if (isWordTimed(list[i]!.body)) continue;
      if (victimIndex === -1 || list[i]!.body.length < list[victimIndex]!.body.length) victimIndex = i;
    }
    if (victimIndex === -1) {
      victimIndex = list.reduce((best, c, i) => (c.body.length < list[best]!.body.length ? i : best), 0);
    }
    list.splice(victimIndex, 1);
  }

  /** Number of captures held for a video — the soak's growth observation
   * point (the list is otherwise private). */
  size(videoId: string): number {
    return this.byVideo.get(videoId)?.length ?? 0;
  }

  clear(videoId: string): void {
    this.byVideo.delete(videoId);
  }

  /** Largest word-timed capture for the video, or null. Body length stands
   * in for completeness; the first response is never picked — the player
   * fires a ~22s preview request before the real CC toggle, and only a full
   * payload carries all words. */
  pickWordTimed(videoId: string): CapturedTimedtext | null {
    const list = this.byVideo.get(videoId);
    if (list === undefined) return null;
    let best: CapturedTimedtext | null = null;
    for (const capture of list) {
      if (!isWordTimed(capture.body)) continue;
      if (best === null || capture.body.length > best.body.length) best = capture;
    }
    return best;
  }
}
