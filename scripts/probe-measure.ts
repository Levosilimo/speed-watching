// Page-side measurement functions for the generic-player probe.
//
// Playwright serializes evaluated functions WITHOUT module scope, so every
// function in this file is self-contained: it may not reference any other
// module-level binding. The shadow-DOM walk is therefore inlined wherever
// videos must be enumerated.

export interface FrameInfo {
  url: string;
  sameOrigin: boolean;
  videoCount: number;
}

export interface VideoProbe {
  present: boolean;
  srcScheme: string | null;
  mse: boolean;
  mediaKeys: boolean;
  canPlayMpegUrl: boolean;
  defaultRate: number | null;
  setRate: number | null;
  after2s: number | null;
  afterSeek: number | null;
  afterPausePlay: number | null;
  ratechangeEvents: number;
  paused: boolean;
  readyState: number | null;
}

export interface CaptionsProbe {
  textTrackCount: number;
  tracks: Array<{ kind: string; label: string; language: string; mode: string }>;
  trackElements: number;
  cuesAccessible: boolean;
  cueCount: number | null;
}

export function emptyVideoProbe(): VideoProbe {
  return {
    present: false,
    srcScheme: null,
    mse: false,
    mediaKeys: false,
    canPlayMpegUrl: false,
    defaultRate: null,
    setRate: null,
    after2s: null,
    afterSeek: null,
    afterPausePlay: null,
    ratechangeEvents: 0,
    paused: false,
    readyState: null,
  };
}

export function emptyCaptionsProbe(): CaptionsProbe {
  return {
    textTrackCount: 0,
    tracks: [],
    trackElements: 0,
    cuesAccessible: false,
    cueCount: null,
  };
}

export function videoCountInFrame(): number {
  const walk = (root: Document | ShadowRoot): number => {
    let n = root.querySelectorAll('video').length;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) n += walk(el.shadowRoot);
    }
    return n;
  };
  return walk(document);
}

export function measureFrameStructure(): {
  videoCount: number;
  iframeCount: number;
  crossOriginIframes: number;
} {
  const iframes = document.querySelectorAll('iframe');
  let cross = 0;
  for (const f of iframes) {
    // The property access itself throws for cross-origin frames.
    let accessible = false;
    try {
      accessible = f.contentDocument !== null;
    } catch {
      accessible = false;
    }
    if (!accessible) cross += 1;
  }
  const walk = (root: Document | ShadowRoot): number => {
    let n = root.querySelectorAll('video').length;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) n += walk(el.shadowRoot);
    }
    return n;
  };
  return {
    videoCount: walk(document),
    iframeCount: iframes.length,
    crossOriginIframes: cross,
  };
}

export function detectPlayers(): string[] {
  const g = window as unknown as Record<string, unknown>;
  const hits: string[] = [];
  const candidates: Array<[string, unknown]> = [
    ['shaka', g.shaka],
    ['video.js', g.videojs],
    ['hls.js', g.Hls],
    ['dash.js', g.dashjs],
    ['JW Player', g.jwplayer],
    ['Clappr', g.Clappr],
    ['Plyr', g.Plyr],
    ['MediaElement.js', g.MediaElement],
    ['flowplayer', g.flowplayer],
  ];
  for (const [name, val] of candidates) {
    if (val !== undefined) hits.push(name);
  }
  return hits;
}

export function sampleRate(): { rate: number; ratechange: number } | null {
  const win = window as unknown as {
    __swProbeVideo?: HTMLVideoElement;
    __swProbeRatechange?: number;
  };
  const v = win.__swProbeVideo;
  if (!v) return null;
  return { rate: v.playbackRate, ratechange: win.__swProbeRatechange ?? 0 };
}

export function initRateProbe(idx: number): VideoProbe | null {
  const walk = (root: Document | ShadowRoot, out: HTMLVideoElement[]): void => {
    for (const el of root.querySelectorAll('video')) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot, out);
    }
  };
  const vids: HTMLVideoElement[] = [];
  walk(document, vids);
  const v = vids[idx];
  if (!v) return null;
  const win = window as unknown as {
    __swProbeVideo: HTMLVideoElement;
    __swProbeRatechange: number;
  };
  win.__swProbeVideo = v;
  win.__swProbeRatechange = 0;
  v.addEventListener('ratechange', () => {
    win.__swProbeRatechange += 1;
  });
  let scheme: string | null = null;
  try {
    scheme = v.currentSrc ? new URL(v.currentSrc).protocol : null;
  } catch {
    scheme = null;
  }
  v.playbackRate = 1.5;
  return {
    present: true,
    srcScheme: scheme,
    mse: v.srcObject !== null,
    mediaKeys: v.mediaKeys !== null,
    canPlayMpegUrl: v.canPlayType('application/vnd.apple.mpegURL') !== '',
    defaultRate: v.defaultPlaybackRate,
    setRate: v.playbackRate,
    after2s: null,
    afterSeek: null,
    afterPausePlay: null,
    ratechangeEvents: 0,
    paused: v.paused,
    readyState: v.readyState,
  };
}

export function seekProbe(): void {
  const win = window as unknown as { __swProbeVideo?: HTMLVideoElement };
  const v = win.__swProbeVideo;
  if (!v) return;
  try {
    const next = v.currentTime + 2;
    v.currentTime = Number.isFinite(v.duration)
      ? Math.min(next, v.duration - 0.5)
      : next;
  } catch {
    // live streams reject programmatic seeks
  }
}

export function pausePlayProbe(): void {
  const win = window as unknown as { __swProbeVideo?: HTMLVideoElement };
  const v = win.__swProbeVideo;
  if (!v) return;
  try {
    v.pause();
  } catch {
    // element may be detached mid-probe
  }
  try {
    v.play().catch(() => undefined);
  } catch {
    // play() without user gesture is rejected, which is the point: the
    // state transition still runs the player's rate handlers
  }
}

export function captionsProbe(idx: number): CaptionsProbe | null {
  const vids: HTMLVideoElement[] = [];
  const findVids = (root: Document | ShadowRoot, out: HTMLVideoElement[]): void => {
    for (const el of root.querySelectorAll('video')) out.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) findVids(el.shadowRoot, out);
  };
  findVids(document, vids);
  const v = vids[idx];  if (!v) return null;
  const tracks = [...v.textTracks].map((t) => ({
    kind: t.kind,
    label: t.label,
    language: t.language,
    mode: t.mode,
  }));
  let cuesAccessible = false;
  let cueCount: number | null = null;
  for (const t of v.textTracks) {
    if (t.cues) {
      cuesAccessible = true;
      cueCount = (cueCount ?? 0) + t.cues.length;
    }
  }
  return {
    textTrackCount: v.textTracks.length,
    tracks,
    trackElements: document.querySelectorAll('track').length,
    cuesAccessible,
    cueCount,
  };
}

export function liveChannelUrlInPage(): string | null {
  const card = document.querySelector('[data-a-target="card-link"]');
  if (card instanceof HTMLAnchorElement) return card.href;
  const denied = new Set([
    '/directory', '/subscriptions', '/downloads', '/jobs', '/about', '/ads',
    '/press', '/partners', '/developers', '/shop', '/events', '/turbo',
    '/bits', '/watchtower', '/settings', '/inventory', '/followed',
    '/purchases', '/search', '/wallet', '/drops', '/squad', '/prime',
  ]);
  for (const a of document.querySelectorAll('a[href^="/"]')) {
    if (!(a instanceof HTMLAnchorElement)) continue;
    const h = a.getAttribute('href') ?? '';
    if (/^\/[A-Za-z0-9_]{2,25}$/.test(h) && !denied.has(h)) return a.href;
  }
  return null;
}
