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

### Human checkpoint

> One pair of eyes on the golden-master diff per release — the only gate that
> cannot mirror. No script replaces it.

The golden-master diff is the recorded real-site baseline changing between
releases. Every other gate can be automated; a judgment call about whether
the new baseline is the product improving or drifting is not. One human
review per release, with a sign-off line (see `docs/release-gate.md`).
