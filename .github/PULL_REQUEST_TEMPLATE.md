## What

One short paragraph: the behavior change and why it exists. Link the issue
if there is one.

## DoD

Check what applies; everything must be green before merge.

- [ ] `bun run typecheck`, `bun run lint`, `bun run knip` pass
- [ ] `bun run test` passes
- [ ] `bun run build` passes and the CI e2e lanes are green
      (chromium / cft / firefox / userscript)
- [ ] `bun run check` — the aislop prose gate — passes
- [ ] Bug fix? The `test:` commit fails on the old code and was never
      squashed into the `fix:`
- [ ] Count-scan findings explained: every spyOn / toHaveBeenCalled* hit in
      the touched specs has a reason, or the scan is clean
- [ ] Touched specs probe a complementary case the fixtures don't cover; no
      skipped/disabled assertions in them
- [ ] A mutant on each touched function fails its test
- [ ] Synthetic fixtures trace to a real captured payload (a
      `scripts/data/*/results.jsonl` record or a recorded video ID)
- [ ] Behavioral change? Add a `CHANGELOG.md` entry
- [ ] New UI copy? Both locales updated: `lib/i18n.ts` (en) +
      `lib/i18n-ru.ts` (ru), type-checked by the parity test
- [ ] New `sw.*` storage key? Migration note included (old profiles must
      not read an undefined shape)

## Notes

Anything a reviewer should know: trade-offs, follow-ups, manual test steps.
