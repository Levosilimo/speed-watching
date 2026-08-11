import type { CaptionCue, WordToken } from './captions';

export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

export function totalWords(items: readonly (WordToken | CaptionCue)[]): number {
  return items.reduce((sum, item) => sum + countWords(item.text), 0);
}

/**
 * Words per minute over the span from the first to the last word start.
 * The final word's duration is not counted, so the rate runs slightly high
 * (safe direction: recommends a lower multiplier); the error is one word
 * per speech span, under 5% for clips longer than ~10 s.
 */
export function wordLevelWpm(words: WordToken[]): number | null {
  const first = words[0]?.startSec;
  const last = words.at(-1)?.startSec;
  if (first === undefined || last === undefined || last <= first) return null;
  return (totalWords(words) / (last - first)) * 60;
}

/** Wall-clock span from the first cue start to the last cue end, in seconds. */
export function cueSpanSec(cues: CaptionCue[]): number | null {
  const first = cues[0];
  const last = cues.at(-1);
  if (!first || !last) return null;
  const span = last.startSec + last.durSec - first.startSec;
  return span > 0 ? span : null;
}

/**
 * Words per minute over the full cue span, inter-cue gaps included.
 * Auto-generated cue boundaries usually fall at pauses, so this
 * underestimates the true speech rate — the dangerous direction.
 */
export function cueLevelWpm(cues: CaptionCue[]): number | null {
  const span = cueSpanSec(cues);
  if (span === null) return null;
  return (totalWords(cues) / span) * 60;
}

/**
 * Speech-duration estimate from cue timing: sum of cue durations, capped at
 * the cue span. Assumes inter-cue gaps are pure silence and treats pauses
 * inside a cue as speech, since cue-level data cannot localize them.
 * Leading/trailing silence inside the first/last cue stays uncorrected.
 */
export function estimateSpeechDurationSec(cues: CaptionCue[]): number | null {
  const span = cueSpanSec(cues);
  if (span === null) return null;
  return Math.min(
    cues.reduce((sum, cue) => sum + cue.durSec, 0),
    span,
  );
}

/** Words per minute over the silence-corrected speech-duration estimate. */
export function correctedCueLevelWpm(cues: CaptionCue[]): number | null {
  const speech = estimateSpeechDurationSec(cues);
  if (speech === null || speech <= 0) return null;
  return (totalWords(cues) / speech) * 60;
}
