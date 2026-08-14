import type { Segment } from './captions';
import type { RateUnit } from './languages';
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

const CONTENT_TYPES: readonly ContentType[] = [
  'lecture',
  'talk',
  'explainer',
  'news',
  'podcast',
  'music',
  'generic',
  'unknown',
];

/** Runtime membership check for the ContentType union (bridge boundary). */
export function isContentType(value: unknown): value is ContentType {
  return typeof value === 'string' && (CONTENT_TYPES as readonly string[]).includes(value);
}

/** Fraction of cues that are bracket markers; 0 for an empty cue list. */
export function markerRatio(cues: readonly Segment[]): number {
  if (cues.length === 0) return 0;
  return cues.filter((cue) => isBracketMarker(cue.text)).length / cues.length;
}

export function containsNotes(cues: readonly Segment[]): boolean {
  return cues.some((cue) => hasNoteSymbol(cue.text));
}

/**
 * Rate below this cap is lyric-like, not speech, in the language's unit.
 * The cap is unit-aware because the natural rate arrives in the language's
 * unit: the old flat 90 wpm floor only ever tripped on wpm-unit tracks —
 * the th lyric controls (158.0/219.1 cpm) and the ja lyric controls
 * (89.3/115.3 morae/min) never cleared it. Tuned against the measured
 * bands, each cap sits in the empty gap between that language class's
 * lyric band and its slowest speech: wpm speech runs 103–206 wpm, ja
 * speech 291+ morae/min, ko 247+ syl/min, th 401+ cpm. zh speech
 * (125–182 cpm) rides under the cpm cap, so the markers-alone guard is
 * the zh false-positive guard.
 */
export const MUSIC_RATE_CAP_BY_UNIT: Record<RateUnit, number> = {
  wpm: 90,
  mora: 150,
  syl: 90,
  cpm: 250,
};
/** wpm-unit entry of MUSIC_RATE_CAP_BY_UNIT; the default when no unit. */
export const MUSIC_RATE_CAP_WPM = MUSIC_RATE_CAP_BY_UNIT.wpm;
/** Marker share below this is an intro/outro flourish, not a lyric track. */
export const MUSIC_MARKER_RATIO_MIN = 0.05;

/**
 * Music detection: sub-cap rate AND (bracket markers OR note symbols), the
 * rate measured in the language's unit. The rate floor is the
 * never-markers-alone guard — measured spoken content runs above the cap
 * in every unit while the corpus's lyric controls run below it (see
 * MUSIC_RATE_CAP_BY_UNIT), so a marker-heavy or ♪-carrying track under
 * the cap is lyric-like even without the other signal; markers alone at
 * speech rate stay safe (TED [Music] intros). Measured lyric tracks carry
 * ♪ with zero bracket markers, so either signal suffices.
 */
export function detectMusic(
  cues: readonly Segment[],
  naturalRate: number,
  unit: RateUnit = 'wpm',
): boolean {
  return (
    naturalRate < MUSIC_RATE_CAP_BY_UNIT[unit] &&
    (markerRatio(cues) >= MUSIC_MARKER_RATIO_MIN || containsNotes(cues))
  );
}
