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
//   - char-unit (cpm): the 1 char ≈ 1 mora approximation — ja ~360–400 cpm
//     band, th ~282 cpm derived; zh 240–258 cpm, where the 258 ceiling
//     (Lee & Chan, 4.3 char/s) is the only comprehension-measured ceiling
//     in the set.
//   - syllable-unit (syl/min): measured speech syllabic rates — ko/tr
//     330–350, ar 300–360 (low confidence), hi 240 (6.55 syl/s class),
//     id/ms ~400 (≈ 267 wpm at 1.5 syl/word, the English band with a small
//     lift), tl estimated like id.
//
// Ceilings on target-only entries apply the ≈1.03 target:ceiling ratio of
// the researched pairs. Priors (estimated-tier natural-rate ranges) scale
// the English generic-prior ratio (0.52–0.76 × target) to each target.
// syllable-per-word factors are typological approximations, documented as
// such; the multiplier itself is factor-invariant (target and rate share
// the unit), so only the displayed rate depends on them.

import type { TokenizerMode } from './tokenizer';

export type RateUnit = 'wpm' | 'cpm' | 'syl';

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
  ja: { code: 'ja', unit: 'cpm', target: 380, ceiling: 400, tokenizerMode: 'chars', derived: true, priors: { min: 198, max: 289 } },
  zh: { code: 'zh', unit: 'cpm', target: 240, ceiling: 258, tokenizerMode: 'chars', derived: false, priors: { min: 125, max: 182 } },
  th: { code: 'th', unit: 'cpm', target: 282, ceiling: 290, tokenizerMode: 'chars', derived: true, priors: { min: 147, max: 214 } },
  ko: { code: 'ko', unit: 'syl', target: 340, ceiling: 350, tokenizerMode: 'words', derived: true, priors: { min: 177, max: 258 }, hangulBlocks: true },
  ar: { code: 'ar', unit: 'syl', target: 330, ceiling: 360, tokenizerMode: 'words', derived: true, priors: { min: 172, max: 251 }, syllablesPerWord: 2.0 },
  tr: { code: 'tr', unit: 'syl', target: 340, ceiling: 350, tokenizerMode: 'words', derived: true, priors: { min: 177, max: 258 }, syllablesPerWord: 2.3 },
  hi: { code: 'hi', unit: 'syl', target: 240, ceiling: 247, tokenizerMode: 'words-marks', derived: true, priors: { min: 125, max: 182 }, syllablesPerWord: 1.5 },
  vi: { code: 'vi', unit: 'wpm', target: 280, ceiling: 290, tokenizerMode: 'words', derived: true, priors: { min: 146, max: 213 } },
  id: { code: 'id', unit: 'syl', target: 400, ceiling: 412, tokenizerMode: 'words', derived: true, priors: { min: 208, max: 304 }, syllablesPerWord: 1.5 },
  ms: { code: 'ms', unit: 'syl', target: 400, ceiling: 412, tokenizerMode: 'words', derived: true, priors: { min: 208, max: 304 }, syllablesPerWord: 1.5 },
  tl: { code: 'tl', unit: 'syl', target: 400, ceiling: 412, tokenizerMode: 'words', derived: true, priors: { min: 208, max: 304 }, syllablesPerWord: 1.5 },
  ru: { code: 'ru', unit: 'wpm', target: 168, ceiling: 185, tokenizerMode: 'words', derived: true, priors: { min: 87, max: 128 } },
  uk: { code: 'uk', unit: 'wpm', target: 168, ceiling: 185, tokenizerMode: 'words', derived: true, priors: { min: 87, max: 128 } },
  pl: { code: 'pl', unit: 'wpm', target: 185, ceiling: 200, tokenizerMode: 'words', derived: true, priors: { min: 96, max: 141 } },
  cs: { code: 'cs', unit: 'wpm', target: 185, ceiling: 200, tokenizerMode: 'words', derived: true, priors: { min: 96, max: 141 } },
  sr: { code: 'sr', unit: 'wpm', target: 185, ceiling: 200, tokenizerMode: 'words', derived: true, priors: { min: 96, max: 141 } },
};

/** Pill label suffixes per rate unit. */
export const UNIT_LABELS: Record<RateUnit, string> = {
  wpm: 'wpm',
  cpm: 'cpm',
  syl: 'syl/min',
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
