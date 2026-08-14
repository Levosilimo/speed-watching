# Gap-index yield (skip-silence gate)

What fraction of a video's playing time is skippable by silence under the
honest caption-gap definition? This is the gate for the skip-silence design
(slow-through-pauses on caption-gap detection): the design goes ahead only
if the median engineered savings across the measured corpus ≥ 12%.

Measurement: `bun run scripts/gap-index-yield.ts` → `scripts/data/gap-yield/results.jsonl`.
Whole-video re-measurement on committed full timelines: `bun run
scripts/gap-index-yield-full.ts` → `scripts/data/gap-yield/full-results.jsonl`
(see Re-run below).

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
  skippable). Window-relative savings — the first pass's committed payloads
  are truncated heads; the re-run (below) switches to the whole video as
  the denominator.

## Data

The corpus records (`scripts/data/ru-corpus/ru-corpus.jsonl`, 96 records)
carry summary fields only — no raw timelines. The committed caption
payloads are truncated heads (20 events, ~30–60 s of the opening):
`scripts/data/web-rerun/web-*.json3` (21) and
`tests/fixtures/real/windows-asr-*-trunc.json` (4; 3 byte-identical to
web-rerun payloads, 1 unique). The full payloads actually captured during
the corpus runs (up to ~3.8 MB) were never committed. Analysis is offline;
no analysis step touches the browser. The re-run below commits the production
parseYouTubeJson3 output (words + cues, whole video) for a 10-video slice
as `scripts/data/gap-full/*.json` — those records are still `no-timeline`
for the head-window analysis, which does not read the gap-full sidecars.

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

**Follow-up — executed 2026-08-14 (wt-gapfull).** Full-length caption
timelines for a 10-video ru/slavic slice were committed and re-measured
whole-video (see Re-run below). The gate holds on full-length timelines:
median 15.07% ≥ 12% on the speech-only (words) series, with no music
register in the slice. **Decision: GO for the skip-silence build, on the
speech-only number.**

## Re-run: whole-video savings (2026-08-14)

The first pass measured truncated heads because only heads were committed.
This pass re-captured a 10-video slice of the target corpus (ru 3, uk 2,
pl 3, cs 2 — lecture 4, news 3, podcast 2, talk 1; all previously web-ok
with word timing) and committed the full timelines as the production
parseYouTubeJson3 output (`scripts/data/gap-full/*.json`, provenance README
in that dir). Analysis: `bun run scripts/gap-index-yield-full.ts` →
`scripts/data/gap-yield/full-results.jsonl`.

Savings are whole-video: skimmableSec = Σ(gap ≥ 1.5 s − 0.5 s) over the full
duration, ÷ the player's `lengthSeconds`. The 1 s gap convention and the
1.5/0.5 skimmable rule are the first pass's — shared, not forked. The words
series is speech-only (bracket markers carry no word offsets); the cues
series includes marker-led gaps.

| videoId | lang:register | duration | skimmable | savings | cues series |
|---|---|---|---|---|---|
| -rg9mV6DBl4 | ru:lecture | 7936 s | 1152 s | 14.52% | 78.89% |
| e9xnLc6UOfQ | cs:lecture | 8983 s | 1569 s | 17.46% | 81.84% |
| eLi9wpqzT70 | pl:news | 1667 s | 244 s | 14.66% | 74.71% |
| jeF_L_Qxdl4 | uk:lecture | 4601 s | 745 s | 16.19% | 78.56% |
| KUKjD4BB6_8 | ru:podcast | 7186 s | 744 s | 10.36% | 76.78% |
| NEDLxqo1ATs | uk:talk | 13239 s | 1489 s | 11.24% | 77.70% |
| oi55ii6B9sA | pl:podcast | 2882 s | 277 s | 9.61% | 78.11% |
| r-5Y1w7y6TU | pl:lecture | 3533 s | 562 s | 15.92% | 77.58% |
| S32kCeB0B-k | cs:news | 2346 s | 574 s | 24.46% | 83.00% |
| U58X5TpyspE | ru:news | 1173 s | 182 s | 15.49% | 78.03% |

| Group | n | Median | p90 |
|---|---|---|---|
| **Overall (words series = speech-only)** | **10** | **15.07%** | **17.46%** |
| register=lecture | 4 | 16.05% | 17.46% |
| register=news | 3 | 15.49% | 24.46% |
| register=podcast | 2 | 9.98% | 10.36% |
| register=talk | 1 | 11.24% | 11.24% |
| languageGroup=ru | 3 | 14.52% | 15.49% |
| languageGroup=slavic | 7 | 15.92% | 24.46% |
| Cues series (marker-inclusive) | 10 | 78.07% | 81.84% |

p90 is nearest-rank; the n<3 rows are single/paired videos, not
distributions.

Same-video head-vs-full check (-rg9mV6DBl4): the committed truncated head
measured 15.62% window-relative; the whole video measures 14.52%. The head
proxy was mildly rich on this video, not wildly. The first pass's 12.20% and
this pass's 15.07% are not directly comparable (different corpora — en
TED/explainer heads vs ru/slavic full videos — and different denominators);
the re-run number is the one for the target corpus.

### Verdict (re-run)

**GO — median 15.07% ≥ 12% on whole-video, speech-only savings** (words
series; the slice contains no music register). The speech content the
feature targets carries the gate on its own this time.

Residual caveats:

1. **Slice size.** n=10, with podcast at n=2 (9.61%, 10.36% — both below
the threshold) and talk at n=1 (11.24%). Lecture and news carry the
median.
2. **Cues series is far higher.** Word timing excludes marker-led gaps, so
the word series is the binding one; a cue-level detector would report
~78% but is the noisier design (first pass's note stands).
3. **Music unmeasured at whole-video length.** The original gate's
music-register pass (25.92% head median) is not re-tested; the re-run
slice has no music videos.
4. **One head-vs-full point.** The single same-video comparison shows the
head proxy mildly rich; whether bodies are systematically gap-poorer
than heads across the corpus is not measured.
