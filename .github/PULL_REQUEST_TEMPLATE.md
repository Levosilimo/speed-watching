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
- [ ] Behavioral change? Add a `CHANGELOG.md` entry
- [ ] New UI copy? Both locales updated: `lib/i18n.ts` (en) +
      `lib/i18n-ru.ts` (ru), type-checked by the parity test
- [ ] New `sw.*` storage key? Migration note included (old profiles must
      not read an undefined shape)

## Notes

Anything a reviewer should know: trade-offs, follow-ups, manual test steps.
