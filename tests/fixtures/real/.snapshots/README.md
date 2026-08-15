# Golden-master registry — provenance

One row per committed caption fixture, pinning the FULL parse output
(parseYouTubeJson3's `{words, cues}`, byte-pinned) plus the derived semantic
pins (tier, counts, tokens, span, speech duration, pause bias, per-tier
rates). The replay spec (tests/golden-master.test.ts) re-parses and
re-measures every fixture and asserts the rows; the drift-triage runner
(scripts/drift-triage.ts) diff re-captures against them.

## External truth

The baseline is authored once per verified capture; it is never regenerated
from lib/ by the test suite. Two committed sources anchor it:

- The fixtures themselves (tests/fixtures/real/, tests/fixtures/synthetic/):
  truncated real payloads captured per tests/fixtures/README.md (first 20
  events, first 12 top-level windows) plus the authored synthetic lanes.
- The recorded corpus (scripts/data/sample-results.jsonl, web-rerun/,
  gap-yield/, ru-corpus/): the full-payload metrics for the same videoIds,
  captured by the POT-aware harness. Each row's `recorded` block copies the
  relevant fields verbatim from those files.

## Verification

Every pinned number was checked against the recorded sources before commit;
the replay spec re-asserts the relations that hold under the truncation
convention (see the cross-check section of tests/golden-master.test.ts):

- counts/tokens/span never exceed the recorded full-payload values
  (truncation only removes);
- the tier matches the recorded track kind (asr → asr-word/asr-cue,
  manual → manual-cue);
- the pause-bias sign matches the recorded pause-bias sign (asr videos);
- the timing-coverage flag matches a recorded coverage above the
  MIN_WORD_TIMING_COVERAGE floor;
- manual-cue.json's rate matches the recorded cueWpmCorrected within ±10%
  (same ANDROID payload, homogeneous speech — observed 0.06%);
- the ru fixture (no per-video rate record exists) is checked against the
  gap-yield full duration and its parse-available classification.

## Tolerance

`pins.tolerance` (countsRel 0.25, ratesRel 0.15) is the semantic tolerance
the drift-triage runner applies when classifying re-captures: counts may
shift with ASR re-segmentation, rates with retiming, up to the band. The
recorded corpus shows full-payload counts stable within ~1% across runs
(iG9CE55wbtY: 2753 timed words in sample-results vs 2745 in web-rerun); the
truncation boundary (20th event / 12th window) is the dominant legitimate
noise source, which is why the band is wider than the observed full-payload
stability.
