// Letter/digit token counting. YouTube ASR injects bracket markers
// ([Music], [Applause]) and note symbols (♪) into transcripts; whitespace
// splitting counts those as words and inflates every rate.

export type TokenizerMode = 'words' | 'words-marks' | 'chars' | 'mora' | 'vowels';
// 'vowels' is script-specific (tr vs hi) and resolves in unitTokens
// (lib/wpm.ts), not in countWordTokens.

const WORD_RUN_RE = /[\p{L}\p{N}]+/gu;
/** \p{M} keeps combining marks (Devanagari matras/viramas) inside the run —
 * the plain run fragments Hindi words into ~1.5x too many tokens. */
const WORD_RUN_MARKS_RE = /[\p{L}\p{M}\p{N}]+/gu;
const HANGUL_BLOCK_RE = /[\uAC00-\uD7A3]/gu;
/** Hiragana + katakana: every kana code point is one mora, including the
 * long-vowel mark ー (U+30FC) and the sokuon っ (U+3063). */
const KANA_MORA_RE = /[\u3040-\u309F\u30A0-\u30FF]/gu;
/** CJK unified ideographs (U+4E00–9FFF). */
const KANJI_MORA_RE = /[\u4E00-\u9FFF]/gu;
/** On-yomi-dominant average morae per kanji (research band 1.8–2.0). */
export const KANJI_MORAE_PER_CHAR = 1.85;
/** Turkish vowel letters, both cases (incl. dotted capital İ U+0130) —
 * Turkish syllables are one vowel letter each. */
const TURKISH_VOWEL_RE = /[aeıioöuüAEIİOÖUÜ]/g;
/** Devanagari standalone vowel letters अ–औ (U+0905–0914). */
const DEVANAGARI_VOWEL_RE = /[\u0905-\u0914]/;
/** Devanagari consonants क–ह (U+0915–0939) plus the precomposed nukta
 * forms क़–य़ (U+0958–095F). */
const DEVANAGARI_CONSONANT_RE = /[\u0915-\u0939\u0958-\u095F]/;
/** Devanagari letters and combining marks: a consonant before one of these
 * is word-medial; before anything else (space, punctuation, end) it is
 * word-final, where Hindi deletes the inherent schwa. */
const DEVANAGARI_CONTINUATION_RE = /[\u0900-\u095F\u0970-\u097F]/;
const DEVANAGARI_HALANT = '\u094D';

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
 * and 'mora' Japanese morae instead of runs (the tokens are characters). */
export function countWordTokens(text: string, mode: TokenizerMode = 'words'): number {
  if (mode === 'chars') return countChars(text);
  if (mode === 'mora') return countMorae(text);
  const re = mode === 'words-marks' ? WORD_RUN_MARKS_RE : WORD_RUN_RE;
  return text.match(re)?.length ?? 0;
}

/**
 * Japanese mora estimate: each kana code point is one mora (incl. ー and
 * っ), each kanji counts 1.85 morae (on-yomi-dominant average), everything
 * else — punctuation, whitespace, symbols, Latin, digits — is skipped.
 * Lands within ±5–8% of a true analyzer, inside the ±10% band the
 * chars-mode misses: kanji carry ~1.8–2.0 morae per character, so grapheme
 * counts understate morae ~25–35% on kanji-heavy text.
 */
export function countMorae(text: string): number {
  const kana = text.match(KANA_MORA_RE)?.length ?? 0;
  const kanji = text.match(KANJI_MORA_RE)?.length ?? 0;
  return kana + kanji * KANJI_MORAE_PER_CHAR;
}

/** Turkish vowel-nucleus count: one vowel letter per syllable. */
export function countTurkishVowels(text: string): number {
  return text.match(TURKISH_VOWEL_RE)?.length ?? 0;
}

/**
 * Hindi/Devanagari vowel-nucleus count: standalone vowel letters plus every
 * consonant that carries a vowel — its inherent schwa, or a matra, which
 * replaces it (matras themselves are not counted). A halant (्) removes the
 * preceding consonant's vowel, and a word-final consonant loses its schwa
 * (Hindi's regular final-schwa deletion). The residual deviation —
 * epenthetic schwas inside halant clusters (नमस्ते counts 2, spoken 3) —
 * stays within the ±10% band.
 */
export function countDevanagariSyllables(text: string): number {
  const cps = [...text];
  let count = 0;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    const next = cps[i + 1];
    if (DEVANAGARI_VOWEL_RE.test(cp)) {
      count++;
    } else if (
      DEVANAGARI_CONSONANT_RE.test(cp) &&
      next !== DEVANAGARI_HALANT &&
      next !== undefined &&
      DEVANAGARI_CONTINUATION_RE.test(next)
    ) {
      count++;
    }
  }
  return count;
}

/** Vowel-nucleus count for the 'vowels' mode: Turkish vowel letters or
 * Devanagari nuclei. Only tr and hi set the mode. */
export function countVowelNuclei(text: string, code: string): number {
  return code === 'hi' ? countDevanagariSyllables(text) : countTurkishVowels(text);
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
