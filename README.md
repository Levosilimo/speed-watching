# Speed Watcher

WPM-based speed-watching extension for Chrome and Firefox. Reads the speech
rate of a video's captions and recommends a playback multiplier that lands
the effective rate in the 250–275 wpm range — a commonly cited comfortable
listening target — instead of guessing from content type.

## Features

- Measures the natural speech rate of word-timed captions (YouTube WEB and
  ANDROID caption payloads, silence-corrected)
- Recommends an exact playback multiplier to hit your target wpm
- Floating pill on the video: apply or dismiss with one click
- Pause-dilution warning when pause-heavy captions push speech past the range
- Content-type presets (lecture/talk/podcast/music) and per-site overrides
- Local-only habits report (recommendations applied, average multiplier)
- Estimated-tier fallback when captions are unavailable

## Stack

WXT 0.21, vanilla TypeScript, Chrome MV3 (min_chrome_version 116) and
Firefox 128+, bun as package manager, Vitest, oxlint, knip, Playwright
(chromium, Chrome-for-Testing, and firefox e2e lanes).

## Commands

- `bun run dev` — watch mode with HMR
- `bun run build` — production build to `.output/chrome-mv3/`
- `bun run build:firefox` — Firefox build (required before `e2e:firefox`)
- `bun run test` — vitest run
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — oxlint
- `bun run check` — aislop prose gate (same as the pre-commit hook)
- `bun run knip` — unused code and dependency check
- `bun run ci` — the CI pipeline (`scripts/run-ci.ts`)
- `bun run e2e:chromium` / `e2e:cft` / `e2e:firefox` — Playwright suites
  against the built extension (see `docs/ci-e2e.md`)
- `bun run check:cws` — offline CWS review scan over the built bundle

## Architecture

- `entrypoints/` — WXT entrypoints: `background.ts`, `content.ts` and
  `generic.content.ts` (player detection, caption harvest), `bridge.content.ts`,
  `options/` (options page; dev-only diagnostics live in `options/dev.ts` and
  ship in no store build)
- `lib/` — domain logic with no browser-surface code: caption parsing
  (`captions.ts`), wpm measurement (`wpm.ts`, `tokenizer.ts`), recommendation
  (`recommend.ts`, `heuristics.ts`), storage (`settings.ts`, `override-log.ts`,
  `demand.ts`), audio probe (`audio-probe.ts`, `capture-orchestrator.ts`)
- `ui/` — the pill (`pill.ts`, `styles.ts`) and options-page styles
- `tests/` — vitest specs for lib and ui modules
- `e2e/` — Playwright suites against the built extension; shared specs in
  `e2e/shared/specs.ts`
- `scripts/` — measurement harnesses and quality gates
- `docs/` — product, measurement, and store-submission records

## Measurement philosophy

Speed is measured per video from caption timing, not guessed from the source.
The 250–275 wpm target is a commonly cited comfortable listening range, not a
comprehension guarantee; the extension treats it as a heuristic, warns when
pause-heavy captions make the estimate uncertain, and ties every cited number
in store copy to the samples in `docs/phase0-caption-wpm.md`.

## Docs

- `docs/store-listing.md` — Chrome Web Store listing copy
- `docs/store-readiness.md` — submission checklist and bundle checks
- `docs/amo-listing.md` — Firefox AMO listing
- `docs/phase0-caption-wpm.md` — caption availability and wpm measurement
- `docs/phase0-generic-probe.md` — generic player detection
- `docs/phase0-offscreen-audio.md` — tab capture and offscreen audio probe
- `docs/demand-gate.md` — STT demand gate
- `docs/manual-gates-runbook.md` — manual verification gates
- `docs/phase2-whisper-benchmark.md` — on-device STT benchmark
- `docs/ci-e2e.md` — e2e setup and lanes
