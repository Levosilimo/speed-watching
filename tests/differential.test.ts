// Wave 3 batch B — the randomized tokenizer differential. Each mode is
// compared against its independent reference, authored from the G3 gate's
// conventions (scripts/measure-count-gate.ts): words → Intl.Segmenter
// word-like segments, chars → the code-point-minus-combining-mark
// unit-sanity oracle, mora/vowels → per-mode determinism (no ICU segmenter
// for their units), all inside the ±10% band. The references are the
// corpus oracles, never lib/ internals — the property must be able to
// fail if the tokenizer drifts (the fail-mode proofs live in the PR body).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countMorae, countVowelNuclei, countWordTokens } from '../lib/tokenizer';
import { combiningMarkTokens, codePointTokens } from '../scripts/measure-count-gate';

const SEED = 4242;

/** ICU word-like segment count — the words-mode reference (the G3
 * regex-icu comparison). The reference locale is fixed: the words-safe
 * scripts below segment identically across locales (no dictionary data). */
function icuWordLike(text: string): number {
  let count = 0;
  for (const part of new Intl.Segmenter('en', { granularity: 'word' }).segment(text)) {
    if (part.isWordLike) count++;
  }
  return count;
}

// The words-safe alphabet: the glyphs where a maximal letter/digit run IS
// an ICU word segment. Kept out: CJK ideographs (ICU dictionary-splits
// them), Devanagari (ICU merges halant clusters), combining marks (ICU
// attaches them mid-run — áb is one segment, two runs), the MidLetter/
// MidNumLet glyphs ' . : (ICU keeps don't, e.g., and two:three as one
// segment) and digit-comma-digit (ICU groups 1,000). The G3 regex-icu
// comparison runs over the same class of text: the joined spoken corpus
// of the words-mode languages.
const WORDS_SAFE_WORDS = [
  'hello', 'world', 'the', 'quick', 'brown', 'fox', 'jumps', 'lazy', 'dog',
  'percent', 'people', 'agree', 'Привет', 'мир', 'olá', 'café', 'merhaba',
  'dünya', 'مرحبا', 'بالعالم', '안녕하세요', '세상', 'κόσμος', 'καλημέρα',
  '42', '2026', 'word42', 'äöüß',
];
const WORDS_SAFE_SEPARATORS = [
  ' ', '\n', '\t', ';', '!', '?', '(', ')', '[', ']', '{', '}', '-', '—', '…', '"', '*', '♪', '$',
];

const wordsSafeTextArb: fc.Arbitrary<string> = fc
  .array(
    fc.record({
      word: fc.constantFrom(...WORDS_SAFE_WORDS),
      sep: fc.constantFrom(...WORDS_SAFE_SEPARATORS),
    }),
    { minLength: 0, maxLength: 30 },
  )
  .map((pairs) => pairs.map((pair) => pair.word + pair.sep).join(''));

describe('words-mode differential vs Intl.Segmenter', () => {
  it('keeps the run count inside the ±10% band of the ICU word-like count', () => {
    fc.assert(
      fc.property(wordsSafeTextArb, (text) => {
        const regex = countWordTokens(text);
        const icu = icuWordLike(text);
        expect(Math.abs(regex - icu) / Math.max(icu, 1)).toBeLessThanOrEqual(0.1);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// The chars-lane alphabet — spaces, words, diacritics, CJK, digits,
// punctuation, newlines — minus Devanagari: the virama merges the
// following consonant into the base cluster (क्ह is ONE grapheme), so
// the cp−marks oracle — exact for the th-style scripts it was built on —
// would read 2. Devanagari's unit is the vowels lane (G3's hi dispatch),
// and the determinism lane below still exercises it.
const TEXT_ATOMS = [
  'a', 'B', '3', '0', '日', '本', '水', 'あ', 'ん', 'a\u0301',
  ' ', '\n', '\t', ',', '.', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '-', "'", '"', '♪', '♫', '…', 'e', 'o',
];

const textArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TEXT_ATOMS), { minLength: 0, maxLength: 40 })
  .map((atoms) => atoms.join(''));

describe('chars-mode differential vs the unit-sanity oracle', () => {
  it('keeps the grapheme count inside the ±10% band of code points minus combining marks', () => {
    fc.assert(
      fc.property(textArb, (text) => {
        const graphemes = countWordTokens(text, 'chars');
        const oracle = codePointTokens(text) - combiningMarkTokens(text);
        expect(Math.abs(graphemes - oracle) / Math.max(oracle, 1)).toBeLessThanOrEqual(0.1);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// The determinism lane runs the FULL study alphabet — Devanagari (incl.
// the conjunct-forming क्+ह) included: determinism must hold for any text.
const determinismArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TEXT_ATOMS, 'क', 'ह', 'क\u094D'), { minLength: 0, maxLength: 40 })
  .map((atoms) => atoms.join(''));

describe('per-mode determinism', () => {
  it('counts the same input identically on every mode (the G3 determinism convention)', () => {
    fc.assert(
      fc.property(determinismArb, (text) => {
        for (const mode of ['words', 'words-marks', 'chars', 'mora'] as const) {
          expect(countWordTokens(text, mode)).toBe(countWordTokens(text, mode));
        }
        expect(countVowelNuclei(text, 'hi')).toBe(countVowelNuclei(text, 'hi'));
        expect(countVowelNuclei(text, 'tr')).toBe(countVowelNuclei(text, 'tr'));
        expect(countMorae(text)).toBe(countMorae(text));
      }),
      { seed: SEED, numRuns: 100 },
    );
  });
});
