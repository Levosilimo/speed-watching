// Wave 3 batch B — the timeline generators: cues/words laid down at a
// PRESCRIBED presentation rate R (chosen unit-token count T over the span
// S = T·60/R between first and last spoken starts), and the recovery
// property: each tier's rate function recovers R inside its documented
// bias band — the ±10% G3 band for the unified/cue/manual tiers, and the
// word tier's ~16% undercount (plan-v3 rule 1: the naive word path drops
// the untimed first token per cue). The generator parameterizes the
// Wave-2 rate pins (es 240, ja 462, hi 480, tr 600, ko 420) at arbitrary
// rates. Edge cases: zero-duration cues, all-bracket payloads (null, never
// NaN), no qualifying sub-1s gaps (the articulatory warning suppressed),
// out-of-order timestamps (the existing fixture's behavior).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Segment } from '../lib/captions';
import { parseYouTubeJson3 } from '../lib/captions';
import { LANGUAGES } from '../lib/languages';
import { recommend } from '../lib/recommend';
import {
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  speechDurationSec,
  wordLevelWpm,
  wordTierInputs,
} from '../lib/wpm';
import { readFixture } from './fixtures/helpers';

const SEED = 4242;

/** A text whose unit-token count is hand-verified (words: letter/digit
 * runs; ja: kana code points; hi: Devanagari vowel nuclei; tr: Turkish
 * vowel letters; ko: Hangul blocks). */
interface RateAtom {
  text: string;
  tokens: number;
}

/** Multi-token words for the words-mode tiers: T/n ∈ [5, 9] per draw, so
 * the word tier's undercount (one dropped lead per cue) stays inside the
 * documented ~16% band. */
const WORD_ATOMS: RateAtom[] = [
  { text: 'the quick brown fox jumps over the lazy dog', tokens: 9 },
  { text: 'one two three four five', tokens: 5 },
  { text: '42 percent of people agree', tokens: 5 },
  { text: 'a b c d e f', tokens: 6 },
];

const UNIT_ATOMS: Record<string, RateAtom[]> = {
  es: [
    { text: 'hola', tokens: 1 },
    { text: 'mundo', tokens: 1 },
    { text: 'buenos', tokens: 1 },
    { text: 'días', tokens: 1 },
    { text: 'gente', tokens: 1 },
    { text: 'casa', tokens: 1 },
  ],
  ja: [
    { text: 'こんにちは', tokens: 5 },
    { text: 'ありがとう', tokens: 5 },
    { text: 'コーヒー', tokens: 4 },
    { text: 'さくら', tokens: 3 },
    { text: 'ねこ', tokens: 2 },
    { text: 'すし', tokens: 2 },
  ],
  hi: [
    { text: 'मैं', tokens: 1 },
    { text: 'जा', tokens: 1 },
    { text: 'रहा', tokens: 2 },
    { text: 'हूँ', tokens: 1 },
    { text: 'नहीं', tokens: 2 },
    { text: 'क्या', tokens: 1 },
  ],
  tr: [
    { text: 'merhaba', tokens: 3 },
    { text: 'dünya', tokens: 2 },
    { text: 'nasılsın', tokens: 3 },
    { text: 'bugün', tokens: 2 },
    { text: 'Türkçe', tokens: 2 },
    { text: 'İstanbul', tokens: 3 },
  ],
  ko: [
    { text: '안녕하세요', tokens: 5 },
    { text: '세상', tokens: 2 },
    { text: '한국어', tokens: 3 },
    { text: '감사합니다', tokens: 5 },
    { text: '학생', tokens: 2 },
    { text: '대한민국', tokens: 4 },
  ],
};

/** Cues at the prescribed presentation rate R: the drawn atoms carry known
 * token counts, so the total T and the first-to-last spoken start span
 * S = T·60/R define the rate exactly. Starts are evenly spaced; durations
 * tile the gaps (dur_i = step − gap_i), so Σdur = S − G, and the last cue
 * carries the trailing tail ∈ [0.01, 0.10]·S — the cue-tier pause
 * dilution — while gaps totaling G ∈ [0, 0.05]·S (per-gap bound divided
 * across the n−1 gaps) exercise the manual tier's silence correction.
 * Both stay inside the ±10% recovery band by construction. */
function rateCuesArb(R: number, pool: RateAtom[]): fc.Arbitrary<Segment[]> {
  return fc
    .array(fc.constantFrom(...pool), { minLength: 2, maxLength: 8 })
    .chain((specs) => {
      const tokens = specs.reduce((sum, spec) => sum + spec.tokens, 0);
      const span = (tokens * 60) / R;
      const step = span / (specs.length - 1);
      return fc
        .record({
          gaps: fc.array(fc.double({ min: 0, max: 0.05 * span / (specs.length - 1), noNaN: true }), {
            minLength: specs.length - 1,
            maxLength: specs.length - 1,
          }),
          tail: fc.double({ min: 0.01 * span, max: 0.1 * span, noNaN: true }),
        })
        .map(({ gaps, tail }) =>
          specs.map((spec, i) => {
            const isLast = i === specs.length - 1;
            return {
              text: spec.text,
              startSec: step * i,
              durSec: isLast ? tail : step - gaps[i]!,
            };
          }),
        );
    });
}

/** The word tier's inputs at the same prescribed rate: every token of each
 * cue except the first — the untimed lead the naive word path drops —
 * timed at its cue start. The span is unchanged and the count is T − n,
 * so wordLevelWpm recovers R·(T−n)/T. */
function wordTierArb(R: number, pool: RateAtom[]): fc.Arbitrary<Segment[]> {
  return rateCuesArb(R, pool).map((cues) =>
    cues.flatMap((cue) =>
      cue.text
        .split(' ')
        .slice(1)
        .map((token) => ({ text: token, startSec: cue.startSec })),
    ),
  );
}

const rateArb = fc.double({ min: 60, max: 900, noNaN: true });

describe('prescribed-rate recovery', () => {
  it('recovers R within each tier\'s documented bias band', () => {
    fc.assert(
      fc.property(
        rateArb.chain((R) =>
          fc.tuple(fc.constant(R), rateCuesArb(R, WORD_ATOMS), wordTierArb(R, WORD_ATOMS)),
        ),
        ([R, cues, words]) => {
          const unified = filteredTokensOverTrimmedSpan(cues);
          const cue = cueLevelWpm(cues);
          const corrected = correctedCueLevelWpm(cues);
          const manual = manualCueRate(cues);
          // Unified is exact by construction (T over S); the cue tier's
          // trailing tail and the manual tier's silence correction keep
          // the recovered rates inside the ±10% G3 band.
          for (const rate of [unified, cue, corrected, manual]) {
            expect(rate).not.toBeNull();
            expect(Math.abs(rate! - R) / R).toBeLessThanOrEqual(0.1);
          }
          // Word tier: T − n tokens over the same span — the documented
          // ~16% undercount (n/T ∈ [0.11, 0.20] by construction), asserted
          // on the honest band 0.84 ± 0.10.
          expect(words.length).toBeGreaterThan(0);
          const word = wordLevelWpm(words);
          expect(word).not.toBeNull();
          expect(word!).toBeGreaterThanOrEqual(0.74 * R);
          expect(word!).toBeLessThanOrEqual(0.94 * R);
        },
      ),
      { seed: SEED, numRuns: 100 },
    );
  });

  it('recovers arbitrary prescribed rates in every language unit', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('es', 'ja', 'hi', 'tr', 'ko').chain((code) =>
          rateArb.chain((R) =>
            fc.tuple(fc.constant(code), fc.constant(R), rateCuesArb(R, UNIT_ATOMS[code]!)),
          ),
        ),
        ([code, R, cues]) => {
          const rate = filteredTokensOverTrimmedSpan(cues, LANGUAGES[code]);
          expect(rate).not.toBeNull();
          expect(Math.abs(rate! - R) / R).toBeLessThanOrEqual(0.1);
        },
      ),
      { seed: SEED, numRuns: 100 },
    );
  });

  it('reproduces the Wave-2 rate pins at their anchor spans (es 240, ja 462, hi 480, tr 600, ko 420)', () => {
    // The Wave-2 anchors (rates-snapshots.test.ts): two cues whose
    // hand-verified unit-token totals T over the span S = T·60/R pin the
    // rate. The generator's prescription reproduces each pin exactly.
    const pins: { code: string; R: number; atoms: RateAtom[] }[] = [
      { code: 'es', R: 240, atoms: [{ text: 'hola mundo', tokens: 2 }, { text: 'buenos días', tokens: 2 }] },
      { code: 'ja', R: 462, atoms: [{ text: 'こんにちは世界', tokens: 8.7 }, { text: '元気ですか', tokens: 6.7 }] },
      { code: 'hi', R: 480, atoms: [{ text: 'मैं जा रहा हूँ', tokens: 5 }, { text: 'मैं ठीक हूँ', tokens: 3 }] },
      { code: 'tr', R: 600, atoms: [{ text: 'merhaba dünya', tokens: 5 }, { text: 'bugün nasılsın', tokens: 5 }] },
      { code: 'ko', R: 420, atoms: [{ text: '안녕하세요', tokens: 5 }, { text: '세상', tokens: 2 }] },
    ];
    for (const { code, R, atoms } of pins) {
      const tokens = atoms.reduce((sum, atom) => sum + atom.tokens, 0);
      const span = (tokens * 60) / R;
      const cues = atoms.map((atom, i) => ({
        text: atom.text,
        startSec: (span * i) / (atoms.length - 1),
        durSec: span / (atoms.length - 1),
      }));
      expect(filteredTokensOverTrimmedSpan(cues, LANGUAGES[code]), code).toBeCloseTo(R, 6);
    }
  });
});

describe('timeline edge cases', () => {
  it('keeps zero-duration cues rate-computable on the unified rule and speechless on the manual rate', () => {
    // Durations are irrelevant to the unified rule (T over the trimmed
    // start span), and Σdur = 0 carries no speech for the manual tier.
    const cues = [
      { text: 'the quick brown fox jumps over the lazy dog', startSec: 0, durSec: 0 },
      { text: 'one two three four five', startSec: 2, durSec: 0 },
    ];
    const unified = filteredTokensOverTrimmedSpan(cues);
    expect(unified).not.toBeNull();
    expect(unified!).toBeCloseTo((14 / 2) * 60, 6);
    expect(manualCueRate(cues)).toBeNull();
  });

  it('returns null — never NaN — on an all-bracket payload', () => {
    const cues = [
      { text: '[Music]', startSec: 0, durSec: 1 },
      { text: '[Applause]', startSec: 2, durSec: 1 },
    ];
    expect(filteredTokensOverTrimmedSpan(cues)).toBeNull();
    expect(manualCueRate(cues)).toBeNull();
    expect(wordLevelWpm([])).toBeNull();
    // No computed number may escape as NaN: the cue-tier path still
    // counts bracket words (the documented inflation) but stays finite.
    expect(Number.isNaN(cueLevelWpm(cues)!)).toBe(false);
    expect(Number.isNaN(correctedCueLevelWpm(cues)!)).toBe(false);
  });

  it('suppresses the articulatory warning when no sub-1s gaps exist (the documented safe failure)', () => {
    // Words ≥1 s apart carry no qualifying inter-start span, so
    // speechDurationSec is null and wordTierInputs declines — the caller
    // passes no articulatory input and the pause-diluted warning stays
    // silent instead of firing on an unmeasurable estimate.
    const words = [
      { text: 'a', startSec: 0 },
      { text: 'b', startSec: 1 },
      { text: 'c', startSec: 2.5 },
      { text: 'd', startSec: 4 },
    ];
    expect(speechDurationSec(words)).toBeNull();
    expect(wordTierInputs(words, words)).toBeNull();
    const rec = recommend({
      naturalRate: 250,
      tier: 'asr-word',
      contentType: 'lecture',
      platformMax: 2,
      articulatoryWpm: null,
      timingCoverageOk: true,
    });
    expect(rec.reason).not.toBe('pause-diluted');
    expect(rec.mode).toBe('recommend');
  });

  it('handles out-of-order timestamps like the existing fixture (parser sorts; speech duration skips rewinds)', () => {
    // The synthetic fixture: events/windows arrive reordered, and the
    // documented pipeline behavior is — parseYouTubeJson3 sorts ascending
    // (captions.test.ts), speechDurationSec skips the non-positive deltas
    // a rewind produces (wpm.test.ts). Re-derived here on a generated
    // timeline so the two behaviors pin together.
    const shuffled = [
      { text: 'late', startSec: 3 },
      { text: 'middle', startSec: 1.5 },
      { text: 'early', startSec: 0 },
    ];
    const payload = {
      events: shuffled.map((cue) => ({
        tStartMs: Math.round(cue.startSec * 1000),
        dDurationMs: 1000,
        segs: [{ utf8: cue.text }],
      })),
    };
    expect(parseYouTubeJson3(payload).cues.map((cue) => cue.startSec)).toEqual([0, 1.5, 3]);
    const rewound = [
      { text: 'a', startSec: 0 },
      { text: 'b', startSec: 0.8 },
      { text: 'c', startSec: 0.4 },
      { text: 'd', startSec: 1.6 },
    ];
    expect(speechDurationSec(rewound)).toBeCloseTo(0.8, 6);
    // And the recorded fixture still pins the same pair.
    const fixture = parseYouTubeJson3(readFixture('synthetic/out-of-order.json'));
    expect(fixture.words.map((word) => word.startSec)).toEqual([0, 1.5, 3]);
  });
});
