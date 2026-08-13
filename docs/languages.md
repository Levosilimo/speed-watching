# Language-aware rate model (v1.0)

The extension measures a caption track's natural speech rate and targets a
safe zone in that language's rate unit. The English model is measured; every
other language's target and ceiling is a **derived estimate** built on the
info-rate frame — none are comprehension-measured except zh's ceiling.

## The frame

The English 250 wpm target / 275 wpm ceiling anchor the ~39 bits/s
information-rate ceiling (Coupé et al. 2019: 250 wpm × 1.5 syl/word ×
6.3 bits/syll ≈ 39.4 bits/s). A non-English target scales that ceiling by the
language's syllabic rate and word structure:

- **word-unit (wpm)** — English wpm scaled by syllables per word vs
  English 1.55: ru/uk ~2.3 → 168, pl/cs/sr ~2.1 → 185 (sourced syllabic
  rates: ru 5.31 syl/s, pl 6.9 syl/s, sr 7.08 syl/s), es/pt/it short-word
  Romance → 165–180, fr dense short words ≈ English → 250, de compounding
  undercounts token runs ~25–30 % → 0.7 × English → 175.
- **char-unit (cpm)** — zh 240–258 cpm, where the 258 ceiling
  (Lee & Chan, 4.3 char/s) is the **only comprehension-measured ceiling in
  the set**; th ~282 cpm derived.
- **mora-unit (morae/min)** — ja 380 target / 400 ceiling, in the same
  band as the old char estimate but measured by the mora estimator: each
  kana code point = 1 mora (incl. ー and っ), each kanji ≈ 1.85 morae
  (on-yomi-dominant average). The estimator lands within ±5–8% of a true
  analyzer — inside the ±10% band that chars-mode misses (kanji carry
  ~1.8–2.0 morae per character, so grapheme counts understate morae
  ~25–35% and would over-recommend the multiplier).
- **syllable-unit (syl/min)** — measured speech syllabic rates: ko/tr
  330–350, ar 300–360 (low confidence), hi 240 (6.55 syl/s class), id/ms
  ~400 (≈ 267 wpm at 1.5 syl/word — the English band with a small lift),
  tl estimated like id.

Ceilings on target-only entries apply the ≈1.03 target:ceiling ratio of the
researched pairs. `syllablesPerWord` factors (ar 2.0, id/ms/tl 1.5 — tr's
2.3 and hi's 1.5 were retired when the vowel-nucleus counters replaced
them) are typological approximations, not measurements; the recommended
multiplier is factor-invariant (target and measured rate share the unit),
so only the displayed rate depends on them. ko counts Hangul syllable
blocks directly (each block is exactly one syllable), tr counts Turkish
vowel letters (one vowel per syllable), hi counts Devanagari vowel nuclei.

## Table

| code | unit | target | ceiling | tokenizer mode | derived | priors (est. tier) |
|---|---|---|---|---|---|---|
| en | wpm | 250 | 275 | words | no | 130–190 |
| es | wpm | 170 | 175 | words | yes | 88–129 |
| it | wpm | 180 | 184 | words | yes | 94–137 |
| pt | wpm | 165 | 167 | words | yes | 86–125 |
| fr | wpm | 250 | 253 | words | yes | 130–190 |
| de | wpm | 175 | 181 | words | yes | 91–133 |
| ja | mora/min | 380 | 400 | mora | yes | 198–289 |
| zh | cpm | 240 | 258 | chars | no* | 125–182 |
| th | cpm | 282 | 290 | chars | yes | 147–214 |
| ko | syl/min | 340 | 350 | words (+Hangul blocks) | yes | 177–258 |
| ar | syl/min | 330 | 360 | words | yes | 172–251 |
| tr | syl/min | 340 | 350 | vowels | yes | 177–258 |
| hi | syl/min | 240 | 247 | vowels | yes | 125–182 |
| vi | wpm | 280 | 290 | words | yes | 146–213 |
| id | syl/min | 400 | 412 | words | yes | 208–304 |
| ms | syl/min | 400 | 412 | words | yes | 208–304 |
| tl | syl/min | 400 | 412 | words | yes | 208–304 |
| ru | wpm | 168 | 185 | words | yes | 87–128 |
| uk | wpm | 168 | 185 | words | yes | 87–128 |
| pl | wpm | 185 | 200 | words | yes | 96–141 |
| cs | wpm | 185 | 200 | words | yes | 96–141 |
| sr | wpm | 185 | 200 | words | yes | 96–141 |

\* zh is marked derived:false only because its ceiling is
comprehension-measured; its target is derived.

Priors scale the English estimated-tier ratio (0.52–0.76 × target) to each
language's target — the same below-target relationship as the English
generic prior, pending per-language corpus measurement.

## Tokenizer modes

`countWordTokens(text, mode)` in `lib/tokenizer.ts`:

- **words** (default) — maximal `[\p{L}\p{N}]` runs. English and every
  space-delimited script; verified 1x on ar (cursive), vi/id/ms/tl,
  Cyrillic/Latin diacritics (ru/uk/pl/cs/sr), accented Latin (es/pt/fr/de/it).
- **words-marks** — adds `\p{M}` to the run so Devanagari matras/viramas stay
  inside their word (plain runs fragment Hindi ~1.5x). Retained for
  compatibility; hi now counts vowel nuclei instead.
- **chars** — grapheme count minus whitespace/punctuation/symbols, via
  `Intl.Segmenter` (code-point spread fallback). Grapheme segmentation keeps
  Thai tone marks and Devanagari combining marks in their base character.
  zh/th use it: their word tier is broken (no spaces → one token per
  sentence), so the tokens *are* characters.
- **mora** — Japanese mora estimate: kana code points (U+3040–309F,
  U+30A0–30FF) count 1 each (incl. ー, っ), kanji (U+4E00–9FFF) count 1.85
  each, everything else is skipped. Only ja uses it; expected ±5–8% of a
  true analyzer (see the mora-unit bullet above).
- **vowels** — vowel-nucleus counting, script resolved per language in
  `unitTokens`: tr counts Turkish vowel letters (a e ı i o ö u ü); hi counts
  Devanagari nuclei — consonants-with-vowel plus standalone vowel letters,
  where a halant (्) removes the preceding consonant's vowel and a
  word-final consonant loses its schwa (Hindi's regular final-schwa
  deletion). Residual deviation: epenthetic schwas inside halant clusters
  (नमस्ते counts 2, spoken 3) — within ±10%.

Music detection (`isBracketMarker`, `hasNoteSymbol`) is mode-independent and
keeps working in every mode.

## The gate

- Videos default to the language model's own target — en 250 wpm
  (measured), every other language its **derived estimate** (ja 380
  morae/min, de 175 wpm, …). An explicit target set on the options slider
  overrides it, applied as a raw number in the language's unit.
- Non-English word-tier content is measured with the language-appropriate
  target; ja uses the mora path, zh/th the char path; tr/hi count vowel
  nuclei; the rest word-count with per-language targets.
- The estimated tier (no usable captions) uses the language-aware priors
  when the track language is known; unmapped languages and English keep the
  existing content-type anchors / generic prior.
- The pause-diluted articulatory ceiling scales with the language ceiling
  (`ceiling / (1 − P_STIMULUS)`); the pill's rate label carries the unit
  (`≈ 240 cpm`, `≈ 340 syl/min`, `≈ 380 morae/min`).

## Deferred / known limits

- **Corpus measurement** — the per-language targets are derived, not
  measured. The harness validation plan (per-language natural-rate corpus,
  comparing measured rates against the priors and targets) is deferred; the
  `logWpm` measurement hooks remain word-based and English-labeled until the
  harness runs per language.
- **generic.content.ts** stays on the English/default path by design.
- The options-page target slider is wpm-labeled; a user target set there
  applies as a raw number in the track language's unit.
- zh's target 240 is derived; only its 258 cpm ceiling is measured.
