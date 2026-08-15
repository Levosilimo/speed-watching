import type { CaptionTrack, PlayerResponse } from '@/lib/youtube';
import type { TimedtextBuffer } from './caption-capture';
import { restoreCcState, triggerCcAutomation, waitForWordTimedCapture } from './caption-trigger';

// ANDROID innertube fallback (plan-v3): the WEB timedtext endpoint returns
// 200-with-empty-body / 400/403 from some IPs, while the ANDROID
// youtubei/v1/player POST returns real caption tracks (proven from hostile
// IPs in Phase 0). ToS gray area: the ANDROID client designation is not a
// public API. The fallback only reads captions — the same data the WEB path
// would serve — and never touches playback or DRM surfaces.
const ANDROID_CLIENT_NAME = 'ANDROID';
const ANDROID_CLIENT_VERSION = '20.10.31';

export async function fetchJson3(baseUrl: string): Promise<unknown | null> {
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

export async function fetchAndroidCaptions(videoId: string): Promise<unknown | null> {
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

export interface CaptionFetchContext {
  /** The capture buffer of the player's signed timedtext responses. */
  buffer: TimedtextBuffer;
  /** The current player element — capture driving needs a ready video. */
  video: HTMLVideoElement | null;
}

/** Capture-first caption fetch: the buffer's word-timed capture (the
 * player's signed fetch — POT-gated pages pay only those) wins; otherwise
 * a ready player is driven through the CC controls once and awaited before
 * the bare WEB fetch (which 200-empties on signed-in pages); ANDROID
 * innertube last. Returns the parsed json3 payload or null. */
export async function fetchCaptions(
  track: CaptionTrack,
  videoId: string,
  ctx: CaptionFetchContext,
): Promise<unknown | null> {
  // The buffer also holds this extension's own web fetches; a previous
  // measure's capture must not masquerade as this measure's.
  ctx.buffer.clear(videoId);
  const capture = ctx.buffer.pickWordTimed(videoId);
  if (capture !== null) {
    if (__E2E__) window.__speedwatcherCaptionSource = 'capture';
    return JSON.parse(capture.body);
  }
  const video = ctx.video;
  if (video !== null && (video.readyState >= 1 || !video.paused)) {
    let ccWasOn: boolean | null = null;
    try {
      ccWasOn = await triggerCcAutomation();
      const nudge = (): void => {
        video.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
      };
      const captured = await waitForWordTimedCapture(ctx.buffer, videoId, nudge, 15000);
      if (captured !== null) {
        if (__E2E__) window.__speedwatcherCaptionSource = 'capture';
        return JSON.parse(captured.body);
      }
    } finally {
      // The automation must not leave the subtitles on: restore the prior
      // CC state and close any menu on success AND timeout/cancel alike.
      restoreCcState(ccWasOn);
    }
  }
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
