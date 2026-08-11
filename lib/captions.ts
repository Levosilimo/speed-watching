// Parser for YouTube caption payloads served at captionTracks baseUrl
// (fmt=json3). Handles both layouts found in the wild: per-word timings in
// the `windows` array or as per-seg tOffsetMs inside `events`, and cue-level
// timing from `events` (tStartMs + dDurationMs).

export interface WordToken {
  /** Segment text; may hold several whitespace-separated tokens. */
  text: string;
  startSec: number;
  /** Gap to the next word start; absent for the final word (end unknown). */
  durSec?: number;
}

export interface CaptionCue {
  text: string;
  startSec: number;
  durSec: number;
}

export interface ParsedCaptions {
  /** Empty when the payload carries no per-word timings. */
  words: WordToken[];
  /** Empty when the payload carries no cue events. */
  cues: CaptionCue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pushTimedSeg(tokens: WordToken[], seg: unknown, baseMs: number): void {
  if (!isRecord(seg)) return;
  const text = asString(seg.utf8);
  const offset = asNumber(seg.tOffsetMs);
  if (text === null || offset === null || text.trim() === '') return;
  tokens.push({ text, startSec: (baseMs + offset) / 1000 });
}

function wordTokens(payload: Record<string, unknown>): WordToken[] {
  const tokens: WordToken[] = [];
  for (const window of asArray(payload.windows)) {
    if (!isRecord(window)) continue;
    const base =
      (asNumber(window.wpWinStartMs) ?? 0) + (asNumber(window.wWinOffsetMs) ?? 0);
    for (const seg of asArray(window.segs)) {
      pushTimedSeg(tokens, seg, base);
    }
  }
  for (const event of asArray(payload.events)) {
    if (!isRecord(event)) continue;
    const start = asNumber(event.tStartMs);
    if (start === null) continue;
    for (const seg of asArray(event.segs)) {
      pushTimedSeg(tokens, seg, start);
    }
  }
  tokens.sort((a, b) => a.startSec - b.startSec);
  tokens.forEach((token, i) => {
    const next = tokens[i + 1];
    if (next !== undefined) token.durSec = next.startSec - token.startSec;
  });
  return tokens;
}

function captionCues(payload: Record<string, unknown>): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const event of asArray(payload.events)) {
    if (!isRecord(event)) continue;
    const startMs = asNumber(event.tStartMs);
    const durMs = asNumber(event.dDurationMs);
    if (startMs === null || durMs === null) continue;
    const text = asArray(event.segs)
      .map((seg) => (isRecord(seg) ? asString(seg.utf8) : null))
      .filter((t): t is string => t !== null)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === '') continue;
    cues.push({ text, startSec: startMs / 1000, durSec: durMs / 1000 });
  }
  return cues;
}

export function parseYouTubeJson3(input: unknown): ParsedCaptions {
  if (!isRecord(input)) return { words: [], cues: [] };
  return { words: wordTokens(input), cues: captionCues(input) };
}
