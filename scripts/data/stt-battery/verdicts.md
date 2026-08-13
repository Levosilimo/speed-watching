# STT battery verdicts

Gate rules (plan-v2, phase-0): per clip, rate error <=10%, count-bias in
[-2%,+8%], WER <=15%. G1: both models pass -> tiny wins; only base -> base;
neither -> word-level STT rate not shippable. All numbers below are the
ref-aligned values (see G1 note).

## G1 — model lock (V1, 2026-08-13)

records: results-v1.jsonl (10 records, both models x 5 clips, chunk 29 / stride 5)

| clip | model | werAligned | countBiasAligned | rateErr(w) | rateErr(u) | tsMonotonic |
|---|---|---|---|---|---|---|
| iG9CE55wbtY | tiny | 22.6% | +7.5% | -38.6% | -31.1% | true |
| Ks-_Mh1QhMc | tiny | 19.3% | +5.7% | -7.5% | -20.4% | true |
| jGwO_UgTS7I | tiny | 37.9% | +14.5% | -26.8% | -8.9% | true |
| HtSuA80QTyo | tiny | 32.8% | +20.1% | -26.9% | -1.8% | false |
| WUvTyaaNkzM | tiny | 21.1% | +17.7% | -20.1% | -0.7% | true |
| iG9CE55wbtY | base | 20.4% | +6.5% | -20.0% | -20.7% | true |
| Ks-_Mh1QhMc | base | 19.3% | +6.4% | -2.9% | -15.2% | true |
| jGwO_UgTS7I | base | 31.0% | +13.1% | -22.3% | -9.3% | true |
| HtSuA80QTyo | base | 30.6% | +16.4% | -21.0% | -5.0% | true |
| WUvTyaaNkzM | base | 19.0% | +17.7% | -15.3% | -4.8% | true |

VERDICT: NEITHER passes -> word-level STT rate NOT shippable on this corpus.

- WER: 0 of 10 records <=15% (tiny 19.3-37.9, base 19.0-31.0). The errors are
  cross-ASR word disagreement, not misrecognition: the diag dump for
  iG9CE55wbtY shows the hyp content-matches the ref in the ref span ("Good
  morning. How are you? It's been great..." vs "morning are you it's been
  great..."); whisper and YouTube-ASR simply pick different function words.
- count-bias: 4 of 10 records pass [-2%,+8%] (iG9CE55wbtY + Ks-_Mh1QhMc on
  both models); whisper is wordier than the caption everywhere else.
- rate error (word-accurate): 1 of 10 records within +-10% (Ks-_Mh1QhMc,
  both models). The error is systematically NEGATIVE: caption cue-boundary
  pauses shrink the ref speech-duration denominator, whisper's continuous
  word timestamps do not, so whisper's word-accurate rate reads low. The
  unified (span-trimmed) rate error is closer: tiny -0.7..-31.1 (3/5 in
  +-10%), base -4.8..-20.7 (2/5).
- timestamp sanity: tiny 4/5 monotonic (HtSuA80QTyo out-of-order words), base
  5/5.
- Reproducibility: tiny.en numbers bit-identical across three independent
  runs (2026-08-12 smoke x2, 2026-08-13 V1 x2 runs on the same clip).

Ref-alignment correction: the YouTube-ASR ref only covers the speech span of
each 66s window (silent leads of 0.1-26.7s; 4 of 5 clips). Full-window hyp
words outside the ref span score as pure insertions, inflating WER and
count-bias. Scoring hyp chunks whose start falls inside the ref span lowers
the bias (iG9CE55wbtY tiny +8.6% -> +7.5%, base +8.6% -> +6.5%) but does not
change any gate outcome. The raw full-window values are in results-v1.jsonl.

## G2 — chunk-seam integrity (V2)

records: results-v2.jsonl (kind v2, 2026-08-13; clip jGwO_UgTS7I, 66s, base.en)

| config | seam | seamCountBias | o3 | dup | tsMonotonic | overflow | wholeBias |
|---|---|---|---|---|---|---|---|
| chunk=30 stride=null | 30s | 0.0% | 0 | 0 | true | false | 19.3% |
| chunk=29 stride=5 | 29s | +7.7% | 0 | 0 | true | false | 13.8% |

VERDICT: PASS — both chunk configs hold seam-local word continuity: per-seam
count-bias within [-2%,+8%], no out-of-order words, no duplicate word pairs
(seam or whole clip), timestamps monotonic, no overflow. The low seam recall
(8.3%/15.4%) is a metric artifact of the greedy in-order matcher (a leading
hyp word outside the ref window, e.g. "using" at 28.2s vs ref 26.6s, exhausts
the ref scan) — the diag dump shows the hyp and ref content match at the
seam ("so what I want to do today spend some" on both sides). Whole-clip
count-bias stays above +8% (13.8-19.3%) — that is the G1 cross-ASR wordiness,
not a seam effect; the G2 gate is per-seam and both configs pass it.

Note: the 2026-08-12 v2 record (seam countBias 0.69, wholeClipCountBias 2.38,
recall 0) predates the harness's clip-relative ref timestamps and is a known
reference-alignment artifact; it is excluded from this verdict.

## G3 — invocation e2e (V3, 2026-08-13)

e2e/chromium/offscreen.spec.ts (CDP Extensions.triggerAction rewrite) on the
CfT lane, build:e2e bundle, both modes:

- headless: 5/5 passed (offscreen createDocument + ack, lifecycle
  getContexts, manifest action contract (no popup), pre-invocation guidance
  error + idle mirror, triggerAction -> orchestrator `capturing` within 2s on
  the active tab, mirror tabId matches, headless meter pinned at 0).
- headed (DISPLAY=:0, E2E_CFT_HEADED=1): 5/5 passed, including the meter
  level > 0.01 assertion with real tab audio.

VERDICT: PASS. Deviation: the box's /tmp/.X11-unix is root-owned with mode
0777 (no sticky bit), so Xvfb aborts at startup and xvfb-run cannot work
(no passwordless sudo to fix the mode); the headed run used the live X :0
session with the spec's off-screen window position.

## G4 — STT zip footprint (V4, 2026-08-13)

zip -9 measurements (deflate):

| artifact | on-disk | zipped | ratio |
|---|---|---|---|
| whisper-tiny.en (q8, 13 files) | 42.4 MB | 24.76 MB | 0.58 |
| whisper-base.en (q8, 13 files) | 76.8 MB | 44.70 MB | 0.58 |
| onnxruntime-web dist (ort-wasm) | 106.2 MB | 23.70 MB | 0.22 |
| transformers.web.min.js | 0.4 MB | 0.11 MB | 0.28 |
| extension bundle (wxt zip) | - | 0.07 MB | - |

STT zip totals vs the 2 GB store cap:

- tiny.en bundle: 24.76 + 23.70 + 0.11 = 48.6 MB (2.4% of 2 GB)
- base.en bundle: 44.70 + 23.70 + 0.11 = 68.5 MB (3.3% of 2 GB)

VERDICT: PASS — either model's STT payload fits the store cap with 30x
headroom; the ort-wasm dist zips to a quarter of its disk size (wasm
compresses well), so even shipping the full webgpu+wasm dist stays cheap.

## G5 — segment-timed rate disambiguation (V5, 2026-08-13)

records: results-seg.jsonl (kind seg, 10 records, both models x 5 clips,
chunk 29 / stride 5, tsMode 'true' — segment timestamps only; same clips,
same refs as G1, so the timing-mode effect is isolated)

| clip | model | segs | hypSpan | refSpan | refU | hypU | rateErr(u) | countBias |
|---|---|---|---|---|---|---|---|---|
| iG9CE55wbtY | tiny | 9 | 0.0..66.0 | 26.7..65.8 | 182.1 | 91.9 | -49.5% | +8.6% |
| Ks-_Mh1QhMc | tiny | 16 | 0.0..64.2 | 16.8..66.0 | 204.9 | 140.2 | -31.6% | +7.1% |
| jGwO_UgTS7I | tiny | 16 | 0.0..64.8 | 4.5..65.9 | 177.6 | 158.4 | -10.8% | +17.9% |
| HtSuA80QTyo | tiny | 14 | 0.0..65.0 | 0.1..65.8 | 148.7 | 150.5 | +1.2% | +21.6% |
| WUvTyaaNkzM | tiny | 12 | 0.0..64.1 | 15.4..65.0 | 210.5 | 176.0 | -16.4% | +27.9% |
| iG9CE55wbtY | base | 8 | 0.0..66.0 | 26.7..65.8 | 182.1 | 91.9 | -49.5% | +8.6% |
| Ks-_Mh1QhMc | base | 13 | 0.0..64.2 | 16.8..66.0 | 204.9 | 140.3 | -31.6% | +7.1% |
| jGwO_UgTS7I | base | 18 | 0.0..65.4 | 4.5..65.9 | 177.6 | 151.3 | -14.8% | +13.8% |
| HtSuA80QTyo | base | 13 | 0.0..66.0 | 0.1..65.8 | 148.7 | 141.8 | -4.7% | +16.4% |
| WUvTyaaNkzM | base | 12 | 0.0..62.0 | 15.4..65.0 | 210.5 | 170.3 | -19.1% | +19.7% |

(spans in seconds, first-to-last start; countBias is the full-window text
decomposition — the in-span filter that helped G1's word mode drops whole
leading segments here, inflating deletions into a spurious negative bias)

VERDICT: FAIL — the segment-timed unified rate does NOT pass; the hypothesis
is refuted. Rate error within +-10% on 1/5 clips per model (HtSuA80QTyo:
tiny +1.2%, base -4.7%); count-bias within [-2%,+8%] on 2/5 per model
(iG9CE55wbtY +8.6% just over, Ks-_Mh1QhMc +7.1%); combined gate 0/5 both.

- Mechanism (span geometry, in the records): whisper's first segment starts
  at 0.0 s on all 10 clips — segment timing covers the whole window,
  including the silent/music lead — while the caption ref span starts at the
  first spoken word (leads 0.1-26.7 s). The hyp unified-rate denominator is
  the full ~66 s window; the ref denominator is the speech span. The error
  tracks the lead length exactly: HtSuA80QTyo (no lead, ref span starts at
  0.1 s) is the only clip in band on both models.
- Segment mode is WORSE than G1's word mode (tiny 3/5, base 2/5 in +-10%):
  word timestamps at least begin near speech, segments begin at 0.0.
- The identical tiny/base rate errors on iG9CE55wbtY and Ks-_Mh1QhMc
  (-49.5%, -31.6% to the 0.1%) confirm the error is timing-shape-driven, not
  transcript-driven.
- Positive side-finding: segment timestamps skip whisper's word-alignment
  pass — rtf drops ~2x vs G1 (tiny 0.13-0.16 vs 0.32-0.39, base 0.23-0.30 vs
  0.32-0.59) with monotonic timestamps on all 10 records.
- Harness deviation: running both models in one process, base.en hangs after
  tiny.en completes (second chromium launch wedges; no output, no timeout
  record). Worked around with the harness's BATTERY_MODEL filter (one
  process per model); numbers bit-identical across the standalone and
  chained runs.

CONSEQUENCE: the cue-level STT tier is NOT shippable, with or without an
'approximate' label — a -50% systematic rate error is a wrong number, not a
residual the label can carry. The captions-only + estimated path stands; the
demand gate decides later whether STT ever ships.

RESIDUAL (post-ship calibration item): the reference itself is YouTube-ASR,
whose cue-boundary pause structure already distorts both G1 rate metrics.
A hand-transcribed reference (human word timing) would isolate whisper's
true rate error from the reference's pause bias — the clean gate for the
residual systematic offset, deferred because the gate outcome cannot change
(1/5 in band vs the 4/5 requirement).


