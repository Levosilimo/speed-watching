# Contributing

Solo-maintained, but every contribution counts. The main branch ruleset
requires a PR; zero approvals means you can merge your own.

## Issues

Use the templates. Bug reports need the pill state and tier — the
[bug template](.github/ISSUE_TEMPLATE/bug_report.yml) asks for exactly what
diagnoses a report; a half-filled report beats a missing one. Questions and
ideas that aren't bugs belong in
[Discussions](https://github.com/levosilimo/speed-watching/discussions).

## Pull requests

One logical change per PR. The PR template's checklist mirrors the actual
gates — run them locally before pushing:

- `bun run typecheck` / `bun run lint` / `bun run knip`
- `bun run test`
- `bun run build` — CI runs the e2e lanes (chromium, cft, firefox, userscript)
- `bun run check` — the aislop prose gate

Behavioral changes get a `CHANGELOG.md` entry. New UI copy ships in both
locales (`lib/i18n.ts` en + `lib/i18n-ru.ts` ru). New `sw.*` storage keys
come with a migration note.

## Standards

Same rules the codebase lives by: no restatement comments, no defensive
fluff, no over-abstraction, no TODO stubs, no AI-slop prose (the aislop gate
enforces it).
