import type { Segment } from './captions';
import { hasNoteSymbol, isBracketMarker } from './tokenizer';

export type ContentType =
  | 'lecture'
  | 'talk'
  | 'explainer'
  | 'news'
  | 'podcast'
  | 'music'
  | 'generic'
  | 'unknown';

/** Fraction of cues that are bracket markers; 0 for an empty cue list. */
export function markerRatio(cues: readonly Segment[]): number {
  if (cues.length === 0) return 0;
  return cues.filter((cue) => isBracketMarker(cue.text)).length / cues.length;
}

export function containsNotes(cues: readonly Segment[]): boolean {
  return cues.some((cue) => hasNoteSymbol(cue.text));
}

/** Rate below this cap is lyric-like, not speech. */
export const MUSIC_RATE_CAP_WPM = 90;
/** Marker share below this is an intro/outro flourish, not a lyric track. */
export const MUSIC_MARKER_RATIO_MIN = 0.05;

/**
 * Music detection needs all three signals. Markers alone are common in
 * talks (TED [Music] intros) and must never suppress the recommendation.
 */
export function detectMusic(cues: readonly Segment[], naturalRateWpm: number): boolean {
  return (
    naturalRateWpm < MUSIC_RATE_CAP_WPM &&
    containsNotes(cues) &&
    markerRatio(cues) >= MUSIC_MARKER_RATIO_MIN
  );
}
