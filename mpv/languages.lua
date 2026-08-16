-- Per-language speech-rate model, mirror of lib/languages.ts.
-- English 250 wpm / 275 wpm anchor the ~39 bits/s information-rate ceiling
-- (Coupé et al. 2019); every other entry is a derived estimate. See
-- lib/languages.ts for the sourcing and the ru/uk register bands (gathered
-- Russian rate norms, Kazabeeva 2015). Keep the two tables in sync.

local languages = {
  en = { code = "en", unit = "wpm", target = 250, ceiling = 275, tokenizer = "words", priors = { min = 130, max = 190 } },
  es = { code = "es", unit = "wpm", target = 170, ceiling = 175, tokenizer = "words", priors = { min = 88, max = 129 } },
  pt = { code = "pt", unit = "wpm", target = 165, ceiling = 167, tokenizer = "words", priors = { min = 86, max = 125 } },
  fr = { code = "fr", unit = "wpm", target = 250, ceiling = 253, tokenizer = "words", priors = { min = 130, max = 190 } },
  de = { code = "de", unit = "wpm", target = 175, ceiling = 181, tokenizer = "words", priors = { min = 91, max = 133 } },
  it = { code = "it", unit = "wpm", target = 180, ceiling = 184, tokenizer = "words", priors = { min = 94, max = 137 } },
  ja = { code = "ja", unit = "mora", target = 470, ceiling = 495, tokenizer = "mora", priors = { min = 395, max = 435 } },
  zh = { code = "zh", unit = "cpm", target = 240, ceiling = 258, tokenizer = "chars", priors = { min = 125, max = 182 } },
  th = { code = "th", unit = "cpm", target = 282, ceiling = 290, tokenizer = "chars", priors = { min = 505, max = 545 } },
  ko = { code = "ko", unit = "syl", target = 340, ceiling = 350, tokenizer = "words", priors = { min = 305, max = 345 }, hangul_blocks = true },
  ar = { code = "ar", unit = "syl", target = 330, ceiling = 360, tokenizer = "words", priors = { min = 195, max = 235 }, syllables_per_word = 2.0 },
  tr = { code = "tr", unit = "syl", target = 340, ceiling = 350, tokenizer = "vowels", priors = { min = 177, max = 258 } },
  hi = { code = "hi", unit = "syl", target = 240, ceiling = 247, tokenizer = "vowels", priors = { min = 125, max = 182 } },
  vi = { code = "vi", unit = "wpm", target = 280, ceiling = 290, tokenizer = "words", priors = { min = 185, max = 225 } },
  id = { code = "id", unit = "syl", target = 400, ceiling = 412, tokenizer = "words", priors = { min = 200, max = 240 }, syllables_per_word = 1.5 },
  ms = { code = "ms", unit = "syl", target = 400, ceiling = 412, tokenizer = "words", priors = { min = 200, max = 240 }, syllables_per_word = 1.5 },
  tl = { code = "tl", unit = "syl", target = 400, ceiling = 412, tokenizer = "words", priors = { min = 200, max = 240 }, syllables_per_word = 1.5 },
  -- ru's bands are the Kazabeeva 2015 pedagogy norms (corpus-validated in
  -- lib); uk's lecture/talk are its own 2026-08 measurements, the rest
  -- ru-copied; the generic band is the union mid.
  ru = {
    code = "ru", unit = "wpm", target = 168, ceiling = 180, tokenizer = "words",
    priors = { min = 105, max = 145 },
    register_priors = {
      news = { min = 120, max = 150 },
      podcast = { min = 100, max = 140 },
      lecture = { min = 95, max = 135 },
      explainer = { min = 100, max = 140 },
      talk = { min = 100, max = 140 },
      generic = { min = 105, max = 145 },
    },
  },
  uk = {
    code = "uk", unit = "wpm", target = 168, ceiling = 180, tokenizer = "words",
    priors = { min = 120, max = 160 },
    register_priors = {
      news = { min = 120, max = 150 },
      podcast = { min = 100, max = 140 },
      lecture = { min = 110, max = 150 },
      explainer = { min = 100, max = 140 },
      talk = { min = 140, max = 180 },
      generic = { min = 120, max = 160 },
    },
  },
  pl = { code = "pl", unit = "wpm", target = 185, ceiling = 200, tokenizer = "words", priors = { min = 96, max = 141 } },
  cs = { code = "cs", unit = "wpm", target = 185, ceiling = 200, tokenizer = "words", priors = { min = 96, max = 141 } },
  sr = { code = "sr", unit = "wpm", target = 185, ceiling = 200, tokenizer = "words", priors = { min = 96, max = 141 } },
}

-- Pill label suffixes per rate unit (lib/languages.ts UNIT_LABELS).
languages.UNIT_LABELS = { wpm = "wpm", cpm = "cpm", syl = "syl/min", mora = "morae/min" }

return languages
