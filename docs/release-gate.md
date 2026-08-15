# Release gate (box-gated checklist)

The release gate is a box-run procedure, not a CI flag: it needs a
residential machine and real youtube.com sessions. Sections 1, 0.5, 2, 3 and
6 are the per-release checklist — work through them in order; a failure at
any step stops the release. Sections 4–5 are the standing machinery that
feeds the release: the scheduled box runs and the bug-repro path.

## 1. Fresh build

```sh
bun run build
```

The release runs against the build produced from the release commit. A
stale `.output` from a previous checkout does not count — delete
`.output/` before building if there is any doubt.

## 0.5. Logged-in lane

The signed-out real-site run (section 2) hits the POT gate on the `exp=xpe`
video class: the bare timedtext fetch returns 200-empty and the pill falls
to the estimated tier. Signed in, the player's own request carries the
signed context and those videos measure through the capture path (caption
source `capture` — the request the content script intercepts). This lane
builds the signed-in profile once, then reuses it for every release.

**One-time profile build** — headed run, log in, let it finish:

```sh
bun run scripts/realsite-runner.ts --profile=~/.speedwatcher-logged-in
```

The run is headed by default, so a browser window opens on the residential
machine. Log into YouTube in that window; the run finishes and the signed-in
session persists in the profile directory. One profile serves all later
runs; there is no per-release login.

**Per-release `--profile` run** — before section 2, on the same fresh build:

```sh
bun run scripts/realsite-runner.ts --profile=~/.speedwatcher-logged-in
```

The signed-in assertion: the run records whether the session is signed in
(the player response carries the signed context; a signed-out session shows
LOGIN_REQUIRED on the ANDROID tail). A signed-out run is a lane failure, not
a video failure — re-login and re-run.

**Pass criteria:** every `exp=xpe`-class video in the corpus measures via
the capture path — source `capture`, not `none`, not estimated. A video that
measured `none` signed-out is expected to measure signed-in; if it still
lands on `none`, its failure is the regression tracker for the next wave.

## 2. Real-site run on the fresh build

```sh
bun run scripts/realsite-runner.ts --headless
```

- Pass ratio must be **≥80%** on this run. Below the bar does not ship.
- The run appends to `scripts/data/realsite-run/results.jsonl`. That file is
  the oracle — the only non-LLM artifact. Entries are **never edited or
  deleted** to make the ratio pass; a failed entry stays failed and is the
  regression tracker for the next wave.
- Commit the new `results.jsonl` with the release. The diff against the
  previous release's file is the regression linkage: same corpus, same
  thresholds, pass ratio compared line by line. A ratio that dropped needs a
  wave commit that fixes it before the release proceeds.

## 3. Golden-master human checkpoint

The recorded baseline changed (or held) in step 2. One pair of eyes reviews
the golden-master diff — this is the only gate that cannot mirror. Sign the
checkpoint in the release PR:

```
Golden-master diff reviewed: <date> — <reviewer>
```

No script replaces this line. Without it the release does not ship.

## 4. Scheduled box runs

Box runs are scheduled, not ad hoc: the residential machine runs the
real-site runner weekly, whether or not a bug report demands it. A systemd
user timer (cron is the same command on a different schedule) drives it:

```ini
# ~/.config/systemd/user/speedwatcher-realsite.service
[Unit]
Description=Speed Watcher weekly real-site run

[Service]
Type=oneshot
WorkingDirectory=/home/<user>/code/speed-watching
ExecStart=/home/<user>/.bun/bin/bun run scripts/realsite-runner.ts
StandardOutput=append:/home/<user>/.local/state/speedwatcher/realsite.log
StandardError=append:/home/<user>/.local/state/speedwatcher/realsite.log
```

```ini
# ~/.config/systemd/user/speedwatcher-realsite.timer
[Unit]
Description=Weekly real-site run

[Timer]
OnCalendar=Mon 06:00
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user enable --now speedwatcher-realsite.timer
```

- `ExecStart` needs the absolute bun path — systemd user units do not
  inherit the login shell's PATH.
- The run appends to `scripts/data/realsite-run/results.jsonl` live per
  video and exits 0/1 against the `--threshold` bar (0.8 by default). The
  exit code is the alert: a failing timer means a below-bar week, and the
  log at `~/.local/state/speedwatcher/realsite.log` carries the verdict
  line.
- The staleness check runs automatically: the runner rebuilds the e2e build
  when it predates HEAD. A scheduled run on a stale checkout measures an old
  bundle — the run-1 incident measured 2/10 on a stale build where the fresh
  build passed 8/10. If a scheduled run looks wrong, check the log's rebuild
  line before reading the ratio.
- Regression linkage: every scheduled run's records are compared against the
  previous run's — same corpus, same thresholds. A video that fails with the
  same classification twice in a row forces a fix commit; it does not wait
  for the next release to re-measure.

## 5. Issue repro workflow

A bug report becomes a repro command before anyone reads the extension code.
The issue template (.github/ISSUE_TEMPLATE/bug_report.yml) captures the
three fields the repro needs — the video ID, the expected kind, and the
pill-reason string — and the maintainer runs:

```sh
bun run scripts/realsite-runner.ts --video=<ID> --kind=<speech|music|live> [--profile=<path>]
```

- `--kind` picks the pass criteria: speech videos must render a measured
  rate, live videos must suppress (mode `none`), music videos must show the
  music mode.
- `--profile` replays the report under the signed-in lane when the reporter
  was signed in (the `exp=xpe` class); omit it for a signed-out repro.
- The failing `results.jsonl` entry goes back into the issue thread with the
  reporter's pill-reason string. A repro whose pill reason differs from the
  report's is a second bug, not the same one.

## 6. Stryker tripwire

The nightly mutation run must not exceed **65 survivors** on the release
commit. On breach, fix the surviving mutants — never add tests that paper
over them. The tripwire is checked against the same commit that ships.

## Ship

All release gates green — fresh build, logged-in lane, real-site run,
golden-master sign-off, Stryker tripwire — the sign-off line present, the
`results.jsonl` diff committed: the release proceeds to the normal PR and CI
path.
