# Phase 0 Lane B: tab → offscreen → AudioContext audio path — gate report

Measured 2026-08-11 in the datacenter environment (Playwright Chromium 149/151
builds, headed under Xvfb). Purpose: de-risk the Phase 2 STT bet that MV3 tab
audio can be routed through an offscreen document into an AudioContext, and
answer the three known failure modes. The code is a throwaway probe, not
production.

## What was built

| file | role |
|---|---|
| `entrypoints/offscreen.html` + `entrypoints/offscreen/main.ts` | offscreen document: `getUserMedia({chromeMediaSource:'tab'})` → `AudioContext` → `AnalyserNode`; level meter every 300 ms; handles `offscreen-start` / `offscreen-stop` / `offscreen-wasm-check` |
| `entrypoints/background.ts` | wires `lib/capture-orchestrator.ts` to `browser.*`; answers options messages, stays silent for bounced offscreen messages |
| `entrypoints/options/index.html` + `main.ts` | the user-gesture host: Test button, state line, live meter, wasm/COI line, transition log |
| `lib/capture-orchestrator.ts` | state machine: `idle → starting → capturing`, `degraded` on tab switch/close/track end, `error`; mirrors state to `storage.session`; adopts a live capture on SW restart; creates/reuses the single offscreen document; retries message delivery until the offscreen acks |
| `lib/audio-capture.ts` | offscreen audio plumbing, injectable for tests |
| `lib/audio-probe.ts` | message protocol types + guards, `rmsLevel`, wasm/COI probe |
| `scripts/phase0-audio-probe.ts` | Playwright probe that loads the built extension and drives the options flow; `PROBE_HEADED=1` for a real display |
| `docs/phase0-offscreen-audio.md` | this report |

Manifest change: `tabCapture` added to `permissions` (required, per plan-v3);
`min_chrome_version` stays 116; nothing else added. Built manifest verified:
`permissions: ['storage', 'tabCapture']`, no `content_security_policy` key, no
new hosts.

## Architecture decisions the probe pinned down

- **Message ownership split.** Every extension context receives every
  `runtime.sendMessage`. The background answers `probe-*` and `offscreen-event`
  messages and returns `false` for `offscreen-*`; the offscreen document
  answers only `offscreen-*`. Without the split, the background's own listener
  would consume the forward's response and delivery detection would break.
- **Ack-based delivery.** `forwardToOffscreen` treats the offscreen document's
  `{received: true}` response as delivery. Rejection or `undefined` means the
  listener is not attached yet (the document was just created) → retry up to
  10 × 150 ms. Chrome's `runtime.sendMessage` promise is used raw — no
  polyfill — so the `return true` + `sendResponse` listener pattern is
  required (Chrome < 148).
- **`USER_MEDIA` reason.** `AUDIO_PLAYBACK` auto-closes an offscreen document
  after 30 s without audio; `USER_MEDIA` has no idle eviction, which is the
  right reason for a capture that may sit on silence.
- **No destination node.** `source → analyser` only. A destination would
  re-play the captured tab audio (echo risk); the analyser keeps the graph
  alive and is the level source.
- **Single-document constraint.** A `streamId` is bound to the renderer
  running the offscreen document. The document is created before the id is
  fetched, and any recreation must fetch a fresh id. One document per
  extension is enforced by Chrome; `getContexts()` (not `hasDocument()`,
  Chrome 150+) checks existence.
- **SW restarts don't kill the capture.** The offscreen document holds the
  stream; the background only orchestrates. `storage.session` mirrors the
  state so a restarted SW re-adopts a live capture (or degrades it if the
  document is gone).

## What was proven in this environment

Ran: `bun run build`, manifest inspection, `vitest run` (67 tests), the
Playwright probe headed under Xvfb, and the CSP checks below.

**PROVEN (measured):**

- Manifest is exactly `['storage', 'tabCapture']`, min 116, and the built
  `offscreen.html`/`options.html` pages ship with their scripts.
- The extension loads; the service worker starts; the options page loads and
  answers `probe-state` correctly (`{"state":"idle","level":0}`) — background
  wiring, message routing, and the `sendResponse` pattern work.
- `chrome.tabCapture` is exposed in the service worker (the user-gesture
  `getMediaStreamId` call is reachable; its runtime behavior needs Chrome).
- The orchestration state machine: 24 unit tests covering `idle → starting →
  capturing`, stop-then-restart, tab-switch and tab-close degradation,
  track-ended degradation, offscreen error propagation, ack retry/backoff,
  bounce-message filtering, SW-restart adoption, mirror writes, and
  level-without-mirror-churn.
- The offscreen audio plumbing: 6 unit tests with fakes (graph wiring,
  rms meter, getUserMedia rejection, teardown on stop and on track end,
  restart).
- **WASM CSP: WebAssembly is BLOCKED in extension pages.** Live error from
  `WebAssembly.compile` in the options page: violates CSP
  `"script-src 'self'"`. WXT 0.21 applies its `wasm-unsafe-eval` CSP only in
  dev mode (`addDevModeCsp`); production builds omit `content_security_policy`
  entirely, so Chrome's MV3 default (`script-src 'self'; object-src 'self'`)
  applies. This affects the offscreen document identically — same CSP.
- **SharedArrayBuffer is available in extension pages** in Chromium 149/151
  without cross-origin isolation, while web pages in the same browser still
  report `SharedArrayBuffer is not defined`. Extension contexts are exempt
  from the COI requirement in these builds.

**NOT-PROVEN (impossible in this environment at the time; superseded in
part 2026-08-12):**

- ~~`chrome.offscreen` does not exist in Playwright's Chromium builds~~ —
  **SUPERSEDED.** Playwright 1.62.1's managed Chromium build is Chrome for
  Testing 151.0.7922.34 (Playwright ≥ 1.57 ships CfT as its default managed
  Chromium; `playwright install chrome` installs nothing — it expects a
  system Chrome). CfT is real Chrome: `chrome.offscreen` is present and
  `createDocument`/`getContexts`/`closeDocument` work, headless and headed.
  The offscreen API and the orchestrator's error path are now E2E-covered on
  the CfT lane (`e2e/chromium/offscreen.spec.ts`, CI job `e2e-chromium-cft`;
  see `docs/ci-e2e.md`).
- **`chrome.tabCapture.getMediaStreamId` is gated on activeTab-style
  invocation** (measured 2026-08-12 on CfT 151, headless and headed, and
  matching the current Chrome docs: "Only tabs for which the extension has
  been granted the activeTab permission can be used as the target tab").
  Every variant (`targetTabId`, default active tab, `consumerTabId`) rejects
  with `Extension has not been invoked for the current page (see activeTab
  permission). Chrome pages cannot be captured.` — even with the extension's
  content scripts running in the target tab. The extension declares neither
  `activeTab` nor `scripting` and has no action entrypoint, so the
  orchestrator cannot obtain a streamId; the probe lands on its documented
  `tabCapture failed:` error path. **Implication for the manual test below:
  the same failure is expected on real Chrome until the manifest gains
  `activeTab` (or `scripting`) and an invocation path** (action-icon click /
  keyboard shortcut, or a no-op `executeScript` on the target tab — the
  Cap/ScriptCat pattern). The manual gate documents this exact error as the
  expected blocked-by-design result (`docs/manual-gates-runbook.md`).
- Consequently: the `streamId → getUserMedia → AudioContext` chain, the level
  meter reading a real tab, tab-switch degradation live, and the 30 s idle
  behavior are all unverified. Nothing in this report claims audio flowed.
- The user-gesture requirement on `getMediaStreamId` (call from the options
  page click, through the background) — code path exercised, real gesture
  unverified.

## Failure-mode checks

1. **30 s idle eviction.** Not measurable here (no offscreen API). Design
   answer: `USER_MEDIA` reason has no idle close; `AUDIO_PLAYBACK` would close
   after 30 s of silence. Manual check: start capture, wait > 30 s with audio
   still playing; status must stay `capturing`.
2. **Tab switch.** Unit-tested (`degraded` + `offscreen-stop` forwarded;
   switching back to the captured tab does not interrupt; closing the captured
   tab degrades; a late `stopped` event keeps `degraded`). Live behavior on
   Chrome unverified. The options page polls state every 400 ms, so the
   transition shows within a second.
3. **WASM CSP.** Measured: production extension pages run `script-src 'self'`
   → wasm compilation fails with the CSP violation shown above. The offscreen
   doc's `wasm-check` will report `ok: false` until the manifest is changed.
   SAB: measured available in extension pages (Chromium 149/151).

## Manual test procedure (user's machine)

Prereqs: real Chrome ≥ 116 with audio output, a video with speech.

1. `bun run build`, then load unpacked: `chrome://extensions` → Developer mode
   → Load unpacked → `.output/chrome-mv3/`.
2. Keep a video tab playing (this is the capture source) and open the options
   page in another tab.
3. Click **Test audio capture**. Expected: status goes `starting` →
   `capturing` within ~2 s; the meter bar tracks speech; the wasm line reads
   `wasm: BLOCKED` (until Phase 2 adds the CSP) and a SharedArrayBuffer
   verdict. If instead the status shows an error, the log explains which hop
   failed — `tabCapture failed: ...` means the gesture didn't propagate, and
   anything mentioning `getUserMedia` means the streamId was rejected in the
   offscreen document.
4. Pause the video or play silence: meter must drop to ~0 while status stays
   `capturing`.
5. Switch to a third tab: status must show `degraded — tab switched away`
   within a second.
6. Click **Test audio capture** again (restart), then click **Stop audio
   capture**: status returns to `idle`.
7. 30 s idle check: capture again, wait > 30 s, status must still be
   `capturing` (USER_MEDIA has no idle eviction).
8. Optional: run `PROBE_HEADED=1 xvfb-run -a bun run scripts/phase0-audio-probe.ts`
   on a machine with Xvfb, or point the probe at a real Chrome executable if
   one is available; it drives the whole flow and prints a verdict.

Expected result on real Chrome: level > 0 during speech proves the chain. If
the level stays 0 with status `capturing`, tab audio is not reaching the
offscreen AudioContext — the Phase 2 bet is falsified and the fallback is
page-context capture via the content script (different permission surface,
to be researched).

## Phase 2 implications

- **The WASM STT path needs an explicit CSP change.** With the current
  manifest, no WebAssembly can run in the offscreen document. When Phase 2
  picks a WASM model, `wxt.config.ts` must set
  `content_security_policy.extension_pages` to
  `"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"` (WXT's own dev
  default) — one line, but a manifest change with CWS review implications.
  This lane deliberately left the manifest otherwise untouched.
- **WebGPU vs WASM:** WASM is viable once the CSP lands; WebGPU in offscreen
  documents was not testable here and should not be assumed (verify on Chrome
  before choosing it). JS-only inference remains the zero-manifest-change
  fallback.
- **Multithreaded WASM (SharedArrayBuffer) looks promising** in Chromium
  149/151: SAB is constructible in extension pages without COI. Confirm on the
  user's Chrome; if it holds, ORT Web's threaded WASM may work, which matters
  for real-time transcription latency.
- **The audio path itself remains the open question.** Everything up to the
  offscreen API boundary is proven; the boundary and the audio flow need the
  manual test above. The offscreen doc already reports a numeric level, so
  the user's run produces a yes/no answer, not a log to interpret.

## Deviations and notes

- `vitest-chrome@0.1.0` was added as a devDependency per the lane brief but
  cannot load under vitest 3 (its CJS build `require()`s the ESM-only vitest
  entry). The glue test instead uses a hand-rolled chrome mock
  (`tests/chrome-mock.ts`, same Bitwarden shape); vitest-chrome stays in
  `package.json` with a knip ignore and this explanation. Worth revisiting
  when vitest-chrome ships a vitest-3-compatible release.
- ~~Playwright's Chromium builds disable the offscreen API — a general
  limitation, not specific to this repo. E2E coverage of offscreen documents
  is impossible on these builds regardless of the test framework (matches
  Playwright #26693).~~ **Stale as of 2026-08-12** — Playwright 1.62.1's
  managed build is CfT 151 with `chrome.offscreen` fully functional (see
  NOT-PROVEN above).
- The options page polls instead of receiving pushes; state transitions show
  within 400 ms. Good enough for a probe, revisit for production UX.
- `scripts/phase0-audio-probe.ts` exits 0 with the verdict
  `NOT TESTABLE HERE` when `chrome.offscreen` is absent, and 1 only if the
  browser run itself breaks.
