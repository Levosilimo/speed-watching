// Per-mode G3 counting gates for the caption-rate corpus (G3 reported by
// scripts/measure-analysis.ts). Words-mode languages (vi/ar/id/ms/tl and
// the ru/slavic set) compare the production word-run counter against
// Intl.Segmenter (regex-icu) — the syllablesPerWord factor lives in
// unitTokens, not countWordTokens, so the comparison stays valid. hi's
// vowels mode has no ICU segmenter for vowel nuclei, so its gate is
// determinism over the corpus text plus a hand-annotated Devanagari
// sample within the documented ±10% band. Split out to keep
// measure-analysis.ts under the 400-line gate.

import type { ParsedCaptions } from '../lib/captions';
import { countVowelNuclei, countWordTokens, isBracketMarker } from '../lib/tokenizer';
import type { CorpusRecord, GateSummary } from './measure-analysis';

/** Production word-run counter vs Intl.Segmenter over the joined
 * non-marker cue text (words-mode G3 input). */
export function countAccuracy(
  parsed: ParsedCaptions,
  lang: string,
): { regex: number; icu: number; deltaPct: number } | null {
  const text = spokenText(parsed);
  if (text === '') return null;
  const regex = countWordTokens(text);
  let icu = regex;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    icu = 0;
    for (const part of new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)) {
      if (part.isWordLike) icu++;
    }
  }
  const deltaPct = icu > 0 ? (Math.abs(regex - icu) / icu) * 100 : 0;
  return { regex, icu, deltaPct };
}

/** Joined non-marker cue text of a payload — the G3 counting input. */
export function spokenText(parsed: ParsedCaptions): string {
  return parsed.cues
    .filter((cue) => !isBracketMarker(cue.text))
    .map((cue) => cue.text)
    .join(' ');
}

export interface VowelsSampleRow {
  text: string;
  /** Hand-annotated syllable count (spoken Hindi). */
  syllables: number;
  note: string;
}

/** Hand-annotated Devanagari sample for the hi vowels-mode G3 gate — the
 * tokenizer's documented cases: halant clusters (क्या 1, कर्म 1), medial
 * halant (हिन्दी 2), final-schwa deletion (वह ठीक है 3), and the
 * epenthetic-schwa deviation (नमस्ते counts 2, spoken 3) that sets the
 * ±10% tolerance. */
export const DEVANAGARI_G3_SAMPLE: VowelsSampleRow[] = [
  { text: 'मैं जा रहा हूँ', syllables: 5, note: 'standalone vowels + consonant-vowels' },
  { text: 'क्या', syllables: 1, note: 'halant cluster' },
  { text: 'कर्म', syllables: 1, note: 'final halant cluster' },
  { text: 'हिन्दी', syllables: 2, note: 'medial halant' },
  // escapes pin the canonical conjunct: न + म् + स् + ते (two halants)
  { text: '\u0928\u092E\u094D\u0938\u094D\u0924\u0947', syllables: 2, note: 'epenthetic schwa (spoken 3)' },
  { text: 'अच्छा', syllables: 2, note: 'vowel letter + geminate' },
  { text: 'वह ठीक है', syllables: 3, note: 'final-schwa deletion' },
];

/** hi vowels-mode G3: determinism rows over the corpus text plus the
 * hand-annotated sample, ±10% tolerance per check (the documented
 * epenthetic-schwa deviation band). */
export function vowelsGate(own: CorpusRecord[]): GateSummary['g3'] {
  const rows = own.filter(
    (r) => r.classification === 'web-ok' && r.register !== 'music' && r.countDeltaPct !== null,
  );
  const checks = [
    ...rows.map((r) => ({ label: `determinism ${r.videoId}`, delta: r.countDeltaPct as number })),
    ...DEVANAGARI_G3_SAMPLE.map((row) => {
      const got = countVowelNuclei(row.text, 'hi');
      return {
        label: `sample ${row.text} (${row.note})`,
        delta: (Math.abs(got - row.syllables) / row.syllables) * 100,
      };
    }),
  ];
  const deltas = checks.map((c) => c.delta).sort((a, b) => a - b);
  return {
    mode: 'vowels-sample',
    n: checks.length,
    median: medianOf(deltas),
    maxDeltaPct: deltas.at(-1) ?? null,
    violations: checks.filter((c) => c.delta > 10).map((c) => `${c.label} ${c.delta.toFixed(1)}%`),
    pass: checks.every((c) => c.delta <= 10),
  };
}

/** Median of a sorted array; null when empty. Shared with the gate
 * reporter (scripts/measure-analysis.ts). */
export function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Words-mode G3: production counter vs Intl.Segmenter per video. */
export function countGate(own: CorpusRecord[]): GateSummary['g3'] {
  const countRows = own.filter(
    (r) => r.classification === 'web-ok' && r.register !== 'music' && r.countDeltaPct !== null,
  );
  const deltas = countRows.map((r) => r.countDeltaPct as number).sort((a, b) => a - b);
  return {
    mode: 'regex-icu',
    n: countRows.length,
    median: medianOf(deltas),
    maxDeltaPct: deltas.at(-1) ?? null,
    violations: countRows
      .filter((r) => (r.countDeltaPct as number) > 10)
      .map((r) => `${r.videoId} ${(r.countDeltaPct as number).toFixed(1)}%`),
    pass: countRows.every((r) => (r.countDeltaPct as number) <= 10),
  };
}

/** Per-mode G3 dispatch: hi's vowels mode runs the determinism + sample
 * gate (no ICU vowel-nuclei segmenter), every other corpus language the
 * regex-icu comparison. */
export function g3Gate(own: CorpusRecord[], lang: string): GateSummary['g3'] {
  return lang === 'hi' ? vowelsGate(own) : countGate(own);
}
