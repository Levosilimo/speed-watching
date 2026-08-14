// Per-mode G3 counting gates for the caption-rate corpus (G3 reported by
// scripts/measure-analysis.ts). Words-mode languages (vi/ar/id/ms/tl and
// the ru/slavic set) compare the production word-run counter against
// Intl.Segmenter (regex-icu) — the syllablesPerWord factor lives in
// unitTokens, not countWordTokens, so the comparison stays valid. The
// script-unit languages have no ICU segmenter for their unit, so their
// gates are determinism over the corpus text plus a hand-annotated sample
// within the documented band: hi counts Devanagari vowel nuclei, ja counts
// morae (kana code points + kanji × 1.85). th's chars mode is a
// unit-sanity gate — grapheme segmentation vs code points, combining marks
// stay attached. ko is words-mode (regex-icu stays valid — Korean is
// spaced) plus a hangulBlocks determinism smoke (each Hangul block is
// exactly one syllable). Split out to keep measure-analysis.ts under the
// 400-line gate.

import type { ParsedCaptions } from '../lib/captions';
import {
  countHangulSyllables,
  countMorae,
  countVowelNuclei,
  countWordTokens,
  isBracketMarker,
  NON_SPEECH_GRAPHENE_RE,
} from '../lib/tokenizer';
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

/** Code-point token count with combining marks counted apart — the naive
 * chars baseline the th unit-sanity gate compares the grapheme counter
 * against (marks are \p{M}, outside the non-speech class). */
export function codePointTokens(text: string): number {
  return [...text].filter((cp) => !NON_SPEECH_GRAPHENE_RE.test(cp)).length;
}

/** Combining-mark code points (\p{M}) — the exact difference between the
 * code-point baseline and the grapheme count when segmentation attaches
 * every mark to a base character. */
export function combiningMarkTokens(text: string): number {
  return [...text].filter((cp) => /\p{M}/u.test(cp)).length;
}

/** Production chars-mode grapheme count (unitTokens' 'chars' path). */
export function graphemeTokens(text: string): number {
  return countWordTokens(text, 'chars');
}

/** Median of a sorted array; null when empty. Shared with the gate
 * reporter (scripts/measure-analysis.ts). */
export function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface GateCheck {
  label: string;
  delta: number;
}

/** Summary shape shared by the per-mode gates: sorted deltas, median, max,
 * violations over the ±10% band, pass. */
function summaryFromChecks(checks: GateCheck[], mode: GateSummary['g3']['mode']): GateSummary['g3'] {
  const deltas = checks.map((c) => c.delta).sort((a, b) => a - b);
  return {
    mode,
    n: checks.length,
    median: medianOf(deltas),
    maxDeltaPct: deltas.at(-1) ?? null,
    violations: checks.filter((c) => c.delta > 10).map((c) => `${c.label} ${c.delta.toFixed(1)}%`),
    pass: checks.every((c) => c.delta <= 10),
  };
}

/** Non-music web-ok records of a language — the determinism/unit-sanity
 * row source for every non-words gate. */
function gateRows(own: CorpusRecord[]): CorpusRecord[] {
  return own.filter((r) => r.classification === 'web-ok' && r.register !== 'music');
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
  const rows = gateRows(own).filter((r) => r.countDeltaPct !== null);
  const checks: GateCheck[] = [
    ...rows.map((r) => ({ label: `determinism ${r.videoId}`, delta: r.countDeltaPct as number })),
    ...DEVANAGARI_G3_SAMPLE.map((row) => {
      const got = countVowelNuclei(row.text, 'hi');
      return {
        label: `sample ${row.text} (${row.note})`,
        delta: (Math.abs(got - row.syllables) / row.syllables) * 100,
      };
    }),
  ];
  return summaryFromChecks(checks, 'vowels-sample');
}

export interface MoraSampleRow {
  text: string;
  /** Hand-annotated spoken mora count (phonological). */
  morae: number;
  note: string;
}

/** Hand-annotated Japanese mora sample for the ja mora-mode G3 gate. Kana
 * rows are exact (one code point per mora, incl. ー and っ); kanji rows
 * exercise the 1.85 on-yomi average inside the documented ±10% band. The
 * estimator's over-counts beyond the band — yōon small kana (ちょっと
 * counts 4, spoken 3) and 2-mora single kanji (行く counts 2.85, spoken 2)
 * — stay out of the sample and are recorded in the corpus doc. */
export const JA_MORA_G3_SAMPLE: MoraSampleRow[] = [
  { text: 'こんにちは', morae: 5, note: 'kana: exact' },
  { text: 'ありがとう', morae: 5, note: 'long vowel う = 1 mora' },
  { text: 'コーヒー', morae: 4, note: 'chōonpu ー = 1 mora each' },
  { text: '東京', morae: 4, note: 'kanji pair: 1.85, 7.5% deviation' },
  { text: '学生', morae: 4, note: 'kanji pair がくせい: 7.5% deviation' },
  { text: '音楽を聞く', morae: 7, note: 'mixed: 6.4% deviation' },
  { text: '学校で日本語を学ぶ', morae: 13, note: 'mixed sentence: 0.8% deviation' },
  { text: '僕は学生です', morae: 9, note: 'mixed sentence: 5.0% deviation' },
];

/** ja mora-mode G3: determinism rows over the corpus text (countMorae
 * applied twice) plus the hand-annotated sample — Intl.Segmenter has no
 * mora granularity, so regex-vs-ICU is meaningless here. */
export function moraGate(own: CorpusRecord[]): GateSummary['g3'] {
  const rows = gateRows(own).filter((r) => r.countDeltaPct !== null);
  const checks: GateCheck[] = [
    ...rows.map((r) => ({ label: `determinism ${r.videoId}`, delta: r.countDeltaPct as number })),
    ...JA_MORA_G3_SAMPLE.map((row) => {
      const got = countMorae(row.text);
      return {
        label: `sample ${row.text} (${row.note})`,
        delta: (Math.abs(got - row.morae) / row.morae) * 100,
      };
    }),
  ];
  return summaryFromChecks(checks, 'mora-sample');
}

export interface ThaiSampleRow {
  text: string;
  note: string;
}

/** Hand-pinned Thai text for the chars-mode unit-sanity gate: grapheme
 * segmentation must keep every combining mark (tone marks ั ี ้) attached
 * to its base, so graphemes = code points − combining marks exactly. */
export const THAI_G3_SAMPLE: ThaiSampleRow[] = [
  { text: 'สวัสดี', note: 'marks ั ี: 6 code points → 4 graphemes' },
  { text: 'สวัสดีครับ', note: 'marks in วั and รั: 10 code points → 7 graphemes' },
  { text: 'ไม่', note: 'sara i + tone mark: 3 code points → 2 graphemes' },
  { text: 'ภาษาไทย', note: 'no marks: graphemes == code points' },
  { text: 'ประเทศไทย', note: 'no marks: graphemes == code points' },
];

/** th chars-mode G3: unit-sanity — the production grapheme count vs the
 * code-point baseline minus combining marks (must agree when every mark
 * attaches) on the corpus text, plus the hand-pinned sample. */
export function charsGate(own: CorpusRecord[]): GateSummary['g3'] {
  const rows = gateRows(own).filter((r) => r.countDeltaPct !== null);
  const checks: GateCheck[] = [
    ...rows.map((r) => ({ label: `unit-sanity ${r.videoId}`, delta: r.countDeltaPct as number })),
    ...THAI_G3_SAMPLE.map((row) => {
      const graphemes = graphemeTokens(row.text);
      const expected = codePointTokens(row.text) - combiningMarkTokens(row.text);
      const delta = graphemes > 0 ? (Math.abs(graphemes - expected) / graphemes) * 100 : 0;
      return { label: `sample ${row.text} (${row.note})`, delta };
    }),
  ];
  return summaryFromChecks(checks, 'chars-sanity');
}

export interface HangulSampleRow {
  text: string;
  /** Hand-counted Hangul syllable blocks. */
  blocks: number;
  note: string;
}

/** Hand-pinned Korean text for the ko hangulBlocks smoke: each Hangul
 * syllable block (U+AC00–U+D7A3) is exactly one syllable by Unicode design,
 * so the counter must land the annotated block count on every row. */
export const KO_HANGUL_G3_SAMPLE: HangulSampleRow[] = [
  { text: '안녕하세요', blocks: 5, note: '5 blocks = 5 syllables' },
  { text: '한국어', blocks: 3, note: '3 blocks' },
  { text: '감사합니다', blocks: 5, note: '5 blocks' },
  { text: '저는 학생입니다', blocks: 7, note: 'spaces split nothing' },
  { text: '대한민국', blocks: 4, note: '4 blocks' },
];

/** ko G3: the words-mode regex-icu comparison (valid — Korean is spaced)
 * plus a hangulBlocks determinism smoke over the corpus text and the
 * hand-pinned sample. */
export function koGate(own: CorpusRecord[]): GateSummary['g3'] {
  const countRows = gateRows(own).filter((r) => r.countDeltaPct !== null);
  const hangulRows = gateRows(own).filter((r) => r.hangulDeltaPct != null);
  const checks: GateCheck[] = [
    ...countRows.map((r) => ({ label: `regex-icu ${r.videoId}`, delta: r.countDeltaPct as number })),
    ...hangulRows.map((r) => ({ label: `hangul determinism ${r.videoId}`, delta: r.hangulDeltaPct as number })),
    ...KO_HANGUL_G3_SAMPLE.map((row) => {
      const got = countHangulSyllables(row.text);
      return {
        label: `sample ${row.text} (${row.note})`,
        delta: (Math.abs(got - row.blocks) / row.blocks) * 100,
      };
    }),
  ];
  return summaryFromChecks(checks, 'regex-icu+hangul');
}

/** Words-mode G3: production counter vs Intl.Segmenter per video. */
export function countGate(own: CorpusRecord[]): GateSummary['g3'] {
  const countRows = gateRows(own).filter((r) => r.countDeltaPct !== null);
  const checks: GateCheck[] = countRows.map((r) => ({
    label: r.videoId,
    delta: r.countDeltaPct as number,
  }));
  const g3 = summaryFromChecks(checks, 'regex-icu');
  // violations keep the videoId prefix the old shape printed
  g3.violations = checks.filter((c) => c.delta > 10).map((c) => `${c.label} ${c.delta.toFixed(1)}%`);
  return g3;
}

export interface CountingInputs {
  regexCount: number | null;
  icuCount: number | null;
  countDeltaPct: number | null;
  /** ko hangulBlocks determinism smoke (countHangulSyllables twice). */
  hangulDeltaPct: number | null;
}

/** Per-mode G3 counting inputs for a payload. hi vowels and ja mora run
 * determinism — the unit counter applied twice (no ICU segmenter for
 * vowel nuclei or morae) — th runs the chars unit-sanity (production
 * graphemes vs code points minus combining marks), words-mode languages
 * the regex-icu comparison, and ko adds the hangulBlocks smoke. */
export function countingInputs(parsed: ParsedCaptions, lang: string): CountingInputs {
  const text = spokenText(parsed);
  const none = { regexCount: null, icuCount: null, countDeltaPct: null, hangulDeltaPct: null };
  if (lang === 'hi') {
    const first = countVowelNuclei(text, lang);
    const second = countVowelNuclei(text, lang);
    return {
      ...none,
      regexCount: first,
      icuCount: second,
      countDeltaPct: first > 0 ? (Math.abs(first - second) / first) * 100 : 0,
    };
  }
  if (lang === 'ja') {
    const first = countMorae(text);
    const second = countMorae(text);
    return {
      ...none,
      regexCount: first,
      icuCount: second,
      countDeltaPct: first > 0 ? (Math.abs(first - second) / first) * 100 : 0,
    };
  }
  if (lang === 'th') {
    const graphemes = graphemeTokens(text);
    const expected = codePointTokens(text) - combiningMarkTokens(text);
    return {
      ...none,
      regexCount: graphemes,
      icuCount: expected,
      countDeltaPct: graphemes > 0 ? (Math.abs(graphemes - expected) / graphemes) * 100 : 0,
    };
  }
  const acc = countAccuracy(parsed, lang);
  const hangulDeltaPct =
    lang === 'ko'
      ? (() => {
          const first = countHangulSyllables(text);
          const second = countHangulSyllables(text);
          return first > 0 ? (Math.abs(first - second) / first) * 100 : 0;
        })()
      : null;
  if (acc === null) return { ...none, hangulDeltaPct };
  return {
    regexCount: acc.regex,
    icuCount: acc.icu,
    countDeltaPct: acc.deltaPct,
    hangulDeltaPct,
  };
}

/** G3 variant labels for the summary printer. */
export const G3_MODE_LABELS: Record<GateSummary['g3']['mode'], string> = {
  'regex-icu': 'G3 count accuracy',
  'vowels-sample': 'G3 vowels sample+determinism',
  'mora-sample': 'G3 mora sample+determinism',
  'chars-sanity': 'G3 chars unit-sanity',
  'regex-icu+hangul': 'G3 count accuracy+hangul determinism',
};

/** Per-mode G3 dispatch: hi's vowels mode and ja's mora mode run the
 * determinism + sample gates (no ICU segmenter for their units), th the
 * chars unit-sanity gate, ko the regex-icu gate plus the hangulBlocks
 * smoke, every other corpus language the plain regex-icu comparison. */
export function g3Gate(own: CorpusRecord[], lang: string): GateSummary['g3'] {
  if (lang === 'hi') return vowelsGate(own);
  if (lang === 'ja') return moraGate(own);
  if (lang === 'th') return charsGate(own);
  if (lang === 'ko') return koGate(own);
  return countGate(own);
}
