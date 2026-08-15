// Player-side capture of signed /api/timedtext responses (fetch + XHR).
// YouTube's POT gate (mid-2026) answers bare captionTracks baseUrl fetches
// with HTTP 200 + empty body on logged-in pages; only the player's own
// signed requests return payloads. The extension hooks those requests
// instead of re-fetching. MAIN-world only: the wraps patch window.fetch and
// XMLHttpRequest.prototype, which the isolated world cannot reach.

import { parseYouTubeJson3 } from './captions';

export interface CapturedTimedtext {
  url: string;
  httpStatus: number;
  body: string;
}

declare global {
  interface Window {
    /** Idempotence guard: the page is patched once even if the caller
     * re-runs (e.g. across SPA navigations). */
    __speedwatcherCaptionCapture?: true;
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
  if (window.__speedwatcherCaptionCapture === true) return;
  window.__speedwatcherCaptionCapture = true;

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
    } else {
      list.push(capture);
    }
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
