# Testing methodology

The binding text is AGENTS.md → Testing lanes / Wave methodology; this doc
elaborates, it does not redefine.

The rules exist because the product is a rate engine: the tests are the only
evidence the speech-rate math, the pill contract, and the capture chain still
say what the wpm literature says. Evidence that was generated from the code it
proves is not evidence. Every rule below pushes tests toward an external
truth — the spec, the recorded payloads, the user-visible contract.

## Testing lanes

### Independent lane

> Tests are written from the spec + real fixtures, never the implementation
> they test. A test that reads the code it tests cannot fail for the right
> reason.

A test that asserts on implementation internals fails when the internals
change — even when the behavior is right — and passes when the behavior is
wrong but the internals look familiar. Both are false signals; the test
becomes noise that teaches maintainers to distrust the suite.

Example: this PR's audit specs. `tests/audit-disabled-assertions.test.ts` and
`tests/audit-lanes.test.ts` were written from the rule text and the corpus
fixtures (`tests/fixtures/audit-corpus/`) before the scan scripts existed.
Commit `7fa5580` fails against the pre-script repo; the scripts land in the
next commit. The specs never read the scripts' internals — they assert what
the scans report on known inputs.

### Contract, not count

> Assert observable outcomes (source, tier, pill state). Never assert
> implementation counts (clicks, calls) unless the count IS the user-visible
> contract (the demand and time-saved stores are).

"Observable outcome" means what the user or the next layer can see: the pill
rendered with a rate and a tier, the source label, the store's persisted
values. "Implementation count" means how the machinery got there: how many
times a handler ran, what arguments a spy received. The demand store is the
sanctioned exception because its counters are the product — the user is
promised "X sessions, Y time saved".

Example: `tests/demand.test.ts` asserts the store's exposed counters and
thresholds (exported constants are the public contract). `tests/pill.test.ts`
asserts the rendered pill — which rate, which tier label — not how often the
render function was called. The audit lane `audit-contract-not-count` flags
every spyOn / toHaveBeenCalled* hit so a human confirms each one.

### Two-commit bug fixes

> A bug fix is two commits: `test:` first — it must fail against the current
> code — then `fix:`. Never squash them. A fix whose test passes on the old
> code is not a fix.

The red commit is the proof the test would have caught the bug. Squashing
destroys the proof; a green-on-old-code test proves nothing but the test's
own tolerance.

Example: this PR's own history — `test:` (the audit specs, red) then `feat:`
(the scripts, green). The PR body shows the red run and the green run side by
side. When the fix and the test land in one commit, the reader cannot know
whether the test ever failed.

### Retrigger ≠ drive

> An attempt's retrigger must not call the same cooldown-gated function as
> its drive; a retrigger is an ungated sub-operation of the attempt (see
> 64b628b: the retrigger is the same attempt's second pass, not a new drive).

The capture drive is gated so a cooldown can't be beaten by re-invoking it.
A retrigger (the same attempt trying again after a transient miss) must route
through the ungated sub-operation, or the cooldown design is a fiction.

Example: `64b628b` — the CC-capture retrigger was calling the cooldown-gated
drive again; the fix re-enters only the attempt's second pass, leaving the
gate intact.

### External truth

> Invariants and the golden-master baseline are written from `plan-v2.md`,
> the wpm literature, and recorded real-site data — never regenerated from
> `lib/`. `scripts/data/*/results.jsonl` is the oracle: the only non-LLM
> artifact. Synthetic fixtures derive from a real captured payload, not from
> invention.

Regenerating expectations from the code makes the suite a mirror of the code
— a formatting error becomes an invariant. The oracle is the recorded
real-site data under `scripts/data/`: it was captured, not generated. A
synthetic fixture is only as good as its provenance: it must trace to a
recorded payload or a real video ID.

Example: `tests/fixtures/synthetic/windows-format.json` carries the
format-drift sentinel naming the recorded `windows-asr-*` payloads it
derives from. The audit lane `audit-real-fixtures` flags any synthetic
fixture with neither a `scripts/data` videoId nor a data reference.

## Wave methodology

### Release gate

> The real-site runner (`scripts/realsite-runner.ts`) holds a ≥80% pass ratio
> on a fresh build before release; box runs are scheduled, not ad hoc. Below
> the bar does not ship.

The fixture suites prove math and wiring on synthetic pages; the real-site
runner proves the real session class — layout, signed caption fetches, live
and music detection. "Fresh build" means the run happens against the build
produced from the release commit, not a stale `.output`. "Scheduled" means
box runs happen on the release calendar, not when a bug report demands one.
The checklist lives in `docs/release-gate.md`.

### Stryker tripwire

> The nightly mutation run must not exceed 65 survivors. On breach, fix the
> surviving mutants — never add tests that paper over them.

Survivors are mutations the suite didn't kill — behavior the tests don't
pin. The response to a breach is to tighten the tests or the code, not to
raise the ceiling or exclude mutants. Adding a test that only passes under
mutation (a tautology) is papering over.

The operational form (wave 5, re-scoped in the wave-fixb audit):
`stryker.conf.json` mutates the whole behavior-bearing lib surface — every
lib with a dedicated spec plus the audit's additions (music, live,
auto-apply, override-log, settings, heuristics, youtube, messaging,
bridge-protocol, wpm-provider) — with the vitest runner in related mode
(only the specs that import a file run against its mutants). Two files are
excluded: `measure-hooks.ts` (the E2E console/event hook — its dispatch is
asserted by the e2e suites, no unit spec imports its runtime) and
`recorder-worklet.ts` (an AudioWorkletProcessor that runs in the audio
thread — not runnable under node). `thresholds { high: 80, low: 65,
break: 65 }` makes the nightly job fail below 65 — the tripwire. `bun run
mutation` runs it locally.

#### Baseline (wave-fixb, 2026-08-15)

| File | Score | Killed | Survived | No coverage |
|------|------:|-------:|---------:|------------:|
| All files | 74.97% | 3912 | 1197 | 119 |
| auto-apply.ts | 100% | 35 | 0 | 0 |
| live.ts | 100% | 12 | 0 | 0 |
| override-log.ts | 100% | 29 | 0 | 0 |
| wpm-provider.ts | 100% | 10 | 0 | 0 |
| resampler.ts | 95.24% | 37 | 2 | 0 |
| measure-guard.ts | 93.33% | 14 | 1 | 0 |
| recommend.ts | 91.2% | 114 | 11 | 0 |
| settings.ts | 90.99% | 101 | 10 | 0 |
| audio-capture.ts | 90% | 54 | 6 | 0 |
| messaging.ts | 90.24% | 145 | 12 | 4 |
| matcher.ts | 88.71% | 55 | 7 | 0 |
| nudge.ts | 88.78% | 87 | 11 | 0 |
| channel-memory.ts | 88.75% | 71 | 9 | 0 |
| transcript.ts | 88.16% | 134 | 17 | 1 |
| wpm.ts | 87.83% | 166 | 23 | 0 |
| wpm-protocol.ts | 86.4% | 107 | 16 | 1 |
| skip-silence.ts | 86.25% | 135 | 19 | 3 |
| audio-recorder.ts | 85.86% | 79 | 14 | 0 |
| error-journal.ts | 85% | 68 | 12 | 0 |
| heuristics.ts | 83.9% | 99 | 17 | 2 |
| audio-probe.ts | 79.37% | 150 | 33 | 6 |
| bridge-protocol.ts | 79.88% | 274 | 62 | 7 |
| youtube.ts | 79.66% | 141 | 32 | 4 |
| time-saved.ts | 78.48% | 62 | 17 | 0 |
| chapter-scheduler.ts | 78.05% | 60 | 18 | 0 |
| demand.ts | 77.92% | 120 | 34 | 0 |
| captions.ts | 77.78% | 119 | 34 | 0 |
| caption-fetch.ts | 77.55% | 76 | 19 | 3 |
| captions-harvest.ts | 73.68% | 210 | 68 | 7 |
| caption-capture.ts | 72.79% | 107 | 37 | 3 |
| chapters.ts | 71.57% | 138 | 50 | 6 |
| capture-orchestrator.ts | 70.77% | 183 | 64 | 12 |
| tokenizer.ts | 70.94% | 82 | 30 | 4 |
| rate-controller.ts | 68.7% | 259 | 96 | 22 |
| music.ts | 67.5% | 27 | 13 | 0 |
| model-store.ts | 52.17% | 36 | 1 | 32 |
| languages.ts | 7.3% | 17 | 216 | 0 |

`languages.ts` is the honest floor: the LANGUAGES table is data, and the
specs pin its structure and the measured bands, not every derived number —
the 216 survivors are literal-value mutants of the un-pinned entries. The
tripwire (≥65) holds with that floor included; the nightly breach protocol
below stays the response to any future drop.

#### Survivor classification (wave 5)

Every survivor of the baseline was reviewed and put in one of three classes:

**(a) Fixed now — real test gaps.** The complementary case was missing:

- `rate-controller.ts` had zero unit coverage (375 mutants, none killed).
  `tests/rate-controller.test.ts` pins the render + auto-apply gate, the
  apply choke point, the override guard, the live-rate line, the session
  teardown, and the post-apply disarm discipline. The review also surfaced
  a real behavior gap: `userApply` mutated `appliedSource` but never
  re-rendered the pill, so the 'Auto ·' label and undo anchor stayed stale
  after a user Apply click — fixed as a two-commit pair (test then fix).
- `recommend.ts` boundary cases: the exact-1.5x rounding on a non-manual-cue
  tier, the sub-clamp manual-cue miss, the exactly-at-ceiling and
  exactly-at-target cases (the strict `<` / `>` comparisons).
- `caption-trigger.ts` interaction gates: CC-already-on drive, the restore
  guards against a player toggle between flip and restore, RU labels, the
  hidden-row exclusion, the no-submenu / control-rows-only aborts, the
  endonym track pick, and its unresolvable-endonym fallback.
- `caption-fetch.ts` request leaves: `fmt=json3` handling and the ANDROID
  POST client identity (the chain-model suite stubs fetch too coarsely to
  see them).
- `transcript.ts` identity guards: non-string API key, non-record context,
  non-function `ytcfg.get`.
- `matcher.ts` lifecycle: no leaked intervals/listeners after stop or SPA
  element removal (timer-count assertions).
- `caption-trigger.ts` wait-loop deadline arithmetic: the exact-boundary
  fake-timer tests (advance to exactly the deadline, and to deadline−1)
  pin the `>=` flip of `waitForVisible`/`waitForMenuRow` and
  `waitForWordTimedCapture`'s timeout — re-classified from (b) in the
  wave-fixb audit, which found the polls DO land on the boundary with an
  exact advance. The same holds for the cooldown-prune boundary, already
  pinned by the exact-30s test (wave 5) — both entries were misjudged
  unreachable.

**(b) Documented known tradeoffs — the assertion cannot observe them.**

- The `pill === null` refresh guards in rate-controller: the pill mount
  already gates the same state (no pill, no live/saved line).
- `computeSavedSec` / `computeLiveRate` null-guard flips: a null video or
  multiplier downstream makes the comparison false either way.

**(c) False positives — equivalent or unreachable mutants.**

- matcher: `lastActive !== null` with `includes(null)` always false;
  `clearInterval(null)` is a no-op; the reassert guard's `&&` variant ≡
  `||` (stop() nulls both fields together); the epsilon `<` vs `<=` float
  boundary.
- recommend: the module constants (`CONTENT_TYPE_CEILING_FACTOR`,
  `ARTICULATORY_CEILING_WPM` math, `TIER_LABELS`) are pinned by the
  "engine constants" test, but stryker's per-test coverage attribution does
  not route module-init mutants to it — verified: the assertion kills the
  mutant when run directly. Same for caption-fetch's ANDROID client
  constants vs the POST-body test. The `floor === SLOW_DOWN_FLOOR` → true
  mutant is unreachable (a platformMax below 0.5 caps the clamp below the
  floor). The `articulatoryWpm !== null` → true variants are equivalent
  (null × multiplier is NaN → the comparison stays false).
- caption-trigger: `ccWasOn === false` → true is unreachable — `changed`
  only becomes true by flipping CC on, which requires `ccWasOn === false`.
- rate-controller: the `__E2E__` pill-hook branch is compiled out of the
  test path.

Breach protocol, restated for the nightly job: below 65 → the job fails and
files an issue with the report; the response is the (a)/(b)/(c) review
above — fix the (a) class with complementary tests, never raise the
threshold, never exclude a mutant or a file.

### Human checkpoint

> One pair of eyes on the golden-master diff per release — the only gate that
> cannot mirror. No script replaces it.

The golden-master diff is the recorded real-site baseline changing between
releases. Every other gate can be automated; a judgment call about whether
the new baseline is the product improving or drifting is not. One human
review per release, with a sign-off line (see `docs/release-gate.md`).

## Mutation spot-check runbook

Every feature PR that touches behavior gets the per-PR mutation spot-check
(the DoD item "a mutant on each touched function fails its test"): mutate
the touched function by hand and prove the suite catches it. The nightly
run is the tripwire; the spot-check is the daily discipline that keeps the
nightly green.

### When

- Bug-fix PRs (both commits: the `test:` and the `fix:`).
- Spec-behavior changes (a recommendation rule, a capture gate, an apply
  path).
- Not needed for pure refactors, renames, or doc-only changes — nothing
  behavior-bearing was touched.

### How (about two minutes per touched function)

1. Pick the touched function from the diff.
2. Apply a mutation by hand — flip a comparison (`>` → `<`), remove a
   guard (`if (x) return` → dead), replace a constant — and save.
3. Run the touched spec: `bunx vitest run tests/<spec>.test.ts`.
4. It must fail. A passing spec is the mirror signature: the test reads the
   code it asserts. Rewrite the assertion from the spec (the plan-v2 rule
   text, the pill contract, the fixture), not from the implementation.
5. Revert the mutation, keep the assertion, commit.

### Classification

A surviving mutant is one of three things; resolve it accordingly:

- **Real gap** — the assertion misses the complementary case. Add it.
- **Equivalent / unreachable** — the mutation cannot change observable
  behavior (a null that short-circuits later, a branch the state machine
  cannot enter). Document it in the PR body; the nightly run tolerates it.
- **Mirror signature** — the test passes with the buggy code because it was
  written from the code. Rewrite it from the spec.
