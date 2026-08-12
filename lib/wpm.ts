import type { Segment } from './captions';
import type { LanguageModel } from './languages';
import type { RateTier } from './recommend';
import { countHangulSyllables, countWordTokens, isBracketMarker } from './tokenizer';

export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

export function totalWords(items: readonly Segment[]): number {
  return items.reduce((sum, item) => sum + countWords(item.text), 0);
}

/**
 * Words per minute over the span from the first to the last word start.
 * The final word's duration is not counted, so the rate runs slightly high
 * (safe direction: recommends a lower multiplier); the error is one word
 * per speech span, under 5% for clips longer than ~10 s.
 */
export function wordLevelWpm(words: Segment[]): number | null {
  const first = words[0]?.startSec;
  const last = words.at(-1)?.startSec;
  if (first === undefined || last === undefined || last <= first) return null;
  return (totalWords(words) / (last - first)) * 60;
}

/** Wall-clock span from the first cue start to the last cue end, in seconds. */
export function cueSpanSec(cues: Segment[]): number | null {
  const first = cues[0];
  const last = cues.at(-1);
  if (!first || !last) return null;
  const span = last.startSec + (last.durSec ?? 0) - first.startSec;
  return span > 0 ? span : null;
}

/**
 * Words per minute over the full cue span, inter-cue gaps included.
 * Auto-generated cue boundaries usually fall at pauses, so this
 * underestimates the true speech rate — the dangerous direction.
 */
export function cueLevelWpm(cues: Segment[]): number | null {
  const span = cueSpanSec(cues);
  if (span === null) return null;
  return (totalWords(cues) / span) * 60;
}

/**
 * Speech-duration estimate from cue timing: sum of cue durations, capped at
 * the cue span. Assumes inter-cue gaps are pure silence and treats pauses
 * inside a cue as speech, since cue-level data cannot localize them.
 * Cues without a duration contribute zero, which runs the rate high (safe).
 */
export function estimateSpeechDurationSec(cues: Segment[]): number | null {
  const span = cueSpanSec(cues);
  if (span === null) return null;
  return Math.min(
    cues.reduce((sum, cue) => sum + (cue.durSec ?? 0), 0),
    span,
  );
}

/** Words per minute over the silence-corrected speech-duration estimate. */
export function correctedCueLevelWpm(cues: Segment[]): number | null {
  const speech = estimateSpeechDurationSec(cues);
  if (speech === null || speech <= 0) return null;
  return (totalWords(cues) / speech) * 60;
}

function spokenCues(cues: readonly Segment[]): Segment[] {
  return cues.filter((cue) => !isBracketMarker(cue.text));
}

/** Token count in the language's rate unit: word runs, graphemes (chars),
 * or word runs converted to syllables (factor or Hangul blocks). */
function unitTokens(text: string, language: LanguageModel | undefined): number {
  const n = countWordTokens(text, language?.tokenizerMode);
  if (language?.hangulBlocks === true) return countHangulSyllables(text);
  if (language?.syllablesPerWord !== undefined) return n * language.syllablesPerWord;
  return n;
}

/**
 * Unified ASR presentation-rate rule: tokens of non-bracket cues over the
 * span from the first to the last such cue's start — words, characters, or
 * syllables per minute per the language model (default: words). The
 * span keeps its pauses, so this is the presentation rate the safe-zone
 * literature measures; TARGET_WPM and SAFE_ZONE_CEILING_WPM are defined
 * on it. Two measured biases bracket it: naive word-level rates
 * undercount tokens by ~16% (untimed segs), while the pause-excluded
 * articulatory rate runs ~45% higher on the re-run corpus — median
 * pause:speech 44.8% (≈31% pause share of span, range ~9–50%, 11/17
 * speech videos above 25%; lower bounds, since sub-second micro-pauses
 * stay inside the inter-start spans). speechDurationSec() and
 * articulatoryWpm() expose the pause-excluded rate for the
 * pause-diluted warning.
 */
export function filteredTokensOverTrimmedSpan(
  cues: readonly Segment[],
  language?: LanguageModel,
): number | null {
  const spoken = spokenCues(cues);
  const first = spoken[0]?.startSec;
  const last = spoken.at(-1)?.startSec;
  if (first === undefined || last === undefined || last <= first) return null;
  const tokens = spoken.reduce((sum, cue) => sum + unitTokens(cue.text, language), 0);
  return (tokens / (last - first)) * 60;
}

/**
 * Speech duration from per-word inter-start spans: the sum of
 * (start[i+1] − start[i]) over consecutive timed words, excluding gaps
 * ≥ 1 s (cue-boundary pauses) and non-positive deltas (out-of-order
 * timings). Null for fewer than two timed words — sparse word timing
 * cannot localize pauses. Production home of the harness's speechDurSec
 * (scripts/sample-analysis.ts).
 */
export function speechDurationSec(words: readonly Segment[]): number | null {
  if (words.length < 2) return null;
  let dur = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const cur = words[i]!;
    const next = words[i + 1]!;
    const gap = next.startSec - cur.startSec;
    if (gap >= 1 || gap <= 0) continue;
    dur += gap;
  }
  return dur > 0 ? dur : null;
}

/**
 * Articulatory rate: filtered letter/digit tokens over the pause-excluded
 * speech duration — the rate the speaker actually produces, without the
 * pause dilution the presentation-rate rule still carries.
 */
export function articulatoryWpm(tokens: number, speechDuration: number): number {
  return (tokens / speechDuration) * 60;
}

/**
 * Word-timing coverage floor for the articulatory warning: below half the
 * cue words timed, the speech-duration estimate is too unreliable to warn
 * on. Phase-0 coverage sits at 67.9–87.4% (mean 83.6%), so real payloads
 * clear it; the warning is report-only, so missing it is the safe failure.
 */
export const MIN_WORD_TIMING_COVERAGE = 0.5;

/**
 * asr-word tier inputs: the pause-excluded articulatory rate over the timed
 * words plus the word-timing coverage sanity. Null when fewer than two timed
 * words or no measurable speech duration (speechDurationSec contract) —
 * sparse word timing cannot localize pauses. Shared by the content script
 * and the e2e specs so both feed recommend() the same numbers.
 */
export function wordTierInputs(
  words: readonly Segment[],
  cues: readonly Segment[],
  language?: LanguageModel,
): { articulatoryWpm: number; timingCoverageOk: boolean } | null {
  const speechDur = speechDurationSec(words);
  if (speechDur === null) return null;
  const tokens = cues.reduce(
    (sum, cue) => (isBracketMarker(cue.text) ? sum : sum + unitTokens(cue.text, language)),
    0,
  );
  const coverage = totalWords(cues) === 0 ? 0 : totalWords(words) / totalWords(cues);
  return {
    articulatoryWpm: articulatoryWpm(tokens, speechDur),
    timingCoverageOk: coverage >= MIN_WORD_TIMING_COVERAGE,
  };
}

/**
 * Tier + articulatory inputs for a caption track: word-timed ASR tracks
 * (≥2 timed words) render asr-word with the pause-diluted inputs, other
 * ASR tracks asr-cue, manual tracks manual-cue. Shared by the content
 * script and the e2e specs so the tier choice cannot drift.
 */
export function asrTierInputs(
  kind: string | undefined,
  words: readonly Segment[],
  cues: readonly Segment[],
): {
  tier: RateTier;
  wordInputs: { articulatoryWpm: number; timingCoverageOk: boolean } | null;
} {
  if (kind !== 'asr') return { tier: 'manual-cue', wordInputs: null };
  if (words.length < 2) return { tier: 'asr-cue', wordInputs: null };
  return { tier: 'asr-word', wordInputs: wordTierInputs(words, cues) };
}

/**
 * Manual-cue rate: filtered tokens over the silence-corrected speech
 * duration, in the language's unit. The ≤1.5x clamp for this tier lives
 * in recommend().
 */
export function manualCueRate(cues: readonly Segment[], language?: LanguageModel): number | null {
  const spoken = spokenCues(cues);
  const speech = estimateSpeechDurationSec(spoken);
  if (speech === null || speech <= 0) return null;
  const tokens = spoken.reduce((sum, cue) => sum + unitTokens(cue.text, language), 0);
  return (tokens / speech) * 60;
}
