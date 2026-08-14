// Network-layer caption harvest for non-YouTube players.
//
// textTracks was empty on every measured generic player (Phase-0 probe,
// docs/phase0-generic-probe.md), so captions cannot come from the standard
// API. Instead the harvest probes the page's network layer — the same
// requests the player itself made — and converts whatever it finds to our
// Segment type. Most probes yield cue-level segments; the track-src probe
// (Dzen) also yields word-level segments from inline VTT timestamps.
//
// Probe order, first non-empty result wins:
//   1. Vimeo player config (player.vimeo.com embeds carry
//      window.__vimeo_player_config__ → config_url → request.text_tracks)
//   2. HLS: EXT-X-MEDIA TYPE=SUBTITLES URIs from the master playlist
//      (manifest found via the video src or the resource timeline)
//   3. video > track[src] subtitles (Dzen's signed OK.ru VTT with inline
//      word timestamps, Rutube's pic.rtbcdn.ru SRT)
//   4. WebVTT resource entries any site loaded directly (Coursera et al.)
//   5. edX sjson transcripts (/api/transcripts/…, same-origin only)
//
// The track-src probe (#3) runs before the VTT-entries probe (#4): when a
// page both loads a .vtt and mounts a <track> for it, the word-level parse
// (Dzen) is strictly more informative than the cue-level one, and the
// platform URLs are extensionless anyway (vd*.okcdn.ru/?…, …/*.srt), which
// the .vtt regex never matches.
//
// Every probe is defensive: a failure yields null and the caller falls back
// to the heuristic estimated tier. Twitch and Coursera endpoints could not
// be measured from the probe's datacenter IP (HTTP 429 / enrollment gate) —
// the generic patterns above cover them; a residential-IP re-probe is the
// follow-up (docs/phase0-generic-probe.md).

// The console.debug in safe() is the harvest-failure surface — the user-
// visible fallback is the estimated-tier pill, and this line is the only
// trace of why a probe was skipped.
// aislop-ignore-file console-leftover

import vttjs from 'vtt.js';
import type { Segment } from './captions';

const { WebVTT } = vttjs;

export interface VttHost {
  VTTCue: new (startTime: number, endTime: number, text: string) => unknown;
  document: { createElement(tagName: string): unknown };
}

export interface FetchLike {
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HarvestOptions {
  /** The active video's src attribute; null when the player uses MSE (blob:). */
  videoSrc: string | null;
  /** Subtitle track src attributes on the page (video > track[src]); the
   * content script reads them from the DOM — the harvest itself stays
   * DOM-free. Empty on sites without track elements. */
  trackSrcs: readonly string[];
  /** Resource-timeline URLs observed on the page (performance entries). */
  resourceUrls: readonly string[];
  /** Hostname of the current frame, e.g. 'player.vimeo.com'. */
  hostname: string;
  /** Frame origin for the same-origin transcript rule; null to skip it. */
  pageOrigin: string | null;
  /** Vimeo embed config global; null when absent (non-Vimeo pages). */
  vimeoConfig: { __vimeo_player_config__?: { player?: { config_url?: string } } } | null;
  /** Parser host: window in the content script, a shim in tests. */
  vttHost: VttHost;
  fetchImpl: (url: string) => Promise<FetchLike>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── WebVTT ────────────────────────────────────────────────────────────────

const VTT_TAG = /<[^>]*>/g;

export function cleanVttText(text: string): string {
  return text
    .replace(VTT_TAG, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cue-level segments via vtt.js (Apache-2.0). */
export function parseVtt(text: string, host: VttHost): Segment[] {
  const parser = new WebVTT.Parser(host, new WebVTT.StringDecoder());
  const segments: Segment[] = [];
  parser.oncue = (cue: { startTime: number; endTime: number; text: string }) => {
    const cleaned = cleanVttText(cue.text);
    if (cleaned === '') return;
    segments.push({
      text: cleaned,
      startSec: cue.startTime,
      durSec: cue.endTime - cue.startTime,
    });
  };
  parser.parse(text);
  parser.flush();
  return segments;
}

// ── Word-timed VTT (Dzen) and SRT (Rutube) ────────────────────────────────

/** Inline word-timing runs in Dzen's OK.ru caption track: a timestamp tag
 * immediately followed by a <c> run, e.g. `<00:00:19.225><c>самого</c>`. */
const VTT_WORD_RUN = /<(\d{1,2}:\d{2}:\d{2}[.,]\d{3})><c>([^<]*)<\/c>/g;

function parseVttTimestamp(ts: string): number {
  const parts = ts.split(':');
  const secs = Number(parts.at(-1)!.replace(',', '.'));
  const mins = Number(parts.at(-2) ?? '0');
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  return hours * 3600 + mins * 60 + secs;
}

/** Parses WebVTT text into word-level segments by expanding the inline
 * `<TS><c>word</c>` runs Dzen's caption track carries. Cue text is kept
 * raw (vtt.js preserves the tags) so the runs survive to be expanded.
 * Untimed lead text before a cue's first run (e.g. `С` in the observed
 * shape) attaches to that run's start; untimed gaps between runs are
 * dropped. Text without word-timing runs yields no segments. */
export function parseVttWords(text: string, host: VttHost): Segment[] {
  const parser = new WebVTT.Parser(host, new WebVTT.StringDecoder());
  const words: Segment[] = [];
  parser.oncue = (cue: { startTime: number; endTime: number; text: string }) => {
    const runs = [...cue.text.matchAll(VTT_WORD_RUN)];
    if (runs.length === 0) return;
    const firstStart = parseVttTimestamp(runs[0]![1]!);
    const lead = cleanVttText(cue.text.slice(0, runs[0]!.index));
    if (lead !== '') words.push({ text: lead, startSec: firstStart });
    for (const run of runs) {
      const word = run[2]!.trim();
      if (word === '') continue;
      words.push({ text: word, startSec: parseVttTimestamp(run[1]!) });
    }
  };
  parser.parse(text);
  parser.flush();
  // Tail pattern shared with lib/captions.ts.
  words.sort((a, b) => a.startSec - b.startSec);
  words.forEach((word, i) => {
    const next = words[i + 1];
    if (next !== undefined) word.durSec = next.startSec - word.startSec;
  });
  return words;
}

/** Normalizes an SRT file into WebVTT text vtt.js accepts: comma
 * timestamps → dots, sequence-number lines dropped, `WEBVTT\n\n` header
 * prepended (the blank line is mandatory — without it vtt.js swallows the
 * first cue). The comma replacement is global, so text commas become dots
 * too; harmless — the text feeds only rate math, never display. */
export function normalizeSrt(srt: string): string {
  return (
    'WEBVTT\n\n' +
    srt
      .replace(/,/g, '.')
      .split(/\r?\n/)
      .filter((line) => !/^\d+$/.test(line))
      .join('\n')
      .trim()
  );
}

/** SRT payloads (Rutube's pic.rtbcdn.ru), cue-level. */
export function parseSrt(text: string, host: VttHost): Segment[] {
  return parseVtt(normalizeSrt(text), host);
}

// ── HLS ───────────────────────────────────────────────────────────────────

function attributeValue(line: string, name: string): string | null {
  const match = line.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match === null ? null : match[1] ?? null;
}

/** Subtitle URIs of an HLS master playlist: URI= of EXT-X-MEDIA
 * TYPE=SUBTITLES entries (IMSC1 subtitles included — they carry
 * TYPE=SUBTITLES too, though their TTML bodies fail VTT parsing). */
export function parseHlsSubtitleUris(playlistText: string): string[] {
  const uris: string[] = [];
  for (const line of playlistText.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    // TYPE is an unquoted enum (TYPE=SUBTITLES); URI is always quoted.
    if (!/\bTYPE=SUBTITLES\b/.test(line)) continue;
    const uri = attributeValue(line, 'URI');
    if (uri !== null) uris.push(uri);
  }
  return [...new Set(uris)];
}

// ── edX sjson ─────────────────────────────────────────────────────────────

/** edX transcript JSON: parallel start[] (seconds) and text[] arrays. */
export function parseEdxTranscript(payload: unknown): Segment[] {
  const starts = isRecord(payload) ? payload.start : null;
  const texts = isRecord(payload) ? payload.text : null;
  if (!Array.isArray(starts) || !Array.isArray(texts) || starts.length !== texts.length) {
    return [];
  }
  const segments: Segment[] = [];
  starts.forEach((start, i) => {
    const startSec = typeof start === 'number' && Number.isFinite(start) ? start : null;
    const raw = typeof texts[i] === 'string' ? texts[i] : '';
    if (startSec === null) return;
    const text = cleanVttText(raw);
    if (text === '') return;
    segments.push({ text, startSec });
  });
  segments.forEach((segment, i) => {
    const next = segments[i + 1];
    if (next !== undefined) segment.durSec = next.startSec - segment.startSec;
  });
  return segments;
}

// ── Orchestration ─────────────────────────────────────────────────────────

/** Best-effort probe wrapper: a probe error is logged and skipped, so one
 * broken endpoint cannot sink the remaining probes. */
async function safe<T>(run: () => Promise<T | null>, label: string): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.debug(`[speed-watcher] caption harvest ${label} failed: ${String(error)}`);
    return null;
  }
}

async function fetchVtt(options: HarvestOptions, url: string): Promise<Segment[]> {
  const response = await options.fetchImpl(url);
  if (!response.ok) return [];
  return parseVtt(await response.text(), options.vttHost);
}

async function probeVimeoConfig(options: HarvestOptions): Promise<Segment[] | null> {
  if (options.hostname !== 'vimeo.com' && !options.hostname.endsWith('.vimeo.com')) return null;
  const configUrl = options.vimeoConfig?.__vimeo_player_config__?.player?.config_url;
  if (configUrl === undefined) return null;
  const response = await options.fetchImpl(configUrl);
  if (!response.ok) return null;
  const payload = await response.json();
  const tracks = isRecord(payload)
    ? isRecord(payload.request) && Array.isArray(payload.request.text_tracks)
      ? payload.request.text_tracks.filter(isRecord).map((t) => t.url).filter((u): u is string => typeof u === 'string')
      : []
    : [];
  for (const url of tracks) {
    const segments = await fetchVtt(options, url);
    if (segments.length > 0) return segments;
  }
  return null;
}

function m3u8Candidates(options: HarvestOptions): string[] {
  const candidates = [options.videoSrc, ...options.resourceUrls].filter(
    (url): url is string => url !== null && /\.m3u8(\?|$)/.test(url),
  );
  return [...new Set(candidates)];
}

async function probeHls(options: HarvestOptions): Promise<Segment[] | null> {
  for (const m3u8Url of m3u8Candidates(options)) {
    const response = await options.fetchImpl(m3u8Url);
    if (!response.ok) continue;
    const playlist = await response.text();
    for (const uri of parseHlsSubtitleUris(playlist)) {
      const subtitleUrl = new URL(uri, m3u8Url).href;
      const segments = await fetchVtt(options, subtitleUrl);
      if (segments.length > 0) return segments;
    }
  }
  return null;
}

async function probeVttEntries(options: HarvestOptions): Promise<Segment[] | null> {
  for (const url of options.resourceUrls) {
    if (!/\.vtt(\?|$)/.test(url)) continue;
    const segments = await fetchVtt(options, url);
    if (segments.length > 0) return segments;
  }
  return null;
}

/** Track-src probe (probe #5 in the adapter spec; third in execution
 * order): reads the src attributes the content script collected (no
 * document access here), fetches each, and returns the first payload that
 * yields words or cues: Dzen's OK.ru VTT gives both (word runs + cues from
 * one fetch), Rutube's SRT cues only. A track with no caption content
 * falls through to the next src; an empty track list yields null (→
 * estimated tier; Rutube's author-gated ~50% of videos have no track
 * element at all). */
async function probeTrackSrcs(options: HarvestOptions): Promise<CaptionHarvest | null> {
  for (const src of options.trackSrcs) {
    const response = await options.fetchImpl(src);
    if (!response.ok) continue;
    const text = await response.text();
    const words = parseVttWords(text, options.vttHost);
    let cues = parseVtt(text, options.vttHost);
    if (cues.length === 0) cues = parseSrt(text, options.vttHost);
    if (words.length === 0 && cues.length === 0) continue;
    return { words, cues };
  }
  return null;
}

async function probeEdxTranscripts(options: HarvestOptions): Promise<Segment[] | null> {
  for (const url of options.resourceUrls) {
    if (!/\/api\/transcripts\//.test(url)) continue;
    if (options.pageOrigin !== null && new URL(url).origin !== options.pageOrigin) continue;
    const response = await options.fetchImpl(url);
    if (!response.ok) continue;
    const segments = parseEdxTranscript(await response.json());
    if (segments.length > 0) return segments;
  }
  return null;
}

/** What a successful harvest found: word-level segments when the payload
 * carried inline word timings (Dzen), cue-level segments always (Dzen's
 * VTT and every other source). A probe can yield both from one fetch. */
export interface CaptionHarvest {
  /** Per-word segments from inline VTT word-timing runs; empty when the
   * payload has none (SRT, plain VTT, transcripts). */
  words: Segment[];
  /** Cue-level segments from the same payload. */
  cues: Segment[];
}

/** First non-empty probe harvest; null → estimated tier. */
export async function harvestCaptions(options: HarvestOptions): Promise<CaptionHarvest | null> {
  const segments =
    (await safe(() => probeVimeoConfig(options), 'vimeo config')) ??
    (await safe(() => probeHls(options), 'hls')) ??
    (await safe(() => probeTrackSrcs(options), 'track srcs')) ??
    (await safe(() => probeVttEntries(options), 'vtt entries')) ??
    (await safe(() => probeEdxTranscripts(options), 'edx transcript'));
  if (segments === null) return null;
  // Cue-level probes return Segment[]; probe #5 returns a full harvest.
  return Array.isArray(segments) ? { words: [], cues: segments } : segments;
}
