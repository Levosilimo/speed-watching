# Contributing

Speed Watcher is a small, MIT-licensed extension. The bar for entry is the
definition of done below; read it before opening a PR.

Solo-maintained, but every contribution counts. The main branch ruleset
requires a PR; zero approvals means you can merge your own.

## 1. What is welcome

- Bug reports with a repro (extension version, URL, steps).
- Test coverage that pins a behavior.
- Caption-parser data: new VTT/HLS/edX fixtures that exercise parser paths.
- i18n translations (see the i18n parity rule).
- Small, focused changes. If a change touches more than one concern, split it
  into separate PRs.
- Open an issue first for anything that changes behavior, scope, or the data
  model. Unannounced feature PRs may be rejected on scope grounds.

## 2. Issues and pull requests

Use the issue templates. Bug reports need the pill state and tier — the
[bug template](.github/ISSUE_TEMPLATE/bug_report.yml) asks for exactly what
diagnoses a report; a half-filled report beats a missing one. Questions and
ideas that aren't bugs belong in
[Discussions](https://github.com/levosilimo/speed-watching/discussions).

The PR template's checklist mirrors the actual gates — run them locally
before pushing. Behavioral changes get a `CHANGELOG.md` entry. New `sw.*`
storage keys come with a migration note.

## 3. Development setup

- bun is mandatory. Never touch `package-lock.json` or `yarn.lock`; `bun.lock`
  is the only lockfile.
- `bun run dev` starts the WXT watch mode; `.wxt/` and `.output/` are
  generated and never edited.
- The gate battery, in the order CI runs it: `bun run lint`, `bun run
  typecheck`, `bun run knip`, `bun run check` (aislop), `bun run test`, `bun
  run build`, `bun run build:userscript`, and the userscript bundle test
  (`bun run test -- tests/userscript-bundle.test.ts`). `bun run ci` runs all
  of it.
- E2E: `bun run e2e:chromium`, `bun run e2e:userscript`, and for Firefox
  changes `bun run build:firefox` before `bun run e2e:firefox` (the Firefox
  e2e lane builds its own browser output).

## 4. Coding rules

- No restatement comments. A comment must add information the code does not
  already state.
- No tautological JSDoc (`/** Returns X. */` above `function X()`).
- Minimal effective edit: change only what the task requires.
- No defensive fluff: no null checks on values you control, no
  environment-guard branches, no "just in case" branches.
- No over-abstraction: one level of indirection per concern, no single-use
  interfaces, no wrapper for a wrapper.
- No empty catch. Catch blocks must handle or rethrow.
- No `as any`, no `@ts-ignore`, no `@ts-expect-error` to silence the
  compiler — fix the type.
- No TODO-stub bodies. A function that does nothing but `TODO` is not
  scaffolding; ship the smallest thing that works.

## 5. Commit style

- Imperative subject, ≤72 characters, no trailing period.
- Body states what and why, not how; no filler.
- One logical change per commit.
- Sign every commit: `git commit -s`.

## 6. Definition of Done

- All gates pass (lint, typecheck, knip, aislop, unit tests, build, userscript
  bundle test).
- No new bundle weight without justification stated in the PR.
- The store-permission count is unchanged unless the PR documents the change.
- The relevant e2e lanes are green (chromium; firefox when the change touches
  Firefox-specific paths).

## 7. Scope philosophy

This project has one purpose: recommend playback speed from caption speech
rate. Everything in the tree serves that purpose — the capture harness, the
rate model, the pill, the userscript, the mpv script. A change that adds a
second product purpose will be rejected regardless of quality. If you want to
build something else, fork.

## 8. i18n parity rule

Every new user-facing string ships with its Russian translation in the same
PR (`lib/i18n.ts` en + `lib/i18n-ru.ts` ru). The extension targets ru as the
second language; strings without a translation fail the UI tests.

## 9. Corpus and language-model honesty

- Caption data exists for measurement only. Copyright stays with the
  creators; full verbatim transcripts are never committed (the harness
  regenerates them on demand).
- Every number cited in an issue, PR, or doc ties to a sample in
  `docs/phase0-caption-wpm.md`. Unsourced rate claims will be asked for
  receipts.

## 10. No-AI-slop rules

Applies to code comments, docs, PRs, and commits:

- No throat-clearing openers ("In today's fast-paced world", "Let's dive
  in").
- No faux-insight setups ("It's worth noting that...", "Importantly,").
- No importance puffery ("crucial", "vital", "game-changing").
- No weasel attribution ("arguably", "essentially", "kind of").
- No synonym cycling (saying the same thing three ways in one paragraph).
- No fake-profound endings ("In the end, it's about...").

Banned words: delve, leverage, seamless, robust, comprehensive, dive into,
streamline, elevate, unlock, effortless, landscape.

## 11. Inbound licensing

This project is MIT licensed. By contributing, you certify the contribution
is yours to submit and that you license it under MIT (inbound = outbound),
via the Developer Certificate of Origin. Only MIT-compatible code may enter
the tree. Do not import code from a repository unlicensed or under a license
incompatible with MIT; treat repositories that claim a license but carry no
LICENSE file as learn-only. If you borrow code, say so in the PR and preserve
its copyright notice.

## 12. DCO

Every commit carries `Signed-off-by: Your Name <you@example.com>` (`git
commit -s`). Signing certifies, per the Developer Certificate of Origin, that
you wrote the change or received it from someone who certified it, and that
you submit it under the project's MIT license. The sign-off is a legal
statement; do not sign commits you did not author.
