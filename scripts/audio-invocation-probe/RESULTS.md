# Audio-invocation spike — RESULTS

Date: 2026-08-12 · branch `wt-audio` (worktree) · probe: `scripts/audio-invocation-probe/`

## Verdict

**The full tabCapture audio chain runs end-to-end on this box with no human
click.** Puppeteer 25.6.0's `page.triggerExtensionAction()` exists, fires
`chrome.action.onClicked` for this no-popup action, satisfies the tabCapture
invocation requirement, and the extension's own pipeline reports
`AnalyserNode` RMS 0.2832 (tone: 440 Hz oscillator at gain 0.4). Runbook gate
2 (human click) is **not needed** for automated verification on this box.

## Environment

- OS: Linux (WSLg), no `/dev/snd`, no local pulse/pipewire binaries. A live
  PulseAudio socket exists at `/mnt/wslg/runtime-dir/pulse/native`
  (symlinked from `$XDG_RUNTIME_DIR/pulse/native`) — Chrome's audio service
  connects to it, tabs become `audible`, and tab audio flows without physical
  speakers.
- Display: none in the shell — probe runs headed under `xvfb-run -a`.
- Chrome: CfT 151.0.7922.34 (Playwright's `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`),
  auto-resolved by the probe (newest `chromium-*` build wins; `PROBE_CHROME` overrides).
- Puppeteer 25.6.0 (devDependency, this spike's only package.json addition).

## Run

```sh
bun run build          # .output/chrome-mv3
xvfb-run -a bun run scripts/audio-invocation-probe/probe.ts
```

Launch flags: headed, `enableExtensions: [<ext dir>]` (avoids
`--disable-extensions`, loads via CDP `Extensions.loadUnpacked`), plus
`--autoplay-policy=no-user-gesture-required` so the tone tab's AudioContext
starts without a click. No `--load-extension`, no `--no-sandbox` needed.

## Step-by-step outcome

| # | Step | Result | Detail |
|---|------|--------|--------|
| 1 | `triggerExtensionAction` exists | PASS | Puppeteer 25.6.0: `page.triggerExtensionAction(ext)` → CDP `Extensions.triggerAction {id, targetId}`. Sent without error on CfT 151. |
| 1b | Fires `onClicked` for a no-popup action | PASS | Orchestrator entered `startFromAction` with the clicked tab (mirror `tabId` written, capture started). |
| 2 | Invocation satisfied (`getMediaStreamId`) | PASS | No "has not been invoked" error; `getMediaStreamId({targetTabId})` resolved. |
| 3 | Offscreen `getUserMedia(streamId)` | PASS | State `starting` → `capturing` (started event delivered; offscreen doc acked `offscreen-start`). |
| 4 | AnalyserNode level > 0 | PASS | Max observed level 0.2832 via `probe-state` message from the options page. |

Exit code 0; all steps print `PASS`/`FAIL` with exact errors.

## Semantics discovered (the spike's primary question)

`Extensions.triggerAction` simulates a **toolbar-icon click**: `chrome.action.onClicked`
receives the **active tab of the window**, not the tab whose id is passed as
`targetId`. First run captured the options page (active at trigger time):
state went `capturing` with level 0.0000 — the chain worked, the target was
silent. Fix (probe-side only): `tone.bringToFront()` immediately before
triggering; the mirror then shows the tone tab (audible) and level 0.2832.

## Failure trail (exact errors, in order)

1. **First run — level 0.0000, state `capturing`.** Cause: wrong capture
   target (options page active at trigger time, `triggerExtensionAction`
   active-tab semantics). No extension error text; diagnosed via the
   `audible` flag (`chrome.tabs.query`) added to the probe: captured tab
   `silent`, tone tab `audible`. Fixed by bringing the tone tab to front.
2. **xdotool fallback — not attempted.** `xdotool` is not installed on this
   box; the constraint allowed one such attempt only if present. It was
   unnecessary: step 1 already fired `onClicked` programmatically.
3. **No other failures.** No sandbox, DISPLAY, or audio-device errors; no
   invocation-guidance error observed.

## Notes

- Level is not in the `storage.session` mirror (`probeCapture` holds
  state/tabId/error only); the probe reads the live level via the
  `probe-state` runtime message from the options page. **No extension code
  was modified** — zero instrumentation needed.
- `knip.json`: entry glob widened `scripts/*.ts` → `scripts/**/*.ts` so the
  nested probe script counts as an entry for the knip/aislop dependency gate
  (without it, `puppeteer` reads as an unused devDependency).
- The probe dir is not picked up by vitest (specs live in `tests/`).
- Determinism note: the extension id is path-derived and stable across runs
  (`bhhilgaghkkdfdickjankgicdaocdnba`), so the options-page URL is reliable.

## Runbook implication

Gate 2 of `docs/manual-gates-runbook.md` (human click on the toolbar icon) can
be closed for automated verification on this box: the invocation gesture is
synthesizable via Puppeteer's `Extensions.triggerAction`, and the level
assertion is readable through the extension's own `probe-state` channel. The
human-click gate remains the portable fallback for boxes without CfT 151+ /
Puppeteer 25 / a PulseAudio socket.
