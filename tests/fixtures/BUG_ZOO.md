# Bug zoo — named regression fixtures

One named fixture per shipped bug class, so a regression re-triggers a
greppable name instead of a silent shape change. Fixture payloads follow
the synthetic json3 word-timed shape (see pot-gated.json); the page
behavior variants (stub controls, signed-fetch gate, mount delay) live in
e2e/server.ts keyed off e2e/shared/fixtures.ts.

| bug class | fixture file | test that pins it | shipped in |
|---|---|---|---|
| POT-gated fetch failure — a bare captionTracks fetch gets HTTP 200 with an EMPTY body; the capture path must measure from the player's signed fetch (pot/potc), never from a bare re-fetch | `synthetic/pot-gated.json` | `e2e/shared/specs.ts` `runCaptureSpecs` ("pot-gated: bare timedtext … expected 200/empty"); the stub player controls mirror `tests/caption-trigger.test.ts`'s `stubPlayerControls` | PR #11 (a3280a6) |
| Late-rendering CC/settings controls — the first drive races the track list and times out; the same-attempt retrigger re-drives (bypassing the cooldown) and finds them | `synthetic/late-controls.json` | `tests/caption-trigger.test.ts` "the retrigger re-drives within the cooldown window (same-attempt recovery)" | PR #20 (64b628b) |
| Cooldown-expired retrigger — the complementary case: a second drive of the same video re-picks once the 30s cooldown window has passed | `synthetic/cooldown-expired.json` | `tests/caption-trigger.test.ts` "re-drives once the cooldown window has passed" | PR #19 (349b27d) |
| Missing-controls no-op — a page with no CC/settings buttons: the drive no-ops cleanly ({ ccWasOn: null, changed: false }) and records no cooldown, so a later drive still runs | `synthetic/no-controls.json` | `tests/caption-trigger.test.ts` "a drive that touched nothing does not start a cooldown" | PR #19 (349b27d) |

Page-behavior notes:

- The control-bearing fixtures (`pot-gated`, `cooldown-expired`,
  `late-controls`) are POT_GATED_FIXTURES: the server pays payloads only to
  signed timedtext fetches, and injects the stub player controls via the
  `__POT_GATED__` slot of the watch page.
- `late-controls` mounts its controls 4 s after load — past the drive's 3 s
  visibility wait (lib/caption-trigger.ts STEP_WAIT_MS) — via
  LATE_CONTROLS_FIXTURES.
- `no-controls` is the plain watch page: no control stub is injected at
  all, only the caption payload differs.
