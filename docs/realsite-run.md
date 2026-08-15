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

The e2e build is produced automatically when missing **or stale**: the mtime
of `.output/chrome-mv3-e2e/content-scripts/content.js` is compared against
HEAD's commit date (`git log -1 --format=%cI HEAD`); older than HEAD ⇒
`bun run build:e2e` first. A rebuild is ~1 min — over-building is cheaper
than a false run. `--no-rebuild` skips the check and runs whatever build is
on disk.

Flags:

| Flag | Meaning |
|---|---|
| `--headless` | override the default (headed) |
| `--limit N` | smoke run: sample the first N videos only |
| `--video=ID` | sample one video (any id; defaults to `speech`) |
| `--kind=speech\|music\|live` | expected class for `--video` runs |
| `--threshold=N` | pass-ratio bar, default 0.8 — sets BOTH the overall bar and the speech-class floor |
| `--speech-threshold=N` | the speech-class floor alone (overrides `--threshold` for that bar only) |
| `--no-rebuild` | skip the staleness check — run the on-disk build as-is |
| `--profile=PATH` | reuse the userDataDir at PATH (a real logged-in YouTube session); the anonymous mkdtemp default otherwise |
| `--login` | one-time profile build: open youtube.com in `--profile`, wait for the session cookie, exit |
| `--ignore-repeats` | skip the repeat-failure exit (the re-verification escape after a fix); the repeat list still prints |

Results: `scripts/data/realsite-run/results.jsonl`, appended live per video
so a mid-run kill never loses completed samples. Each run appends a marker
line (`{"runStart": …}`) before its first record — the repeat check groups
the history into runs by these markers.

## Logged-in sessions (`--profile`)

The logged-in session class (the S4 finding: it escapes every anonymous
runner) is exercised by reusing a real profile dir: `--profile=<path>`
launches the persistent context at that path as-is (no mkdtemp), so the
extension runs inside the profile's own signed-in YouTube session. The
anonymous default (no flag) keeps the fresh-mkdtemp + consent-cookie
behavior.

One-time profile build — headed, on the box with a display:

```bash
bun run scripts/realsite-runner.ts --profile ~/.speedwatcher-realsite --login
```

The runner opens youtube.com and waits for the session cookie (SID) to
appear; complete the sign-in in the opened window. `--login` exits 0 when
the session landed, 1 after 5 minutes without one. From then on, runs are
plain:

```bash
bun run scripts/realsite-runner.ts --profile ~/.speedwatcher-realsite
```

**Signed-in assertion per run.** The record carries a `signedIn` field,
true only when BOTH hold: the SID session cookie in the CDP cookie jar
(SID is httpOnly — `document.cookie` cannot see it, so the assertion reads
the cookie jar) and the signed-in avatar button (`#avatar-btn`) in the
topbar. A profile whose session expired records `signedIn=false` — an
honest 'anonymous' record, never a silent logged-in claim. The consent
cookies are skipped for profile runs (the profile's own cookies are the
point of those).

**Staleness.** When the profile's cookie file
(`Default/Network/Cookies` or `Default/Cookies`) was last written more
than 14 days ago, the runner warns that the session may have expired and
to re-run `--login` once — a warn, never a block (the same mtime pattern
as the e2e-build staleness check). A missing profile dir also warns (a
fresh profile would be created, signed out).

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
   source (`web` / `android` / `none`), the signed-in assertion
   (`signedIn`, see the `--profile` section), the `[speed-watcher]`
   console lines, and the page title.
4. Records the pill placement geometry: the `.pill` and `#movie_player`
   rects, whether the pill is fully inside the player (containment), how
   far its bottom sits above the player's bottom (clears ≥ 60px — clear of
   the right-cluster control buttons, which the 2026 player places 12–60px
   above the bottom), and whether the pill is the hit target at its
   center (`elementFromPoint` — anything else means something covers it).

## Pass criteria

| Video class | Must hold |
|---|---|
| `speech` (talks, lectures, podcasts, explainers) | pill rendered (`mode != none`), caption source `web` or `android` (not `none`), measured rate in 100–600 in the language's unit, pill fully inside the player (containment), ≥ 60px above the player's bottom (clear of the control-button band), and the hit target at its center (not occluded) |
| `music` (control) | pill mode `music` — the "speed not recommended" suppression |
| `live` (control) | pill mode `none` — live suppression |

Exit codes — the verdict (scripts/realsite-verdict.ts), first failing gate
wins:

| Code | Gate |
|---|---|
| 0 | pass — all bars held |
| 1 | overall pass ratio below `--threshold` |
| 2 | usage error |
| 3 | speech-class floor: the speech class held below the threshold separately — the overall ratio is the secondary bar |
| 4 | repeat failure: a video failed with a classification it also failed with in the last 2 runs — a fix is forced regardless of the ratio; `--ignore-repeats` re-verifies without the exit |
| 5 | signed-out `--profile` lane: a `--profile` run recorded `signedIn=false` — re-login and re-run |

The console table stratifies every failing video with its reason
(`no-pill-render` / `bot-wall` / `live suppression: mode=…` / …).

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

- **2026-08-15 run 2 — player-anchored pill placement (wt-pillzone).**
  10/10 videos sampled, pass ratio **8/10 (80%)** — exit 0 (threshold 80%).
  Every speech video with a caption source rendered the pill **inside** the
  player, clearing the controls bar (`clears=yes`), not occluded at its
  center (`occ=no`) — the absolute-in-player placement holds on real
  YouTube, including the two lecture videos in theater-ish wide layouts.
  The two failures are the known non-geometry set: `fpbOEoRrHyU` lost its
  caption fetch (source=none, rate n/a) and the music control
  `dQw4w9WgXcQ` hung past the 3-min deadline (same as run 1). Live controls
  pass (mode=none); their hidden pill reports `clears=no`/`occ=yes`
  because the hidden state drops pointer-events — placement gates apply to
  visible speech pills only.

  | videoId | category | kind | mode | rate | source | pill | clears | occ | result |
  |---|---|---|---|---|---|---|---|---|---|
  | `iG9CE55wbtY` | talk | speech | recommend | 140.5 | capture | inside | yes | no | **PASS** |
  | `Ks-_Mh1QhMc` | talk | speech | recommend | 160.9 | capture | inside | yes | no | **PASS** |
  | `HtSuA80QTyo` | lecture | speech | recommend | 110.8 | capture | inside | yes | no | **PASS** |
  | `jGwO_UgTS7I` | lecture | speech | recommend | 142.9 | capture | inside | yes | no | **PASS** |
  | `ycPr5-27vSI` | podcast | live | none | — | — | inside | no | yes | **PASS** — live suppression |
  | `fpbOEoRrHyU` | news-comedy | speech | recommend | n/a | none | inside | yes | no | FAIL — caption fetch failed |
  | `WUvTyaaNkzM` | explainer | speech | recommend | 150.2 | capture | inside | yes | no | **PASS** |
  | `7Pq-S557XQU` | explainer | speech | recommend | 159.6 | capture | inside | yes | no | **PASS** |
  | `dQw4w9WgXcQ` | music | music | — | — | — | — | — | — | FAIL — page hung past the 3-min deadline |
  | `jfKfPfyJRdk` | live | live | none | — | — | inside | no | yes | **PASS** — live suppression |

- **2026-08-15 run 1 — invalidated (stale build).** 10/10 videos sampled,
  pass ratio **2/10 (20%)** — exit 1. This run sampled against a stale
  `.output/chrome-mv3-e2e` (predating the merged fixes), so it measured an
  old bundle: only the two live controls passed. **The same sample on a
  fresh `bun run build:e2e` passed 8/10** — the stale bundle's false 2/10 is
  the incident that added the staleness check above (rebuild when the build
  predates HEAD; `--no-rebuild` opts out). Table and finding below are from
  this invalidated run.

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

  **Finding (run 1 — invalidated, see above):** the run-1 failures logged
  `[speed-watcher] wpm: caption fetch failed — estimated` on every speech
  video and the music control, pointing at the bare `track.baseUrl` fetch as
  the POT-gated path the audit flagged — but that was the stale bundle; the
  fresh build passes the same sample set 8/10. Live detection is healthy on
  real live content (2/2, including the JRE #1169 live re-broadcast), and
  the pill renders on real pages (layout/stacking class: no issues
  observed).
