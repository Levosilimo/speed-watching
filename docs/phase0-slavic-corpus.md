# Phase 0 — Slavic caption-rate corpus (uk/pl/cs/sr, 2026-08)

Measured natural speech rates of 19 videos (uk 6, pl 7, cs 4, sr 2 probe)
with the POT-aware harness (scripts/measure-corpus.ts), extending the ru
corpus method to the Slavic languages the model ships. The batch exists to
correct uk's ru-copied talk band, give pl a verdict (its addendum was
underpowered at n=1 news), measure cs from nothing, and probe whether sr
has any YouTube ASR at all.

## Corpus

Every candidate was verified for the target ASR language at selection time
via the innertube player response (automatic_captions keyed by the
original-ASR `*-orig` track) before inclusion. Two uk candidates were
rejected for having no auto captions (`rbkT-6fFHSs`, `j3GDxh9OARQ`); cs
had no known IDs, so all four were picked by the same verification rule.

| lang | register | n | videoIds (channel, region) |
|---|---|---|---|
| uk | lecture | 3 | `jeF_L_Qxdl4`, `JaUQnACIk5A` (Грицак — «Історія України», UA), `cmRygm05WVU` (Karazin University, UA) |
| uk | talk | 3 | `NEDLxqo1ATs` (Маша Єфросиніна show, UA), `KKEsuCWyBro` (Бакалова interview, UA), `U0-GWXzrb7o` (Телебачення Торонто, UA) |
| pl | news | 2 | `eLi9wpqzT70`, `UU8R1ld14rk` (wPolsce24, PL) |
| pl | lecture | 3 | `Ixdj05Wn8qg` (Nowak, PL), `M5GnO-TgNq8` (Michalkiewicz, PL), `r-5Y1w7y6TU` (Zembrzuski, UKSW, PL) |
| pl | podcast | 2 | `oi55ii6B9sA`, `cgDLxMCj3EI` (Radio Naukowe, PL) |
| cs | news | 2 | `S32kCeB0B-k` (CNN Prima NEWS, CZ), `8HHLIPCJeW0` (iDNES, CZ) |
| cs | lecture | 2 | `e9xnLc6UOfQ` (CVUTFEL/ČVUT, CZ), `TY1Vo4Q_p3Y` (Hvězdárna Zlín, CZ) |
| sr | news | 2 (probe) | `NVqyA9_hks8` (N1 Srbija, RS), `OVbRSt95I7U` (RTS, RS) |

sr is not on YouTube's ASR language list, so its two videos are an
availability probe, not a data target: they document the structural fail
with evidence and change nothing in the model.

## Method

Identical to the ru corpus (docs/phase0-russian-corpus.md): load the watch
page, read `ytInitialPlayerResponse`, WEB capture via the player's signed
/api/timedtext intercept with the lang-aware ASR track pick (largest
word-timed capture across up to two re-pick cycles), ANDROID innertube
control as the fallback and the windows==segs parity anchor. The sr probe
videos ran through the same classification path.

Records: scripts/data/ru-corpus/ru-corpus.jsonl (same file, merged by
videoId). Summary: ru-corpus-summary.json.

## Per-video measurements

| videoId | lang | register | words | cues | unified wpm | in band* | parity | pauseBias |
|---|---|---|---|---|---|---|---|---|
| jeF_L_Qxdl4 | uk | lecture | 8783 | 1815 | 139.4 | yes | true | −56.7% |
| JaUQnACIk5A | uk | lecture | 32800 | 7692 | 130.5 | yes | true | −45.5% |
| cmRygm05WVU | uk | lecture | 7328 | 1890 | 103.7 | no | true | −157.1% |
| NEDLxqo1ATs | uk | talk | 27486 | 5419 | 150.3 | yes | true | −49.9% |
| KKEsuCWyBro | uk | talk | 26900 | 4726 | 170.2 | yes | true | −39.9% |
| U0-GWXzrb7o | uk | talk | 7374 | 1331 | 161.9 | yes | true | −33.1% |
| eLi9wpqzT70 | pl | news | 2807 | 717 | 128.2 | yes | true | −61.7% |
| UU8R1ld14rk | pl | news | 2067 | 515 | 137.3 | yes | true | −51.7% |
| Ixdj05Wn8qg | pl | lecture | 4081 | 1056 | 98.4 | yes | true | −115.5% |
| M5GnO-TgNq8 | pl | lecture | 5403 | 1337 | 104.9 | yes | true | −101.4% |
| r-5Y1w7y6TU | pl | lecture | 5969 | 1442 | 127.2 | yes | true | −66.7% |
| oi55ii6B9sA | pl | podcast | 5858 | 1156 | 146.2 | no | true | −42.6% |
| cgDLxMCj3EI | pl | podcast | 4751 | 953 | 135.7 | yes | true | −45.7% |
| S32kCeB0B-k | cs | news | 3290 | 744 | 103.7 | yes | true | −112.8% |
| 8HHLIPCJeW0 | cs | news | 107 | 24 | 153.7 | no | true | −36.1% |
| e9xnLc6UOfQ | cs | lecture | 15633 | 3083 | 125.2 | yes | true | −69.5% |
| TY1Vo4Q_p3Y | cs | lecture | 11176 | 2018 | 146.3 | no | true | −35.8% |
| NVqyA9_hks8 | sr | news | — | — | — | — | — | — |
| OVbRSt95I7U | sr | news | — | — | — | — | — | — |

\* Against the band in the current model (uk's corrected bands; pl/cs the
96–141 generic window 94.8–142.2). Word-timing coverage 79–85% per video.
Both sr videos: `no-track` from WEB and ANDROID (`no-caption-tracks` on
both paths), 0 caption tracks, 0 asr tracks.

## Gates

### uk

| gate | metric | result | threshold | verdict |
|---|---|---|---|---|
| G1 | word-timing availability, uk:asr videos | 6/6 web-ok any-path = 100% | ≥ 90% | **PASS** |
| G2 | per-register median vs band (corrected) | lecture 130.5 in 110–150, talk 161.9 in 140–180 | all | **PASS** |
| G3 | \|regex−icu\|/icu ≤ 0.10 per video | n=6, median 0.46%, max 0.83% | per video | **PASS** |
| G4 | windows==segs parity true | 6/6 | 100% (false = inspect) | **PASS** |
| G5 | median pauseBiasPct | −47.7% (n=6) | informational | — |

**The correction.** Against the ru-copied bands the uk gates failed exactly
where the ru batch's addendum said they would:

| register | n | median | ru-copied band (window) | vs ru-copied | corrected band |
|---|---|---|---|---|---|
| lecture | 3 | 130.5 | 95–135 (92–138) | in window (pass) | 110–150 |
| talk | 3 | 161.9 | 100–140 (96–144) | **above (fail)** | 140–180 |

The corrected bands are the measured median ± 20 wpm (the ru register-band
width), rounded to 5. They are measurement-derived, not independently
validated — the correction is the deliverable. The pre-correction fail
evidence also stands committed in the ru batch's ru-corpus-summary.json
(uk talk median 160.3, band 96–144, fail). news/podcast/explainer have no
uk data and keep the ru-copied bands; the generic band (120–160) is the
union mid of the uk bands, same rule as ru's.

Note the talk band top (180) equals the uk ceiling: uk interview content
measures at the safe zone, so the recommendation for uk talk rides ≈ 1.0×.
The uk target (168) and ceiling (180) stay `derived: true`.

### pl

| gate | metric | result | threshold | verdict |
|---|---|---|---|---|
| G1 | word-timing availability, pl:asr videos | 7/7 web-ok any-path = 100% | ≥ 90% | **PASS** |
| G2 | per-register median vs band | news 132.8, lecture 104.9, podcast 141.0 — all in 94.8–142.2 | all | **PASS** |
| G3 | \|regex−icu\|/icu ≤ 0.10 per video | n=7, median 0.03%, max 0.08% | per video | **PASS** |
| G4 | windows==segs parity true | 7/7 | 100% | **PASS** |
| G5 | median pauseBiasPct | −61.7% (n=7) | informational | — |

pl gets its real verdict: the ratio-scaled generic band 96–141 stands
validated (podcast median 141.0 just inside the window; `oi55ii6B9sA`
at 146.2 is the single out-of-band video). The 6.9 syl/s citation the
185 target rests on is untouched — the target stays derived.

### cs

| gate | metric | result | threshold | verdict |
|---|---|---|---|---|
| G1 | word-timing availability, cs:asr videos | 4/4 web-ok any-path = 100% | ≥ 90% | **PASS** |
| G2 | per-register median vs band | news 128.7, lecture 135.7 — in 94.8–142.2 | all | **PASS** |
| G3 | \|regex−icu\|/icu ≤ 0.10 per video | n=4, median 0.07%, max 0.11% | per video | **PASS** |
| G4 | windows==segs parity true | 4/4 | 100% | **PASS** |
| G5 | median pauseBiasPct | −52.8% (n=4) | informational | — |

cs measured from nothing: the 96–141 generic band stands validated
(Volín's 5.0–7.5 syl/s news norms corroborate; measured medians imply
~5.1–5.7 syl/s at ~2.1 syl/word — the low end of Volín's band, because
these are mixed lecture/news, not pure read news). `8HHLIPCJeW0` (iDNES,
153.7) and `TY1Vo4Q_p3Y` (Hvězdárna Zlín, 146.3) sit above the window;
the register medians stay inside.

### sr (probe)

| gate | metric | result | verdict |
|---|---|---|---|
| G1 | word-timing availability, sr:asr videos | 0/2 any-path — both `no-track` from WEB and ANDROID | **structural fail** |
| G2–G5 | — | not evaluated (no ASR-bearing videos) | — |

The probe confirms the structural fail with evidence: Serbian-spoken N1
and RTS videos serve zero caption tracks on both the WEB player response
and the ANDROID innertube player (`no-caption-tracks` on both paths). sr
is not on YouTube's ASR language list; no sr measurement is possible
without a tokenizer/ASR change (phase2 territory). sr stays as-is.

## Verdict

- **uk — corpus-validated with corrected bands** (G1 ∧ G2 ∧ G3 pass
  against the corrected bands; G4 clean, G5 informational). lib/languages.ts
  uk sets `priorsSource: 'corpus'`; lecture 110–150 and talk 140–180 are
  the measured bands; news/podcast/explainer stay ru-copied (unmeasured);
  generic 120–160.
- **pl — corpus-validated** (G1 ∧ G2 ∧ G3 pass; G4 clean). The 96–141
  generic band stands; `priorsSource: 'corpus'`.
- **cs — corpus-validated** (G1 ∧ G2 ∧ G3 pass; G4 clean). The 96–141
  generic band stands; `priorsSource: 'corpus'`.
- **sr — stays-derived**, probe recorded: no sr ASR exists on YouTube.
- **Targets and ceilings stay `derived: true` for all four** — a rate
  corpus measures speech rate, not comprehension of the safe zone; the ru
  verdict's boundary holds. uk 168/180, pl/cs/sr 185/200 unchanged.

## Honest failures

- **Preview races** (the ru batch's known failure mode): `JaUQnACIk5A`
  first captured 12 words (600 wpm artifact, parity false) and
  `UU8R1ld14rk` 29 words (177 wpm, parity false) — preview payloads after
  the CC-menu re-pick. Both re-measured to full payloads (32,800 and
  2,067 words, parity true) on a single retry; the final records use the
  full captures.
- **Slow-lecture outlier**: `cmRygm05WVU` (Karazin) measured 103.7 wpm
  with −157% pause bias — the most pause-heavy video of the batch — and
  sits below the corrected lecture band (2/3 of uk lecture videos in
  band, comparable to ru's 4/5).
- **Fast outliers above the window**: pl `oi55ii6B9sA` (146.2), cs
  `8HHLIPCJeW0` (153.7) and `TY1Vo4Q_p3Y` (146.3). Register medians stay
  inside; the single videos are recorded, not excluded.
- **sr probe**: both videos structural `no-track`, WEB and ANDROID
  agreeing — the documented evidence of the ASR gap.
- **No geo-blocks, pot-fails, manual-only, or wrong-lang videos** on
  uk/pl/cs: all 17 measured web-ok with the correct ASR language from the
  residential WSL2 egress.
- **Fixtures**: run with --no-fixtures; no new parity anchors. The ru
  anchor stays the only fixture (tests/fixtures/README.md provenance).
- **Summary band bookkeeping**: the committed summary reflects the final
  (corrected) bands; the pre-correction uk fail is preserved in the ru
  batch's committed summary and the comparison table above.

## Re-runs

`bun run scripts/measure-corpus.ts --lang=uk,pl,cs,sr` re-measures and
merges by videoId; a single video can be re-measured with `--video=ID`.
The summary file regenerates for every language named in --lang, so
include ru to keep its block (`--lang=ru,uk,pl,cs,sr`).
