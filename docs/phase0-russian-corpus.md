# Phase 0 — Russian caption-rate corpus (ru-corpus, 2026-08)

Measured natural speech rates of 16 ru:asr YouTube videos with the POT-aware
harness (scripts/measure-corpus.ts), validating the ru register priors in
lib/languages.ts. Corpus spec: .slim/deepwork/specs/ru-corpus.md.

## Corpus

All 16 videos from the spec table (the spec header says "15"; the table
lists 16 — all measured, none substituted):

| register | count | videoIds |
|---|---|---|
| lecture | 5 | `-rg9mV6DBl4` (ПостНаука), `0qlgd8HLn_M` (ПостНаука), `uxkBZvVVoog` (ПостНаука), `SW_UCzFO7X0` (CS50 ru), `dVZrHGNGvb0` (Лекториум) |
| podcast | 3 | `cP0J4no6xqo` (Петров), `zV7lrWumc7U`, `KUKjD4BB6_8` (Зверева) |
| news | 3 | `HVYYCUlKh3U` (НТВ), `U58X5TpyspE` (РБК), `oMR0qaxGgwY` (РБК) |
| explainer | 3 | `6K2nWU-ARfU`, `6pc5m7BDm6I`, `g174qjV_R8w` (Научпок) |
| music | 2 | `gOygVzLWwmo` (ARTIK&ASTI), `l3QdCo4Z-98` (5УТРА) |

No fallback-pool substitution was needed: all 16 measured web-ok on the
primary list. The spec's fallback pools (same register, verified ru:asr)
are embedded in the runner as substitution suggestions on structural
failures.

## Method

Per video (scripts/measure-corpus.ts + measure-capture.ts +
measure-analysis.ts):

1. Load the watch page, read `ytInitialPlayerResponse` — track list, asr
   language codes, playability status.
2. WEB capture: toggle captions on, intercept the player's own signed
   /api/timedtext request (the only WEB path carrying a valid POT), then
   re-pick the ASR track from the CC menu with the lang-aware pick
   (`pickAsrTrackFromMenu(page, 'ru')`: auto-generated/`автомат`/`(asr)`
   first, `русск|russian` before the catch-all). The first response to a
   re-pick is often a ~22 s preview payload; the runner waits for the
   largest word-timed capture across up to two re-pick cycles.
3. ANDROID innertube control (segs layout, lang-preferred track) as the
   any-path fallback and the windows==segs parity anchor.
4. Classification: `web-ok` (words>0 & cues>0 on the ru ASR track),
   `pot-fail`, `parse-fail`, `no-track`, `manual-only` (no ru ASR),
   `wrong-lang` (ASR exists, languageCode != ru — excluded from the ru
   denominator), `geo-block`. pot-fail and geo-block get one fresh-session
   retry, then stay structural.
5. Per video: unifiedRate (presentation rate, filteredTokensOverTrimmedSpan
   over cues), wordAccurateRate (pause-excluded), pauseBiasPct, coveragePct
   (timed-word tokens / cue text tokens), count accuracy
   (countWordTokens vs Intl.Segmenter over joined non-marker cue text),
   band membership (midpoint ± 20%), detectContentType expected-vs-actual,
   windows==segs parity (WEB vs ANDROID).

Records: scripts/data/ru-corpus/ru-corpus.jsonl (spec record shape plus
`language`, harness mirrors). Summary: ru-corpus-summary.json.

## Per-video measurements (ru)

| videoId | register | words | cues | unified wpm | in ±20% window | detect actual |
|---|---|---|---|---|---|---|
| -rg9mV6DBl4 | lecture | 12953 | 3130 | 122.8 | yes | generic |
| 0qlgd8HLn_M | lecture | 18868 | 4515 | 125.6 | yes | generic |
| uxkBZvVVoog | lecture | 19800 | 4161 | 142.9 | no | news |
| SW_UCzFO7X0 | lecture | 3361 | 755 | 92.9 | yes | generic |
| dVZrHGNGvb0 | lecture | 7820 | 1732 | 123.4 | yes | generic |
| cP0J4no6xqo | podcast | 6065 | 1445 | 113.3 | yes | generic |
| zV7lrWumc7U | podcast | 12824 | 2501 | 142.8 | yes | news |
| KUKjD4BB6_8 | podcast | 15707 | 3006 | 158.3 | no | generic |
| HVYYCUlKh3U | news | 3062 | 801 | 131.3 | yes | generic |
| U58X5TpyspE | news | 2094 | 466 | 134.6 | yes | news |
| oMR0qaxGgwY | news | 5231 | 1167 | 139.4 | yes | news |
| 6K2nWU-ARfU | explainer | 562 | 130 | 135.2 | yes | news |
| 6pc5m7BDm6I | explainer | 585 | 144 | 132.3 | yes | news |
| g174qjV_R8w | explainer | 428 | 104 | 135.9 | yes | news |
| gOygVzLWwmo | music | 220 | 45 | 102.1 | n/a (no band) | generic |
| l3QdCo4Z-98 | music | 293 | 52 | 133.0 | n/a (no band) | news |

All 16: web-ok, ru ASR track, wordsParity and cuesParity true (WEB windows
vs ANDROID segs). Word-timing coverage 79–85% per video.

## Gates

| gate | metric | result | threshold | verdict |
|---|---|---|---|---|
| G1 | word-timing availability, ru:asr videos | 16/16 web-ok any-path = 100% (web-ok 16/16) | ≥ 90% | **PASS** |
| G2 | per-register median unifiedRate in band (≥2 videos per register) | 4/4 registers in window | all | **PASS** |
| G3 | \|regex−icu\|/icu ≤ 0.10 per video, non-lyric ru text | n=14, median 0.03%, max 0.20% | per video | **PASS** |
| G4 | windows==segs parity true | 16/16 | 100% (false = inspect) | **PASS** |
| G5 | median pauseBiasPct (music excluded) | −57.1% (n=14) | informational | — |

G1 compares against the en baseline 94.1% WEB / 100% any-path: ru measured
100% on both.

### G2 — per-register median vs band

| register | n | median wpm | ±20% window (mid) | registerPriors | within window | status |
|---|---|---|---|---|---|---|
| news | 3 | 134.6 | 108–162 (135) | 120–150 | 3/3 | pass |
| lecture | 5 | 123.4 | 92–138 (115) | 95–135 | 4/5 | pass |
| podcast | 3 | 142.8 | 96–144 (120) | 100–140 | 2/3 | pass |
| explainer | 3 | 135.2 | 96–144 (120) | 100–140 | 3/3 | pass |
| music | 2 | 117.5 | — (no band) | — | — | no-band |

The podcast median (142.8) sits 2 wpm above the registerPriors band top
(140) but inside the ±20% gate window — the bands are validated as priors,
not renumbered. The secondary per-video within-window fraction is 67–100%
per register (≥ 0.60 where the spec requires it).

### G5 — pause bias

Median pauseBiasPct −57.1% over 14 ru speech videos (music excluded): the
presentation rate runs ~57% below the pause-excluded articulatory rate
(range −38% to −116%; SW_UCzFO7X0, the CS50 ru lecture, is the most
pause-heavy). The en re-run corpus measured −44.8% median — Russian ASR
cue boundaries fall at longer pauses. Informational; the unified rule stays
the presentation-rate rule the safe zone is defined on.

## Auto-detect accuracy (informational)

8×8 confusion matrix, expected (a-priori register) × actual
(detectContentType over the measured signal; music detection has
precedence):

| expected \ actual | news | generic |
|---|---|---|
| news | 2 | 1 |
| lecture | 1 | 4 |
| podcast | 1 | 2 |
| explainer | 3 | 0 |
| music | 1 | 1 |

Mid-band collapse, as specified: podcast/explainer/talk share the 100–140
band, so they are one candidate for the band-margin rule and the rate lands
`generic` when closest to their shared midpoint (podcast 2/3, lecture 4/5).
The explainer videos measured 132–136 wpm — closer to news's 135 midpoint
than to the mid-band 120, and they pass the news pause profile (short cues,
pauseShare ≤ 0.25) — so they resolve to `news`. Lectures resolve `generic`
unless the pause profile confirms lecture (pauseShare ≥ 0.3), which none
did. Interpretation stands as specced: the matrix answers "does the
measured rate fall in the register's band", not "does detection reproduce
the label". Detection is never used to anchor the prior — prior lookup uses
the resolved type only after measurement.

## uk/pl addendum (same runner, language field)

All 8 videos measured web-ok with the correct ASR language (the uk caveat —
uk-topic channels broadcasting ru:asr — did not trigger on this sample).

| lang | register | n | median wpm | window | per-video rates | status |
|---|---|---|---|---|---|---|
| uk | lecture | 2 | 135.0 | 92–138 | 139.4, 130.5 | in window |
| uk | talk | 2 | 160.3 | 96–144 | 150.3, 170.2 | above window |
| pl | news | 1 | 128.2 | 95–142 | 128.2 | underpowered (n<2) |
| pl | lecture | 3 | 104.9 | 95–142 | 98.4, 104.9, 127.2 | in window |

uk's talk videos (two interview shows) measure well above the ru-copied
100–140 band; uk G2 fails on that register. uk/pl stay derived with the
ru-copied priors — the addendum improves the ratio basis (measured rates
exist) but changes nothing. pl's window comes from the generic priors
(96–141, pl has no registerPriors); the news register is underpowered at
n=1, so pl gets no verdict. uk/pl pause-bias medians: uk −47.7% (n=4),
pl −84.1% (n=4, long pauses between pl lecture segments).

## Verdict

**ru registerPriors → corpus-validated** (G1 ∧ G2 ∧ G3 all pass; G4 clean,
G5 informational). lib/languages.ts ru entry sets `priorsSource: 'corpus'`;
the Kazabeeva/Stepanova/Krivnova norms stay as corroboration. The ru
**target (168) and ceiling (180) remain `derived: true`** — a rate corpus
measures speech rate, not comprehension of the safe zone; flipping them
would overclaim. Priors measured; target/ceiling derived. uk/pl: unchanged
(derived, ru-copied priors).

## Honest failures

- **Spec count**: header says 15 videos, table lists 16; all 16 measured.
- **Degraded preview captures**: after a CC-menu track re-pick the player
  first serves a ~22 s preview payload (a few KB); the full transcript
  lands on a follow-up request. Early runs captured previews for
  0qlgd8HLn_M (34 words), JaUQnACIk5A (34, then 10 words), l3QdCo4Z-98
  (4 words), and their parity falses were artifacts of the preview, not
  layout disagreements. Fixed in measure-capture.ts: prefer the largest
  word-timed capture across up to two re-pick cycles; final run is
  24/24 full payloads with parity true.
- **Music lyric ASR**: l3QdCo4Z-98's ASR text wobbles between captures
  (293 vs 305 words across runs) — lyric tracks are excluded from G3/G5
  and have no band; the wobble is recorded, not papered over.
- **No geo-blocks, pot-fails, manual-only, or wrong-lang videos**: all 16
  ru videos served ru ASR from the residential WSL2 egress; the fallback
  pools were unused.
- **Fixture provenance**: tests/fixtures/README.md carries one ru parity
  anchor — windows-asr--rg9mV6DBl4-trunc.json, captured 2026-08-14,
  2,023,524 → 3,726 bytes, truncated to the first 20 events. Copyright
  stays with the creators; the full run used --no-fixtures.

## Re-runs

`bun run scripts/measure-corpus.ts --lang=ru` re-measures and merges by
videoId; a single video can be re-measured with `--video=ID`. The runner
prints the fallback-pool substitution list on structural failures.
