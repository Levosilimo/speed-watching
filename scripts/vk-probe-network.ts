// Network-layer timed-text capture for the Tier 2b platform probe
// (scripts/vk-probe.ts). Classifies SRT/VTT/JSON/m3u8 payloads by timing
// granularity (word-level vs cue-level) and records every URL that could
// carry captions. Split out so the probe's files stay under the repo's
// 400-line cap.

import type { Page, Response } from 'playwright';
import { parseHlsSubtitleUris } from '../lib/captions-harvest';
import type { ProbeStatus, Timing } from './vk-probe-measure';

export interface NetworkCapture {
  subtitleUrls: string[];
  payloads: CapturedPayload[];
  hlsSubtitleUris: number;
}

export interface CapturedPayload {
  url: string;
  kind: 'm3u8' | 'srt' | 'vtt' | 'json' | 'other';
  wordLevel: boolean;
  cueLevel: boolean;
  hlsSubtitleUris: number;
  bytes: number;
}

// URL classes that can carry timed text. 'playlist' is deliberately broad —
// HLS masters and player configs both ride it, and a URL-only hit is cheap.
// 'okcdn' is Дзен's caption carrier (its VTT track src is a signed okcdn.ru
// URL with no .vtt suffix).
const NET_PATTERN =
  /\.m3u8(\?|$)|\.srt(\?|$)|\.vtt(\?|$)|\.mpd(\?|$)|subtitle|caption|timedtext|transcript|al_video|video_options|playlist|okcdn/i;
// Only these get body capture; everything else is recorded as a URL hit.
const BODY_PATTERN =
  /\.m3u8(\?|$)|\.srt(\?|$)|\.vtt(\?|$)|subtitle|timedtext|caption|transcript|al_video|video_options|player_config|video-info|okcdn/i;
export const WALL_URL_PATTERN = /(login|auth|passport|sso|checkcaptcha|captcha|challenge)/i;
const MAX_BODY_BYTES = 6_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const asFinite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// evaluate has no timeout option; a stalled frame (mid-navigation, busy
// ad iframe) can block it past the caller's deadline. Racing against a
// fallback keeps every per-page wait bounded.
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))]);
}

interface TimingSignal {
  wordLevel: boolean;
  cueLevel: boolean;
}

// Walks parsed JSON looking for timed-text arrays. An array named
// words/tokens/word_times whose items carry text + a start field is
// word-level; any other array of {text, start} objects is cue-level.
function probeTiming(value: unknown, key: string | null, out: TimingSignal): void {
  if (Array.isArray(value)) {
    const objects = value.filter(isRecord);
    if (objects.length === 0) return;
    const hasText = objects.some(
      (o) => asString(o.text) !== null || asString(o.w) !== null || asString(o.word) !== null,
    );
    const hasStart = objects.some(
      (o) =>
        asFinite(o.start) !== null ||
        asFinite(o.startMs) !== null ||
        asFinite(o.startTime) !== null ||
        asFinite(o.begin) !== null ||
        asFinite(o.t) !== null,
    );
    if (hasText && hasStart) {
      if (key !== null && /^(words|word_times|tokens|wordTokens|word_segments)$/.test(key)) {
        out.wordLevel = true;
      } else {
        out.cueLevel = true;
      }
    }
    for (const o of objects) probeTiming(o, key, out);
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) probeTiming(child, childKey, out);
  }
}

function classifyPayload(url: string, body: string): CapturedPayload {
  if (/\.m3u8(\?|$)/i.test(url)) {
    const uris = parseHlsSubtitleUris(body);
    return {
      url,
      kind: 'm3u8',
      wordLevel: false,
      cueLevel: uris.length > 0,
      hlsSubtitleUris: uris.length,
      bytes: body.length,
    };
  }
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const signal: TimingSignal = { wordLevel: false, cueLevel: false };
    try {
      probeTiming(JSON.parse(trimmed) as unknown, null, signal);
    } catch {
      // body is not JSON despite the shape — signal stays all-false
    }
    return { url, kind: 'json', ...signal, hlsSubtitleUris: 0, bytes: body.length };
  }
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(body)) {
    // VTT cues can embed per-word timestamps (<00:00:19.225><c>word</c>);
    // those cues carry word timing inside the cue text.
    const wordTags = /<\d{1,2}:\d{2}:\d{2}[.,]\d{3}>/.test(body);
    return {
      url,
      kind: /WEBVTT/.test(body.slice(0, 64)) ? 'vtt' : 'srt',
      wordLevel: wordTags,
      cueLevel: true,
      hlsSubtitleUris: 0,
      bytes: body.length,
    };
  }
  return { url, kind: 'other', wordLevel: false, cueLevel: false, hlsSubtitleUris: 0, bytes: body.length };
}

export function hookNetwork(page: Page, capture: NetworkCapture): void {
  page.on('response', (response: Response) => {
    if (!NET_PATTERN.test(response.url())) return;
    const url = response.url();
    // okcdn segment fetches share the caption carrier's host; keep only the
    // caption-bearing variants (type=2 carries the VTT, type=1 the meta).
    const okcdnNoise = url.includes('okcdn.ru') && !/type=[12][&]|asubs=y/.test(url);
    if (!okcdnNoise && capture.subtitleUrls.length < 60) capture.subtitleUrls.push(url);
    if (!BODY_PATTERN.test(url)) return;
    const contentType = response.headers()['content-type'] ?? '';
    if (/^(video|audio|image|font)\//.test(contentType)) return;
    const contentLength = Number(response.headers()['content-length'] ?? 0);
    if (contentLength > MAX_BODY_BYTES) return;
    void response
      .text()
      .then((body) => {
        if (body.length > MAX_BODY_BYTES) return;
        const payload = classifyPayload(url, body);
        capture.payloads.push(payload);
        capture.hlsSubtitleUris += payload.hlsSubtitleUris;
      })
      .catch(() => undefined);
  });
}

export function timingVerdict(
  capture: NetworkCapture,
  apiCues: number,
  apiTracks: number,
): { status: ProbeStatus; timing: Timing } {
  // Caption-bearing candidates only: media m3u8 playlists without subtitle
  // renditions are not caption payloads and must not force parse-unknown.
  const captionPayloads = capture.payloads.filter(
    (p) =>
      p.wordLevel ||
      p.cueLevel ||
      p.kind === 'json' ||
      p.kind === 'srt' ||
      p.kind === 'vtt' ||
      (p.kind === 'm3u8' && p.hlsSubtitleUris > 0),
  );
  if (captionPayloads.some((p) => p.wordLevel)) return { status: 'ok', timing: 'word' };
  if (captionPayloads.some((p) => p.cueLevel)) return { status: 'ok', timing: 'cue' };
  if (apiCues > 0) return { status: 'ok', timing: 'cue' };
  if (apiTracks > 0) return { status: 'ok', timing: 'unknown' };
  if (captionPayloads.length > 0) return { status: 'parse-unknown', timing: 'unknown' };
  return { status: 'no-captions', timing: 'none' };
}
