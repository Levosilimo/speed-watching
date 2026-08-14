# Gap-index yield (skip-silence gate)

What fraction of a video's playing time is skippable by silence under the
honest caption-gap definition? This is the gate for the skip-silence design
(slow-through-pauses on caption-gap detection): the design goes ahead only
if the median engineered savings across the measured corpus ≥ 12%.

Measurement: `bun run scripts/gap-index-yield.ts` → `scripts/data/gap-yield/results.jsonl`.

## Definition

Gap index over the measured caption timeline — consecutive cue/word starts,
`gap = start[i+1] − start[i]`:

- **Gap** (counted): `gap ≥ 1 s` — the same convention `speechDurationSec`
  uses (lib/wpm.ts), shared not forked.
- **Skimmable** (seconds): only `gap ≥ 1.5 s`, counted as `gap − 0.5` each —
  the residual that survives a real detector (sub-gap edge slop at both
  boundaries + jump-cut recovery cost).
- **Series**: per-word starts when the payload carries word timing (≥ 2
  timed words), else cue starts. Word timing is the production convention
  (`speechDurationSec` input); bracket markers ([Music], [Applause]) carry no
  word offsets in these payloads, so they never enter the word series.
- **Denominator**: measured window = last cue/word end + 10 s tail margin
  (the detector stops at the last caption; the residual tail is not
  skippable). Window-relative savings, since no committed payload covers a
  full video (below).

## Data

The corpus records (`scripts/data/ru-corpus/ru-corpus.jsonl`, 96 records)
carry summary fields only — no raw timelines. The committed caption
payloads are truncated heads (20 events, ~30–60 s of the opening):
`scripts/data/web-rerun/web-*.json3` (21) and
`tests/fixtures/real/windows-asr-*-trunc.json` (4; 3 byte-identical to
web-rerun payloads, 1 unique). The full payloads actually captured during
the corpus runs (up to 379 KB) were never committed. Analysis is offline;
the browser corpus is not re-run.

| Corpus | Records | web-ok | parse-available | no-timeline |
|---|---|---|---|---|
| ru-corpus | 96 | 0 | 1 | 95 |
| web-rerun | 24 | 21 | 0 | 3 |
| **Total** | **120** | **21** | **1** | **98** |

The single parse-available timeline is the Russian ПостНаука lecture head
(`-rg9mV6DBl4`, fixture). The 3 web-rerun no-timeline records
(`8mAITcNt710`, `ycPr5-27vSI`, `nfWlot6h_JM`) had no payload saved.

## Results

Measured timelines: 22 (21 en + 1 ru). Savings are window-relative over the
truncated heads; per-video rows in `results.jsonl` also carry a
`cuesSeriesSavingsPct` column — what a cue-level detector would see on the
same window (the word series omits marker-led music gaps).

| Group | n | Median | p90 |
|---|---|---|---|
| **Overall** | **22** | **12.20%** | **59.68%** |
| register=explainer | 9 | 10.38% | 71.99% |
| register=lecture | 3 | 13.57% | 15.62% |
| register=music | 5 | 25.92% | 62.24% |
| register=news-comedy | 1 | 0.00% | 0.00% |
| register=talk | 4 | 14.67% | 21.35% |
| languageGroup=ru | 1 | 15.62% | 15.62% |
| languageGroup=slavic | 0 | — | — |
| languageGroup=captionless | 0 | — | — |
| languageGroup=en | 21 | 10.82% | 59.68% |
| Speech registers (excl. music) | 17 | 10.61% | 21.35% |

p90 is nearest-rank. High-p90 rows are caption-sparse payloads (music videos,
the `r6sGWTCMz2k` explainer head at 72%).

## Verdict

**GO — 12.20% median ≥ 12% threshold — by 0.2 pp, and only with the
music-register videos included.**

The margin is within noise and the speech content the feature targets does
not carry the gate on its own: excluding music, the median is 10.61% (NO-GO
at the same threshold). Three caveats bound the number:

1. **Head-window proxy.** Savings are measured over the first ~30–60 s of
   each video, not the whole video. Heads are gap-richer than bodies
   (intros, music leads), so 12.20% is likely an upper bound on whole-video
   savings.
2. **Target corpus unmeasured.** The ru-corpus (the languages skip-silence
   would serve) has 95 of 96 records without a timeline; slavic and
   captionless groups have zero measured timelines. The verdict rests on an
   en TED/explainer corpus.
3. **Music drives the pass.** Median 25.92% on music registers; speech
   registers median 10.61%. Skipping caption gaps in music videos skips the
   song, not silence.

Cue-level detection would see more than the word series reports (marker-led
music/applause gaps are absent from word timing), but a cue-level gap
detector is also the noisier design.

**Follow-up before the feature is built on this gate:** commit full-length
caption payloads for a sample of the ru-corpus (a 10-video ru/slavic slice
suffices for a median) and re-run the same script; treat the current verdict
as a preliminary GO with the speech-only number as the binding constraint.
