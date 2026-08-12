# Manual Gates Runbook

Three verification gates need a machine the CI box cannot be: a residential
IP (gate 1) and a real Chrome with real tab audio (gate 2). Gate 3 is an
informational check. This runbook is written to be executed by an agent, not
a human: numbered steps, exact commands, pass/fail criteria.

What the datacenter box already proves is in `docs/phase0-offscreen-audio.md`
and `docs/ci-e2e.md`; this runbook only covers what those cannot.

## Agent operating model

Drive everything with the **agent-browser CLI** (`agent-browser` on PATH).
Not `@playwright/mcp` — its Chrome does not support loading extensions
(playwright-mcp#786). The Playwright-based harnesses (`e2e:*` scripts,
`scripts/sample-captions.ts`) are plain Node programs and are run with `bun`
directly; they are not agent-browser sessions.

Common launch flags (used by all three gates):

```bash
agent-browser \
  --extension .output/chrome-mv3 \   # load the built extension (gate 2 only)
  --headed \                          # headed: tab capture needs a real renderer
  --session-name gate2 \              # auto-save/restore cookies+localStorage
  --profile ~/.speedwatcher-profile \ # persisted Chrome profile (user-data dir)
  --args "--disable-blink-features=AutomationControlled" \
  --user-agent "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
```

- `--session-name` and `--profile` are the persistence mechanism: the first
  run establishes state, later runs restore it (YouTube login, consent
  dismissal, extension state).
- Extensions loaded via `--extension` work in the session; the extension ID
  is derived from the unpacked path and stays stable for the same path.
- Find the extension's options page: open `chrome://extensions`, Developer
  mode, find **Speed Watcher**, click **Details**, click **Extension
  options**; the URL is `chrome-extension://<id>/options.html` — read it with
  `agent-browser get url` on that tab.
- Gate 1 runs from the repo root of a checkout **on the residential machine**
  (the box whose IP is not a datacenter IP). Gates 2–3 run wherever a real
  Chrome with audio output exists.

---

## Gate 1 — residential WEB re-run

**What it validates:** the WEB timedtext caption path (the primary path, used
by the content script before any ANDROID fallback) from a residential IP:
windows-format `fmt=json3` parsing against real payloads, word availability,
and ASR-vs-manual track bias. It re-measures the half of the chain the
datacenter box measured as broken (`caption-fetch-empty` on WEB) and the
E2E suite deliberately stubs.

**Harness:** `scripts/sample-captions.ts` — drives 24 real YouTube videos
(4 talks, 3 lectures, 1 podcast, 1 news-comedy, 15 explainer/music), reads
`ytInitialPlayerResponse` (WEB track metadata), POSTs the ANDROID innertube
player request, fetches the chosen track as `fmt=json3` inside the page
context, and records per-video metrics. Built in: UA override, 1.5 s pacing
between videos, CONSENT/SOCS cookies. The managed Playwright build it
launches **is** Chrome for Testing (headed CfT 151 with `--headed`).

### Procedure

```bash
# 1. In the repo checkout on the residential machine:
bun install --frozen-lockfile        # if node_modules is missing
bun run scripts/sample-captions.ts --headed
#     ~2 min; per-video line:  "sampling <videoId> [category] ... cue=… words=…"
#     or "ERR <error>". Terminal report at the end; raw data appended to
#     scripts/data/sample-results.jsonl (JSONL, one SampleRecord per line).
```

```bash
# 2. Re-read a prior run without network (optional):
bun run scripts/sample-captions.ts --analyze
```

### How to read results

Per-video fields that decide the gate (in the JSONL or the report):

| Field | Meaning |
|---|---|
| `status` | `ok` (WEB fetch + json3 parse succeeded) or `error` |
| `error` | `android-player-http-*` (fallback fired), `caption-fetch-empty` (WEB blocked), `caption-fetch-http-*`, `no-caption-tracks`, `bot-wall`/`consent-page` hints |
| `kind` | Track kind actually fetched: `asr` vs `manual` |
| `webAsrCount` / `webManualCount` | WEB-visible track mix (the ASR-bias input) |
| `coveragePct` | Percent of timed words with usable timestamps |
| `nWordsTimed` | Word availability volume |
| `spanSec` / `speechEstSec` / `wordWpm` / `cueWpmCorrected` | Sanity cross-checks against the fixture-derived expectations |

### Pass criteria

1. **≥ 90% of videos `status: ok`** (allow `no-caption-tracks` only on the
   videos that legitimately lack captions).
2. **`coveragePct` ≥ 90 median** across ok videos.
3. **No `bot-wall` or `consent-page` errors.** A single one falsifies the
   "residential IP avoids the bot wall" assumption and the run must be
   retried with the hardened driver below.
4. **ASR bias documented:** the report should show ASR tracks dominating the
   en track mix (`webAsrCount > webManualCount` for most videos) — this is
   the expected feed for the Phase-2 STT sizing, not a failure.
5. `android-player-http-*` appearing at all is a finding, not a failure: it
   means the ANDROID fallback fired on a residential IP, which the E2E suite
   covers for the WEB-blocked path anyway.

### Escalation — bot-walled or suspicious

The harness does not expose `--disable-blink-features=AutomationControlled`
or a persisted profile (it launches a fresh context per run; only the
CONSENT/SOCS cookies are seeded). If criteria 3 fails, re-run a 2–3 video
spot check through agent-browser with the full hardening set, which also
doubles as the store-readiness "stopwatch timing spot-check":

```bash
agent-browser \
  --headed \
  --session-name gate1-residential \
  --profile ~/.speedwatcher-residential \
  --args "--disable-blink-features=AutomationControlled" \
  --user-agent "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
# then, paced ~5 s between steps:
#   open https://www.youtube.com/watch?v=iG9CE55wbtY
#   wait for the caption pill (the extension is not loaded here — the check
#   is the page-level fetch, so instead): wait 15 s, then
#   eval 'fetch(ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl + "&fmt=json3").then(r => r.ok ? r.text().then(t => t.length) : r.status)'
#   → pass: a large number (> 10000 chars); fail: 0 or an http error.
# Repeat for Ks-_Mh1QhMc and HtSuA80QTyo.
```

**Pass:** all three spot-check videos return payloads > 10 KB from the WEB
endpoint, and the `sample-captions.ts --headed` run has no bot-wall errors.

---

## Gate 2 — audio probe (3-signal assertion)

**What it validates:** the MV3 audio chain end to end on a real Chrome with
real tab audio: options Test button → `USER_MEDIA` offscreen document →
`chrome.tabCapture.getMediaStreamId` → `getUserMedia({chromeMediaSource:
'tab'})` in the offscreen document → AudioContext → AnalyserNode RMS → meter.

**Three independent signals must agree:**

| # | Signal | Where | How the agent reads it | Pass |
|---|---|---|---|---|
| 1 | Meter DOM | options page `#meter-fill` | `eval 'document.getElementById("meter-fill").style.width'` | `> 0%` during speech |
| 2 | AnalyserNode RMS | offscreen doc → orchestrator | `eval 'chrome.runtime.sendMessage({kind:"probe-state"}).then(s => JSON.stringify(s))'` on the options page; the `level` field is the RMS value (offscreen doc `offscreen-event level` → orchestrator memory → `probe-state`) | `level > 0` during speech |
| 3 | storage.session mirror | orchestrator → `probeCapture` | `eval 'chrome.storage.session.get("probeCapture").then(i => JSON.stringify(i.probeCapture))'` on the options page | `state: "capturing"` |

### Procedure (user machine, real Chrome, audio output)

```bash
# 0. Build the extension (any checkout):
bun install --frozen-lockfile && bun run build

# 1. Launch the agent browser with the extension:
agent-browser --extension .output/chrome-mv3 --headed \
  --session-name gate2 --profile ~/.speedwatcher-gate2 \
  --args "--autoplay-policy=no-user-gesture-required"
#    --autoplay-policy keeps the video playing without a click if needed.

# 2. Open a video with speech and confirm it is audible:
agent-browser open "https://www.youtube.com/watch?v=iG9CE55wbtY"
agent-browser wait 3000
#    pass: the tab shows a speaker icon (the page is producing audio).
#    If the page is silent, pick another video; a silent target makes the
#    meter read 0 even with a working chain.

# 3. Open the options page (chrome://extensions → Details → Extension
#    options, or direct navigation to chrome-extension://<id>/options.html):
agent-browser open "chrome-extension://<id>/options.html"

# 4. Click Test audio capture:
agent-browser click "#toggle"
#    Expected status line (#status text): starting → capturing within ~2 s,
#    error line appended if the chain broke (see failure interpretation).

# 5. Read the three signals while the video speaks (wait ~2 s first):
agent-browser eval 'document.getElementById("meter-fill").style.width'
agent-browser eval 'chrome.runtime.sendMessage({kind:"probe-state"}).then(s => JSON.stringify(s))'
agent-browser eval 'chrome.storage.session.get("probeCapture").then(i => JSON.stringify(i.probeCapture))'

# 6. Pause the video (or play silence), wait 1 s, re-read signal 2:
#    pass: level drops to ~0 while the mirror stays capturing.

# 7. Stop: click #toggle again; #status returns to idle; mirror absent.
```

### Pass / fail

**PASS:** all three signals read positive during speech (`width > 0%`,
`level > 0`, `state: capturing`), level tracks speech vs silence, and Stop
returns to idle. Level > 0 proves the streamId was accepted by the offscreen
document's `getUserMedia` and the analyser is reading real tab audio.

**FAIL — level 0 while capturing:** tab audio is not reaching the offscreen
AudioContext (stream connected, silence only). The Phase-2 STT bet is
falsified; the fallback is page-context capture via the content script
(different permission surface — research before choosing).

**FAIL — `error — tabCapture failed: Extension has not been invoked for the
current page (see activeTab permission). Chrome pages cannot be captured.`**
This is the **expected blocker on the current build** (measured on CfT 151,
and Chrome's docs state only activeTab-granted tabs can be target tabs;
declared content scripts do not count). The extension declares neither
`activeTab` nor `scripting` and has no action entrypoint, so the
orchestrator's `getMediaStreamId` cannot succeed — on the datacenter box
*and* on this machine. Record the exact error and treat the gate as
**blocked-by-design, not audio failure**. The fix is a small manifest + UX
change: declare `activeTab` and invoke the extension on the video tab
(action-icon click or keyboard shortcut) before Test, or declare `scripting`
and no-op `executeScript` on the target tab (the pattern Cap and ScriptCat
use). Re-run this gate after the fix lands; the e2e lane
(`e2e/chromium/offscreen.spec.ts`) pins this error today and will need its
assertions upgraded to `starting`/`capturing` the day the fix lands.

**FAIL — any other `error — ...`:** the status line names the failing hop
(gesture propagation, streamId rejection, getUserMedia). Report the full
line.

---

## Gate 3 — WebGPU informational check

**What it decides:** nothing by itself. It feeds the Phase-2 STT engine
choice: if WebGPU is hardware-accelerated on the user's machine, it is a
viable alternative to WASM (which is currently CSP-blocked in extension
pages, see `docs/phase0-offscreen-audio.md`).

### Procedure

```bash
agent-browser --headed --session-name gate3
agent-browser open "https://example.com"
agent-browser eval 'navigator.gpu.requestAdapter().then(a => a ? {ok: true, vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device} : {ok: false})'
agent-browser open "chrome://gpu"
agent-browser eval 'document.body.innerText.match(/WebGPU[^\n]*/)?.[0] ?? "WebGPU line not found"'
```

### Pass criteria (informational)

| Check | Expected | Meaning |
|---|---|---|
| `requestAdapter` | `{ok: true, vendor: …}` (e.g. "nvidia", "0x10de") | WebGPU API reachable |
| `adapter.info` | vendor/architecture present | Hardware adapter exposed (vs SwiftShader fallback: architecture "swiftshader") |
| `chrome://gpu` WebGPU line | `WebGPU: Hardware accelerated` | GPU-composited WebGPU; "Disabled"/"Software only" means the WASM path stays preferred |

Record all three values verbatim in the gate log. A SwiftShader
(software) adapter is not a failure — it just removes WebGPU's speed
advantage over the JS-only fallback.

---

## Reference — measured state on the datacenter box (2026-08-12)

Reproduced here so a gate run that hits these exact results is recognized as
the known baseline, not a surprise:

- Playwright 1.62.1 managed Chromium = **Chrome for Testing 151.0.7922.34**
  (`channel: 'chromium'` and `channel: 'chrome-for-testing'` both resolve to
  it; `bunx playwright install chrome` installs nothing — it expects a system
  Chrome). `chrome.offscreen` is present; `createDocument` (USER_MEDIA),
  `getContexts`, `closeDocument` all work headless and headed.
- `chrome.tabCapture.getMediaStreamId` — every variant — rejects with
  `Extension has not been invoked for the current page (see activeTab
  permission). Chrome pages cannot be captured.` (see gate 2 fail path).
- Offscreen `wasm-check` in the harness: `{ok: false, sab: true}` — WASM
  blocked by `script-src 'self'`, SharedArrayBuffer available. Matches the
  phase-0 CSP findings.
