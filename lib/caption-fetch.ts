import type { PlayerResponse } from '@/lib/youtube';

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
