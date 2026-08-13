// Per-language speech-rate model (v1.0). The English 250 wpm target / 275 wpm
// ceiling anchor the ~39 bits/s information-rate ceiling (Coupé et al. 2019:
// 250 wpm × 1.5 syl/word × 6.3 bits/syll ≈ 39.4 bits/s). Every other target
// is a DERIVED ESTIMATE — none measured — scaling that ceiling by the
// language's syllabic rate and word structure:
//
//   - word-unit (wpm): scaled by syllables per word vs English 1.55 —
//     ru/uk ~2.3 → 168 wpm, pl/cs/sr ~2.1 → 185 (sourced syllabic rates:
//     ru 5.31 syl/s, pl 6.9 syl/s, sr 7.08 syl/s), es/pt/it short-word
//     Romance → 165–180, fr dense short words ≈ English → 250, de
//     compounding undercounts token runs ~25–30 % → 0.7 × English → 175.
//   - char-unit (cpm): zh 240–258 cpm, where the 258 ceiling
//     (Lee & Chan, 4.3 char/s) is the only comprehension-measured ceiling
//     in the set; th ~282 cpm derived.
//   - mora-unit (morae/min): ja 380–400 in the same band as the old
//     char estimate, measured by the mora estimator — each kana = 1 mora,
//     kanji × ~1.85 (on-yomi-dominant average; ±5–8% of a true analyzer).
//   - syllable-unit (syl/min): measured speech syllabic rates — ko/tr
//     330–350, ar 300–360 (low confidence), hi 240 (6.55 syl/s class),
//     id/ms ~400 (≈ 267 wpm at 1.5 syl/word, the English band with a small
//     lift), tl estimated like id.
//
// Ceilings on target-only entries apply the ≈1.03 target:ceiling ratio of
// the researched pairs. Priors (estimated-tier natural-rate ranges) scale
// the English generic-prior ratio (0.52–0.76 × target) to each target;
// ru/uk are the exception — their per-register priors (registerPriors) are
// the gathered Russian rate norms, not ratio-scaled (see the ru/uk row
// comment and docs/languages.md).
// syllable-per-word factors (ar 2.0, id/ms/tl 1.5) are typological
// approximations, documented as such; the multiplier itself is
// factor-invariant (target and rate share the unit), so only the displayed
// rate depends on them. tr's 2.3 and hi's 1.5 factors were retired when
// the vowel-nucleus counters replaced them; ko counts Hangul blocks.

import type { TokenizerMode } from './tokenizer';
import type { ContentType } from './music';

export type RateUnit = 'wpm' | 'cpm' | 'syl' | 'mora';

export interface LanguageModel {
  /** Normalized caption-track language code (lowercase, region stripped). */
  code: string;
  unit: RateUnit;
  /** Recommended presentation rate, in `unit`. */
  target: number;
  /** Safe-zone ceiling, in `unit`; above it the recommendation warns. */
  ceiling: number;
  tokenizerMode: TokenizerMode;
  /** True when target/ceiling are derived estimates, not measurements. */
  derived: boolean;
  /** Estimated-tier natural-rate range, in `unit`. */
  priors: { min: number; max: number };
  /** Per-register estimated-tier ranges, in `unit` (detectContentType's
   * bands and priorRange's register lookup). The generic entry mirrors
   * `priors`; absent → only the generic band. */
  registerPriors?: Partial<Record<ContentType, { min: number; max: number }>>;
  /** syl-unit languages: word-token → syllable conversion factor. */
  syllablesPerWord?: number;
  /** ko: count Hangul syllable blocks instead of applying the factor. */
  hangulBlocks?: boolean;
}

export const LANGUAGES: Record<string, LanguageModel> = {
  en: { code: 'en', unit: 'wpm', target: 250, ceiling: 275, tokenizerMode: 'words', derived: false, priors: { min: 130, max: 190 } },
  es: { code: 'es', unit: 'wpm', target: 170, ceiling: 175, tokenizerMode: 'words', derived: true, priors: { min: 88, max: 129 } },
  pt: { code: 'pt', unit: 'wpm', target: 165, ceiling: 167, tokenizerMode: 'words', derived: true, priors: { min: 86, max: 125 } },
  fr: { code: 'fr', unit: 'wpm', target: 250, ceiling: 253, tokenizerMode: 'words', derived: true, priors: { min: 130, max: 190 } },
  de: { code: 'de', unit: 'wpm', target: 175, ceiling: 181, tokenizerMode: 'words', derived: true, priors: { min: 91, max: 133 } },
  it: { code: 'it', unit: 'wpm', target: 180, ceiling: 184, tokenizerMode: 'words', derived: true, priors: { min: 94, max: 137 } },
  ja: { code: 'ja', unit: 'mora', target: 380, ceiling: 400, tokenizerMode: 'mora', derived: true, priors: { min: 198, max: 289 } },
  zh: { code: 'zh', unit: 'cpm', target: 240, ceiling: 258, tokenizerMode: 'chars', derived: false, priors: { min: 125, max: 182 } },
  th: { code: 'th', unit: 'cpm', target: 282, ceiling: 290, tokenizerMode: 'chars', derived: true, priors: { min: 147, max: 214 } },
  ko: { code: 'ko', unit: 'syl', target: 340, ceiling: 350, tokenizerMode: 'words', derived: true, priors: { min: 177, max: 258 }, hangulBlocks: true },
  ar: { code: 'ar', unit: 'syl', target: 330, ceiling: 360, tokenizerMode: 'words', derived: true, priors: { min: 172, max: 251 }, syllablesPerWord: 2.0 },
  tr: { code: 'tr', unit: 'syl', target: 340, ceiling: 350, tokenizerMode: 'vowels', derived: true, priors: { min: 177, max: 258 } },
  hi: { code: 'hi', unit: 'syl', target: 240, ceiling: 247, tokenizerMode: 'vowels', derived: true, priors: { min: 125, max: 182 } },
  vi: { code: 'vi', unit: 'wpm', target: 280, ceiling: 290, tokenizerMode: 'words', derived: true, priors: { min: 146, max: 213 } },
  id: { code: 'id', unit: 'syl', target: 400, ceiling: 412, tokenizerMode: 'words', derived: true, priors: { min: 208, max: 304 }, syllablesPerWord: 1.5 },
  ms: { code: 'ms', unit: 'syl', target: 400, ceiling: 412, tokenizerMode: 'words', derived: true, priors: { min: 208, max: 304 }, syllablesPerWord: 1.5 },
  tl: { code: 'tl', unit: 'syl', target: 400, ceiling: 412, tokenizerMode: 'words', derived: true, priors: { min: 208, max: 304 }, syllablesPerWord: 1.5 },
  // ru/uk register bands are the gathered Russian rate norms themselves: news
  // and dictation 120–150 wpm, conversational ~100–140, lecture ~95–135,
  // explainer ~100–140 (Kazabeeva 2015 pedagogy norms; the "fast" band tops
  // out ~400 syl/min ≈ 174 wpm). The old content-invariant 87–128 prior sat
  // under every one of them; the generic band is their union mid (105–145).
  // The 180 ceiling keeps ~3.5% headroom above the fast band.
  ru: {
    code: 'ru',
    unit: 'wpm',
    target: 168,
    ceiling: 180,
    tokenizerMode: 'words',
    derived: true,
    priors: { min: 105, max: 145 },
    registerPriors: {
      news: { min: 120, max: 150 },
      podcast: { min: 100, max: 140 },
      lecture: { min: 95, max: 135 },
      explainer: { min: 100, max: 140 },
      talk: { min: 100, max: 140 },
      generic: { min: 105, max: 145 },
    },
  },
  uk: {
    code: 'uk',
    unit: 'wpm',
    target: 168,
    ceiling: 180,
    tokenizerMode: 'words',
    derived: true,
    priors: { min: 105, max: 145 },
    registerPriors: {
      news: { min: 120, max: 150 },
      podcast: { min: 100, max: 140 },
      lecture: { min: 95, max: 135 },
      explainer: { min: 100, max: 140 },
      talk: { min: 100, max: 140 },
      generic: { min: 105, max: 145 },
    },
  },
  pl: { code: 'pl', unit: 'wpm', target: 185, ceiling: 200, tokenizerMode: 'words', derived: true, priors: { min: 96, max: 141 } },
  cs: { code: 'cs', unit: 'wpm', target: 185, ceiling: 200, tokenizerMode: 'words', derived: true, priors: { min: 96, max: 141 } },
  sr: { code: 'sr', unit: 'wpm', target: 185, ceiling: 200, tokenizerMode: 'words', derived: true, priors: { min: 96, max: 141 } },
};

/** Pill label suffixes per rate unit. 'morae' — the standard plural of
 * mora in Japanese linguistics — reads naturally in the pill. */
export const UNIT_LABELS: Record<RateUnit, string> = {
  wpm: 'wpm',
  cpm: 'cpm',
  syl: 'syl/min',
  mora: 'morae/min',
};

/**
 * Normalize a YouTube caption-track languageCode: lowercase, strip the
 * region. 'en-US' → 'en', 'zh-Hans' → 'zh', 'es-419' → 'es', 'pt-BR' → 'pt'.
 */
export function normalizeLanguageCode(raw: string): string | null {
  const code = raw.toLowerCase().split('-')[0];
  return code === undefined || code === '' ? null : code;
}

/** Resolve a caption-track languageCode to its model; null when unmapped. */
export function resolveLanguage(raw: string | undefined): LanguageModel | null {
  if (raw === undefined) return null;
  const code = normalizeLanguageCode(raw);
  if (code === null) return null;
  return LANGUAGES[code] ?? null;
}
