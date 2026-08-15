# Real-site extension runner (box-gated manual tier)

Drives the **built extension itself** (`.output/chrome-mv3-e2e` — the
`__E2E__` window hooks and `[speed-watcher]` console lines are live) against
real `youtube.com` videos: `scripts/realsite-runner.ts`. This is the manual
QA loop from the e2e-reality audit, formalized — the fixture suite
(`e2e/`) proves math and wiring on synthetic pages; this runner proves the
**real-session class**: layout/stacking of the pill host, the POT-gated
caption fetch (the player's signed context, not the fixture server), live
and music detection, and real session state.

The machinery is proven on this box: `scripts/gate1-residential.ts` and
`scripts/sample-captions.ts` drive CfT Chromium against real youtube.com
(signed-request interception, CC-menu ASR re-pick, the 24-video corpus). The
runner adds the extension to that recipe.

## Run

From the repo checkout **on the residential machine** (root of a checkout,
not inside this docs folder):

```bash
bun install --frozen-lockfile   # if node_modules is missing
bun run scripts/realsite-runner.ts
```

The e2e build is produced automatically if absent (`bun run build:e2e`).

Flags:

| Flag | Meaning |
|---|---|
| `--headless` | override the default (headed) |
| `--limit N` | smoke run: sample the first N videos only |
| `--video=ID` | sample one video (any id; defaults to `speech`) |
| `--kind=speech\|music\|live` | expected class for `--video` runs |
| `--threshold=N` | pass-ratio bar, default 0.8 |

Results: `scripts/data/realsite-run/results.jsonl`, appended live per video
so a mid-run kill never loses completed samples.

## What it does per video

1. Launches a fresh persistent context with the built extension side-loaded
   (the `e2e/chromium/e2e.spec.ts` pattern), consent cookies pre-seeded, UA
   matched to the CfT build (the `gate1-residential.ts` pattern). One
   browser per video — chromium on this box freezes under sustained page
   churn, so recycling caps a freeze to the video it hit (the `vk-probe.ts`
   watchdog + per-video deadline are reused verbatim).
2. Navigates to the watch page and waits for the pill hook
   (`window.__speedwatcherPill`) to render — the content script dispatches
   `speedwatcher:measure` and sets `__speedwatcherCaptionSource` in the
   `__E2E__` build, which the runner mirrors onto
   `window.__speedwatcherLastMeasure` via an init script (the userscript
   hook shape).
3. Records per video: pill `mode` + tier label, the best measured rate
   (word → cue → corrected, in the track language's unit), the caption
   source (`web` / `android` / `none`), the `[speed-watcher]` console lines,
   and the page title.

## Pass criteria

| Video class | Must hold |
|---|---|
| `speech` (talks, lectures, podcasts, explainers) | pill rendered (`mode != none`), caption source `web` or `android` (not `none`), measured rate in 100–600 in the language's unit |
| `music` (control) | pill mode `music` — the "speed not recommended" suppression |
| `live` (control) | pill mode `none` — live suppression |

Exit code **0** when the pass ratio over all sampled videos is ≥ the
threshold (80% by default), **1** otherwise. The console table stratifies
every failing video with its reason (`no-pill-render` / `bot-wall` /
`live suppression: mode=…` / …).

## When to run

- After any change to the content script, the pill UI, the measure pipeline,
  or the e2e surface (the window hooks the runner reads).
- Before a release, as the last pre-ship check on the box.

## Box requirements

- The residential machine (never a datacenter IP — the POT-gated caption
  path and bot-wall behavior are IP-class-dependent).
- Playwright's chromium (CfT) installed — the same prerequisite as the e2e
  suite and `gate1-residential.ts`.
- A display for the default headed mode (or pass `--headless`).
- `bun` and network access to youtube.com.

## Honest limits

- **Not CI.** This is a box-gated manual tier by design: real YouTube
  serves bot-walls to datacenter IPs, video availability and live streams
  change, and a run takes ~2 min/video. CI stays fixture-only
  (`bun run e2e:chromium`).
- The live control (`jfKfPfyJRdk`, Lofi Girl radio) is always-live but not
  guaranteed; when it is offline, re-run it with
  `--video=<another live id> --kind=live`.
- A video that fails the criteria is recorded with its reason; the runner
  does not fix extension code — extension-side failures from a run feed the
  next fix wave.

## Status

- **2026-08-15 first run** (current main build, residential box, headed):
  10/10 videos sampled, pass ratio **2/10 (20%)** — exit 1, as designed.

  | videoId | category | kind | mode | source | result |
  |---|---|---|---|---|---|
  | `iG9CE55wbtY` | talk | speech | recommend (estimated) | none | FAIL — caption fetch failed |
  | `Ks-_Mh1QhMc` | talk | speech | recommend (estimated) | none | FAIL — caption fetch failed |
  | `HtSuA80QTyo` | lecture | speech | unreachable (estimated) | none | FAIL — caption fetch failed |
  | `jGwO_UgTS7I` | lecture | speech | recommend (estimated) | none | FAIL — caption fetch failed |
  | `ycPr5-27vSI` | podcast | live | none | — | **PASS** — live suppression |
  | `fpbOEoRrHyU` | news-comedy | speech | recommend (estimated) | none | FAIL — caption fetch failed |
  | `WUvTyaaNkzM` | explainer | speech | unreachable (estimated) | none | FAIL — caption fetch failed |
  | `7Pq-S557XQU` | explainer | speech | unreachable (estimated) | none | FAIL — caption fetch failed |
  | `dQw4w9WgXcQ` | music | music | — | — | FAIL — page hung past the 3-min deadline (prior run: recommend-estimated) |
  | `jfKfPfyJRdk` | live | live | none | — | **PASS** — live suppression |

  **Finding (extension-side, feeds the next fix wave — not fixed here):** the
  extension's own caption fetch fails on real sessions from this box — every
  speech video and the music control logged `[speed-watcher] wpm: caption
  fetch failed — estimated` (both the WEB `fetchJson3` and the ANDROID
  innertube fallback returned nothing), so the pill fell back to the
  estimated tier (`recommend`/`unreachable`) and music detection never ran.
  The same videos' *player-signed* requests work on this box
  (`gate1-residential.ts` 2026-08-13: `web-ok`, word/cue counts intact) —
  the bare `track.baseUrl` script fetch is the POT-gated path the audit
  flagged. Live detection is healthy on real live content (2/2, including
  the JRE #1169 live re-broadcast), and the pill renders on real pages
  (layout/stacking class: no issues observed).
