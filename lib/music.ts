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
 * Music detection: sub-90 wpm AND (bracket markers OR note symbols). The
 * rate floor is the never-markers-alone guard — measured spoken content
 * runs 103–206 wpm, so a marker-heavy track below 90 wpm is lyric-like
 * even without ♪ notes (measured lyric tracks carry ♪ with zero bracket
 * markers). Markers alone at speech rate stay safe (TED [Music] intros).
 */
export function detectMusic(cues: readonly Segment[], naturalRateWpm: number): boolean {
  return (
    naturalRateWpm < MUSIC_RATE_CAP_WPM &&
    (markerRatio(cues) >= MUSIC_MARKER_RATIO_MIN || containsNotes(cues))
  );
}
