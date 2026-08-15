// Cue-level transcript fallback for the ANDROID innertube chain: the
// /youtubei/v1/get_transcript innertube POST, the endpoint the player's own
// transcript panel uses. The POT gate (mid-2026) 200-empties bare timedtext
// fetches, and the ANDROID player response carries the transcript-panel
// getTranscriptEndpoint params — same ToS gray area as the ANDROID client
// designation (lib/caption-fetch.ts): it only reads captions, never touches
// playback or DRM surfaces. CUE-LEVEL only: the response has no word
// timings, so a transcript result feeds the cue tier, not the word tier.

import type { Segment } from './captions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function dig(value: unknown, ...keys: string[]): unknown {
  let cur = value;
  for (const key of keys) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The getTranscriptEndpoint params in a player response: the transcript
 * search panel's footer "show transcript" button command. Null when the
 * response carries no transcript panel — the caller bails to the next
 * fallback. */
export function getTranscriptParams(response: unknown): string | null {
  const panels = isRecord(response) ? response.engagementPanels : undefined;
  if (!Array.isArray(panels)) return null;
  for (const panel of panels) {
    if (!isRecord(panel)) continue;
    const params = dig(
      panel,
      'engagementPanelSectionListRenderer',
      'content',
      'transcriptRenderer',
      'content',
      'transcriptSearchPanelRenderer',
      'footer',
      'transcriptFooterRenderer',
      'primaryButton',
      'buttonRenderer',
      'command',
      'getTranscriptEndpoint',
      'params',
    );
    if (typeof params === 'string' && params !== '') return params;
  }
  return null;
}

function segmentText(snippet: unknown): string | null {
  if (!isRecord(snippet)) return null;
  if (typeof snippet.simpleText === 'string') return snippet.simpleText;
  const runs = snippet.runs;
  if (!Array.isArray(runs)) return null;
  const text = runs
    .map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : null))
    .filter((t): t is string => t !== null)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

/** Cue-level segments from a get_transcript response: the transcript panel
 * update's initialSegments (startMs — string in real payloads — plus the
 * snippet text). Durations are not carried: transcript segments know no
 * word timings, and the cue tier measures over inter-start spans. */
export function parseTranscriptSegments(input: unknown): Segment[] {
  const segments: Segment[] = [];
  const actions = isRecord(input) ? input.actions : undefined;
  if (!Array.isArray(actions)) return segments;
  for (const action of actions) {
    const initialSegments = dig(
      action,
      'updateEngagementPanelAction',
      'content',
      'transcriptRenderer',
      'content',
      'transcriptSearchPanelRenderer',
      'body',
      'transcriptSegmentListRenderer',
      'initialSegments',
    );
    if (!Array.isArray(initialSegments)) continue;
    for (const entry of initialSegments) {
      if (!isRecord(entry)) continue;
      const renderer = isRecord(entry.transcriptSegmentRenderer)
        ? entry.transcriptSegmentRenderer
        : null;
      if (renderer === null) continue;
      const startMs = Number(renderer.startMs);
      const text = segmentText(renderer.snippet);
      if (!Number.isFinite(startMs) || text === null) continue;
      segments.push({ text, startSec: startMs / 1000 });
    }
  }
  segments.sort((a, b) => a.startSec - b.startSec);
  return segments;
}

declare global {
  interface Window {
    /** YouTube's page config object; the innertube identity for API calls
     * (get('INNERTUBE_API_KEY') / get('INNERTUBE_CONTEXT')). */
    ytcfg?: { get(name: string): unknown };
  }
}

/** POSTs the innertube get_transcript endpoint with the panel params and
 * converts the segments to the json3 windows shape the cue tier parses
 * (lib/captions.ts pushWindowCues: { windows: [{ startMs, text }] }) — the
 * same payload contract fetchCaptions returns. Null when ytcfg carries no
 * innertube identity, the request fails, or the response parses to no
 * segments. */
export async function fetchTranscriptViaEndpoint(params: string): Promise<unknown | null> {
  const cfg = window.ytcfg;
  if (cfg === undefined || typeof cfg.get !== 'function') return null;
  const apiKey = cfg.get('INNERTUBE_API_KEY');
  const context = cfg.get('INNERTUBE_CONTEXT');
  if (typeof apiKey !== 'string' || apiKey === '' || !isRecord(context)) return null;
  try {
    const url = new URL('/youtubei/v1/get_transcript', location.origin);
    url.searchParams.set('key', apiKey);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, params }),
    });
    if (!response.ok) return null;
    const segments = parseTranscriptSegments(await response.json());
    if (segments.length === 0) return null;
    return {
      windows: segments.map((segment) => ({
        startMs: Math.round(segment.startSec * 1000),
        text: segment.text,
      })),
    };
  } catch {
    return null;
  }
}
