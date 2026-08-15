# Speed Watcher

WPM-based speed-watching extension: sets video playback speed so effective
speech rate lands in the ~250–275 wpm safe zone.

Design sources live in `.slim/deepwork/` (ignored, not part of the repo):
- `plan-v2.md` — product plan, speech-rate daisy-chain, feature mapping
- `stack-v1.md` — stack and quality-tooling decisions

## Stack

- WXT 0.21, TypeScript vanilla, Chrome MV3 (min_chrome_version 116)
- bun — package manager. Never touch `package-lock.json`/`yarn.lock`.
- Vitest for tests, oxlint for lint, knip for dead-code checks
- Quality gates run via lefthook on pre-commit (aislop + ast-grep); `bun run check` runs the aislop gate manually

## Layout

- `entrypoints/` — WXT file-based entrypoints. Each file/dir here becomes a
  manifest entry: `background.ts`, `content.ts`, `options/` (options page).
  New entrypoints must follow WXT naming conventions; WXT generates
  `.wxt/` and `.output/` — never edit them.
- `tests/` — vitest specs (`bun run test`, i.e. `vitest run`)
- `scripts/` — lce-setup quality gates, do not edit casually

## Commands

- `bun run dev` — watch mode with HMR
- `bun run build` — production build to `.output/chrome-mv3/`
- `bun run typecheck` — `tsc --noEmit`
- `bun run test` — vitest run
- `bun run lint` — oxlint
- `bun run check` — aislop gate (same as the pre-commit hook)
- `bun run knip` — unused code/dependency check

## Code rules

- No restatement comments. A comment must add information the code does not
  already state; if it repeats the line below it, delete it.
- No tautological JSDoc (`/** Returns X. */` above `function X()`).
- Minimal effective edit: change only what the task requires.
- No defensive fluff: no null checks on values you control, no
  `if (process.env.NODE_ENV !== 'production')` guards, no "just in case"
  branches.
- No over-abstraction: one level of indirection per concern, no
  single-use interfaces, no wrapper for a wrapper.
- No empty catch. Catch blocks must handle or rethrow.
- No `as any`, no `@ts-ignore`, no `@ts-expect-error` to silence the
  compiler — fix the type.
- No TODO-stub bodies: a function that does nothing but `TODO` is not
  scaffolding, it is a lie. Ship the smallest thing that works.
- Every sentence in code, comments, and docs earns its place.

## Prose rules (README, PRs, commits)

No AI-slop patterns:
- No throat-clearing openers ("In today's fast-paced world", "Let's dive in")
- No faux-insight setups ("It's worth noting that...", "Importantly,")
- No importance puffery ("crucial", "vital", "game-changing")
- No weasel attribution ("arguably", "essentially", "kind of")
- No synonym cycling (saying the same thing three ways in one paragraph)
- No fake-profound endings ("In the end, it's about...")

Banned words: delve, leverage, seamless, robust, comprehensive, dive into,
streamline, elevate, unlock, effortless, landscape.

## Testing lanes

Every feature ships a spec lane and an audit lane.

- **Independent lane.** Tests are written from the spec + real fixtures,
  never the implementation they test. A test that reads the code it tests
  cannot fail for the right reason.
- **Contract, not count.** Assert observable outcomes (source, tier, pill
  state). Never assert implementation counts (clicks, calls) unless the count
  IS the user-visible contract (the demand and time-saved stores are).
- **Two-commit bug fixes.** A bug fix is two commits: `test:` first — it must
  fail against the current code — then `fix:`. Never squash them. A fix whose
  test passes on the old code is not a fix.
- **Retrigger ≠ drive.** An attempt's retrigger must not call the same
  cooldown-gated function as its drive; a retrigger is an ungated sub-operation
  of the attempt (see 64b628b: the retrigger is the same attempt's second
  pass, not a new drive).
- **External truth.** Invariants and the golden-master baseline are written
  from `plan-v2.md`, the wpm literature, and recorded real-site data — never
  regenerated from `lib/`. `scripts/data/*/results.jsonl` is the oracle: the
  only non-LLM artifact. Synthetic fixtures derive from a real captured
  payload, not from invention.
- **Fixture provenance gate.** Every file under `tests/fixtures/synthetic/`
  must be named in `tests/fixtures/README.md` with its derivation lineage —
  the captured payload it truncates or the e2e lane it was authored for.
  `scripts/audit-lanes.ts` fails on any synthetic fixture the README does
  not name; there is no baseline backlog and no env escape.

## Wave methodology

Work ships in waves: process → executable spec → failure space → environment
classes → mirror detector. Each wave passes CI and its DoD checkboxes before
the next starts.

- **Release gate.** The real-site runner (`scripts/realsite-runner.ts`) holds
  a ≥80% pass ratio on a fresh build before release; box runs are scheduled,
  not ad hoc. Below the bar does not ship.
- **Stryker tripwire.** The nightly mutation run must not exceed 65
  survivors. On breach, fix the surviving mutants — never add tests that paper
  over them.
- **Human checkpoint.** One pair of eyes on the golden-master diff per
  release — the only gate that cannot mirror. No script replaces it.

## Commit style

- Imperative subject, ≤72 chars, no trailing period
- Body states what and why, not how; no filler
- One logical change per commit
