// Letter/digit token counting. YouTube ASR injects bracket markers
// ([Music], [Applause]) and note symbols (♪) into transcripts; whitespace
// splitting counts those as words and inflates every rate.

export type TokenizerMode = 'words' | 'words-marks' | 'chars';

const WORD_RUN_RE = /[\p{L}\p{N}]+/gu;
/** \p{M} keeps combining marks (Devanagari matras/viramas) inside the run —
 * the plain run fragments Hindi words into ~1.5x too many tokens. */
const WORD_RUN_MARKS_RE = /[\p{L}\p{M}\p{N}]+/gu;
const HANGUL_BLOCK_RE = /[\uAC00-\uD7A3]/gu;

/** Whitespace, punctuation, or symbol graphemes — never speech. */
const NON_SPEECH_GRAPHENE_RE = /^[\s\p{P}\p{S}]$/u;

let graphemeSegmenter: Intl.Segmenter | undefined;
function segmenter(): Intl.Segmenter | undefined {
  if (graphemeSegmenter === undefined && typeof Intl !== 'undefined' && Intl.Segmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  }
  return graphemeSegmenter;
}

/**
 * Grapheme count minus whitespace/punctuation/symbols — the char-unit
 * (cpm) token count. Grapheme segmentation keeps combining marks (Thai tone
 * marks, Devanagari matras) in their base character instead of counting
 * them as separate tokens.
 */
function countChars(text: string): number {
  const seg = segmenter();
  let count = 0;
  if (seg !== undefined) {
    for (const { segment } of seg.segment(text)) {
      if (!NON_SPEECH_GRAPHENE_RE.test(segment)) count++;
    }
    return count;
  }
  // No Intl.Segmenter: code-point fallback, combining marks counted apart.
  return [...text].filter((cp) => !NON_SPEECH_GRAPHENE_RE.test(cp)).length;
}

/** Maximal runs of letters and digits; every other character splits tokens.
 * 'words-marks' keeps combining marks in the run; 'chars' counts graphemes
 * instead of runs (the tokens are characters). */
export function countWordTokens(text: string, mode: TokenizerMode = 'words'): number {
  if (mode === 'chars') return countChars(text);
  const re = mode === 'words-marks' ? WORD_RUN_MARKS_RE : WORD_RUN_RE;
  return text.match(re)?.length ?? 0;
}

/** Hangul syllable blocks (U+AC00–U+D7A3): each block is exactly one
 * syllable, so Korean word tokens convert without a factor. */
export function countHangulSyllables(text: string): number {
  return text.match(HANGUL_BLOCK_RE)?.length ?? 0;
}

/** True when the text is only bracket markers like [Music], whitespace tolerated. */
export function isBracketMarker(text: string): boolean {
  return /^\s*(?:\[[^\]]*\]\s*)+$/.test(text);
}

export function hasNoteSymbol(text: string): boolean {
  return /[♪♫]/.test(text);
}
