# Core Library

Five `lib/` modules form the surface-free measurement core: `wpm`,
`tokenizer`, `captions`, `languages`, and `recommend`. They import only
each other, never `browser.*` or DOM globals, so they run anywhere
TypeScript runs. `tests/core-surface.test.ts` imports all five in the node
environment and exercises one pure path per module; the extension's
chrome-bound modules (`messaging`, `settings`, `music`, `heuristics`,
`wpm-provider`, the entrypoints) live outside this surface.

## Zero-runtime-deps claim

`lib/wpm.ts` imports only types (`Segment`, `LanguageModel`, `RateTier`)
and functions from `lib/tokenizer.ts`; the other four modules import only
each other. No module in the set references `browser`, `chrome`,
`document`, or `window` at import time or in its functions. The claim is
enforced by the core-surface test: it runs in the plain node environment
(no happy-dom, no chrome mock) and would fail at import time on any leak.

## Export surface

| Module | Exports |
|---|---|
| `lib/wpm.ts` | `countWords`, `totalWords`, `wordLevelWpm`, `cueSpanSec`, `cueLevelWpm`, `correctedCueLevelWpm`, `manualCueRate`, `filteredTokensOverTrimmedSpan`, `asrTierInputs` |
| `lib/tokenizer.ts` | `countWordTokens`, `countMorae`, `countTurkishVowels`, `countDevanagariSyllables`, `countVowelNuclei`, `countHangulSyllables`, `isBracketMarker`, `hasNoteSymbol`, `TokenizerMode` |
| `lib/captions.ts` | `Segment`, `ParsedCaptions`, `parseYouTubeJson3` |
| `lib/languages.ts` | `LanguageModel`, `RateUnit`, `LANGUAGES`, `UNIT_LABELS`, `normalizeLanguageCode`, `resolveLanguage` |
| `lib/recommend.ts` | `recommend`, `Recommendation`, `RecommendationMode`, `RateTier`, `TARGET_WPM`, `SAFE_ZONE_CEILING_WPM`, `ROUNDING_STEP`, `MANUAL_CUE_CLAMP`, `SLOW_DOWN_FLOOR`, `TIER_LABELS` |

`lib/music.ts`, `lib/heuristics.ts`, and `lib/wpm-provider.ts` are
chrome-free too but depend on the core set; the measured-rate provider
answer assembly (`buildWpmResponse`) is importable standalone.

## The language table is data

`lib/languages.ts` exports `LANGUAGES`, a plain record keyed by normalized
caption-track code — the porting target for a standalone consumer. Columns
per model:

| Field | Meaning |
|---|---|
| `code` | Normalized language code (lowercase, region stripped) |
| `unit` | Rate unit: `wpm`, `cpm` (characters/min), `syl` (syllables/min), `mora` (morae/min) |
| `target` | Recommended presentation rate in `unit` |
| `ceiling` | Safe-zone ceiling in `unit`; above it the recommendation warns |
| `tokenizerMode` | Tokenizer strategy: `words`, `chars`, `mora`, `vowels` |
| `derived` | `false` for measured targets (en, zh), `true` for derived estimates |
| `priors` | Estimated-tier natural-rate range in `unit` |

English (250 wpm target, 275 ceiling) anchors the ~39 bits/s information
rate ceiling; every other target scales that ceiling by the language's
syllabic rate and word structure (documented in the module header).

## Porting notes

**mpv Lua.** The per-language model is the only dependency a port needs:
`recommend` is `multiplier = clamp(round(target / naturalRate, 0.05), 0.5,
platformMax)` plus the mode rules (music never recommends, unreachable when
even `platformMax` cannot reach the target, warning above the ceiling). A
script that reads the subtitle stream, tokenizes with the language's
`tokenizerMode`, and counts words per minute over the span from the first
to the last token start gets the same `naturalRate`; feeding the table's
`target`/`ceiling` and the player's max speed yields the same multiplier.

**Userscript.** `tokenizer.ts` and `languages.ts` are dependency-free
enough to inline; `captions.ts` has no imports at all. `LANGUAGES` is the
single source of truth for the unit — a rate measured in `morae/min` must
not be compared against a wpm target. The VTT parser used by the generic
matcher lives in `lib/captions-harvest.ts` and needs a small host shim.

**The measured-rate provider.** `docs/provider-integration.md` describes
how a browser extension consumes the rate over `wpm:get` instead of
reimplementing the measurement.
