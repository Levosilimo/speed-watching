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
| ru | wpm | 168 | 180 | words | yes | 105–145 (per register, below) † |
| uk | wpm | 168 | 180 | words | yes | 120–160 (per register, below) † |
| pl | wpm | 185 | 200 | words | yes | 96–141 † |
| cs | wpm | 185 | 200 | words | yes | 96–141 † |
| sr | wpm | 185 | 200 | words | yes | 96–141 |

\* zh is marked derived:false only because its ceiling is
comprehension-measured; its target is derived.

† ru's, uk's, pl's and cs's priors are **corpus-measured** (2026-08,
docs/phase0-russian-corpus.md, docs/phase0-slavic-corpus.md); their
**targets and ceilings remain derived** (168/180, 185/200 — a rate corpus
measures speech rate, not comprehension of the safe zone).

Priors scale the English estimated-tier ratio (0.52–0.76 × target) to each
language's target — the same below-target relationship as the English
generic prior, pending per-language corpus measurement. **ru/uk/pl/cs are
the exception**: their priors are corpus-measured, not ratio-scaled (below).

## Slavic register priors

ru and uk carry a per-register prior table (`registerPriors` in
`lib/languages.ts`) used both as the estimated-tier prior per content type
and as `detectContentType`'s classification bands. ru's bands are the
Russian natural-rate norms — news and dictation 120–150 wpm,
conversational ~100–140, lecture ~95–135, explainer ~100–140 (Kazabeeva
2015 pedagogy norms; dictation and news readings at ~4.7–5.8 syl/s). The
old content-invariant 87–128 prior sat under every band, which under-
anchored every Russian estimated tier; the generic band is the union mid,
105–145.

The **ru bands are corpus-validated** (2026-08, phase0-russian-corpus): a
16-video ru:asr corpus measured per-register median unified rates of news
134.6, lecture 123.4, podcast 142.8, explainer 135.2 wpm — every median
inside its midpoint ± 20% window (news 108–162, lecture 92–138,
podcast/explainer 96–144). The Kazabeeva/Stepanova/Krivnova norms remain
as corroboration, not the source of the numbers.

The **uk lecture/talk bands are uk-measured** (2026-08,
phase0-slavic-corpus): a 6-video uk:asr corpus measured lecture median
130.5 and talk median 161.9 wpm. The talk median is ~20 wpm above the
ru-copied 100–140 band the addendum had already flagged (160.3 wpm); the
corrected bands are the measured median ± 20 wpm — lecture 110–150,
talk 140–180. uk's news/podcast/explainer registers are unmeasured and
keep the ru-copied bands; the generic band is the union mid of the uk
bands, 120–160.

| register | ru band (wpm) | uk band (wpm) |
|---|---|---|
| news | 120–150 | 120–150 (ru-copied, unmeasured) |
| podcast | 100–140 | 100–140 (ru-copied, unmeasured) |
| lecture | 95–135 | 110–150 (measured) |
| explainer | 100–140 | 100–140 (ru-copied, unmeasured) |
| talk | 100–140 | 140–180 (measured) |
| generic | 105–145 | 120–160 (union mid) |

The ru/uk ceiling sits at **180 wpm**: the Russian "fast" normative band
(~400 syl/min ≈ 174 wpm at ~2.3 syl/word) is the fastest rate pedagogy
expects an average listener to sustain, and 180 keeps ~3.5% headroom above
it. (The old 185 was ratio-derived; the nudge makes the ceiling
norm-grounded like the priors.) uk talk rides the ceiling: its measured
band tops out at 180, so interview content recommends ≈ 1.0×.

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
- **Channel rate memory** (YouTube only; `lib/channel-memory.ts`): a
  measured recommendation stores the channel's natural rate (keyed by
  `videoDetails.channelId`, author name as the fallback key). A later
  captionless video on the same channel, in the same language, seeds its
  estimated tier with that measured rate instead of the prior midpoint —
  the pill still labels it 'estimated' (the rate is a prior, not this
  video's measurement). The store is bounded (50 channels, LRU) and
  lives in `chrome.storage.local` under `sw.channelRates`; the generic
  path (`generic.content.ts`) never touches it.
- The pause-diluted articulatory ceiling scales with the language ceiling
  (`ceiling / (1 − P_STIMULUS)`); the pill's rate label carries the unit
  (`≈ 240 cpm`, `≈ 340 syl/min`, `≈ 380 morae/min`).

## Interface localization

- All ~55 UI strings live in `lib/i18n.ts` (English) + `lib/i18n-ru.ts`
  (Russian), keyed by a shared `I18nKey`; the ru map is type-checked to
  cover every en key, and a completeness test re-asserts it at runtime.
- Locale resolution: `settings.uiLanguage` ('auto' default) wins when set
  to 'ru'/'en'; 'auto' (or unset) follows the browser UI language
  (`navigator.language`, 'ru'-prefix → Russian). The pill resolves it at
  creation through the bridge `settings:get` and falls back to the browser
  language when the fetch fails; the options page reads `SettingsStore`
  directly.
- ru unit labels: the ru model is word-unit, so wpm renders **слов/мин**
  — not a transliteration — and the non-word units transliterate
  consistently: симв/мин, слогов/мин, мор/мин.
- The recommendation engine stays English: `TIER_LABELS`/`UNIT_LABELS`
  remain the canonical data values, and the pill localizes at render time
  (en renders byte-identical to the labels `recommend()` builds). The
  pill's ru line follows Russian typography: decimal comma and × (1,55×).

## Multimedia ceiling modulation

- `MULTIMEDIA_CEILING_FACTOR` (1.05, lecture/explainer) and
  `PODCAST_CEILING_FACTOR` (0.95, podcast) modulate the **warning
  ceilings** — above-zone and pause-diluted articulatory — by content
  type, per Chen et al. 2024: slide-heavy visuals offload comprehension
  processing at speed, audio-only podcasts get no such offload. The
  factors never touch the target or the multiplier bounds; every other
  content type rides at 1.0.

## Deferred / known limits

- **Corpus measurement** — ru/uk/pl/cs natural-rate priors are now
  corpus-measured (2026-08, phase0-russian-corpus,
  phase0-slavic-corpus); every other language's targets and priors remain
  derived. The harness plan for further per-language corpora is deferred;
  the `logWpm` measurement hooks remain word-based and English-labeled
  until a harness runs per language.
- **generic.content.ts** stays on the English/default path by design.
- The options-page target slider is wpm-labeled; a user target set there
  applies as a raw number in the track language's unit.
- zh's target 240 is derived; only its 258 cpm ceiling is measured.
