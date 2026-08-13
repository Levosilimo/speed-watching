# Manual Gates Runbook

Three verification gates need a machine the CI box cannot be: a residential
IP (gate 1) and a real Chrome with real tab audio (gate 2). Gate 3 is an
informational check. This runbook is written to be executed by an agent, not
a human: numbered steps, exact commands, pass/fail criteria. The one
exception is gate 2's toolbar click — browser chrome, which CDP cannot
synthesize (see the gate's step 3).

What this box already proves is in `docs/phase0-offscreen-audio.md`,
`docs/phase0-caption-wpm.md`, and `docs/ci-e2e.md`; this runbook only covers
what those cannot. The box is WSL2 on a residential Windows 11 line — never
a datacenter IP; phase-0's WEB caption failures were the bare-fetch
POT-context gap, not IP class (see `docs/phase0-caption-wpm.md` §8).

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
- Gate 1 runs from the repo root of a checkout on this box (the WSL2
  machine on the residential Windows 11 line). Gates 2–3 run wherever a real
  Chrome with audio output exists.

---

## Gate 1 — residential timedtext re-run (player-signed capture)

**What it validates:** the WEB timedtext caption path, captured the way the
extension's content script sees it — the **player's own signed timedtext
request**. A fresh `baseUrl` fetch by a script is not representative: the
player's URL carries a `pot` token and the page's proof-of-origin, both
bound to the video, and a re-fetch from a different context drifts or gets
blocked (phase-0 measured exactly this as `caption-fetch-empty` on WEB — a
context failure, not IP class). Intercepting the player's request tests the
primary path end to end — it is the request `entrypoints/content.ts` relies
on.

**Status: PASSED 2026-08-12.** The landmark re-run (`scripts/sample-captions.ts`,
`docs/phase0-caption-wpm.md` §8) IS the residential run: 16/17 = 94.1% of
ASR-bearing videos yielded WEB word timing on this same box; the one miss
(8mAITcNt710, CS50) was a video-specific empty-200 with the ANDROID control
OK. `scripts/gate1-residential.ts` is the regression/periodic tool for this
gate, not a first-time gate — a smoke run of it on 2026-08-12 reported a
false `pot-fail` whose root cause was runner bugs (a persistent browser
profile that YouTube served degraded no-word-timing ASR payloads to, and
latching the first post-repick response before the word-timed follow-up
landed). Both were fixed 2026-08-13; the runner then re-verified 5/5 of the
landmark's web-ok videos with word/cue counts identical to the landmark.

Also validates: the **parser gap** (word-level `windows` parsing is only
proven on the synthetic fixture, `tests/fixtures/synthetic/windows-format.json`),
pause-bias measurement, the rate-stick re-apply loop, and the fixture
commitments.

**Harness:** agent-browser with HAR capture (HAR records response bodies),
parsed with the production parser (`lib/captions.ts`). No fresh fetches: the
payload is the player's own `/api/timedtext` response, recorded while
captions are toggled on.

### Procedure

```bash
# 1. In the repo checkout on the residential machine:
bun install --frozen-lockfile        # if node_modules is missing

# 2. Launch agent-browser headed with the full hardening set (persisted
#    cookies via --session-name):
agent-browser --headed \
  --session-name gate1-residential \
  --profile ~/.speedwatcher-residential \
  --args "--disable-blink-features=AutomationControlled" \
  --user-agent "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"

# 3. Per video (the phase-0 24-video list in scripts/sample-captions.ts,
#    paced ~5 s between videos):
agent-browser open "https://www.youtube.com/watch?v=<videoId>"
agent-browser wait 4000
agent-browser network har start
agent-browser press c                # toggle captions on
agent-browser wait 3000
#    If no /api/timedtext request lands in the HAR, the CC menu needs a
#    manual track pick: click the CC button, choose English (asr preferred).
agent-browser network har stop /tmp/gate1-<videoId>.har
#    Extract the player's signed timedtext body (no jq dependency):
mkdir -p scripts/data
bun -e '
import { readFileSync, writeFileSync } from "node:fs";
const id = process.argv[1];
const har = JSON.parse(readFileSync(`/tmp/gate1-${id}.har`, "utf8"));
const entry = har.log.entries.find((e) => e.request.url.includes("/api/timedtext"));
if (!entry) { console.log(`ERR no timedtext request for ${id}`); process.exit(2); }
writeFileSync(`scripts/data/residential-${id}.json3`, entry.response.content.text ?? "");
console.log(`saved ${entry.response.content.text?.length ?? 0} bytes for ${id}`);
' <videoId>
```

```bash
# 4. Parse every captured payload with the production parser:
bun -e '
import { readFileSync, readdirSync } from "node:fs";
import { parseYouTubeJson3 } from "./lib/captions.ts";
const dir = "scripts/data";
for (const f of readdirSync(dir).filter((f) => f.startsWith("residential-"))) {
  const parsed = parseYouTubeJson3(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
  const words = parsed.words.length, cues = parsed.cues.length;
  console.log(f, JSON.stringify({ words, cues, ok: words > 0 && cues > 0 }));
}
'
#    Per-video assertions (the parser-gap check):
#      - words > 0: word-level windows parsing produced timed tokens on a
#        REAL payload — only the synthetic fixture proves it today.
#      - cues > 0: cue-level events parsed from the same payload.
#      - windows == segs parity: when the payload carries BOTH layouts
#        (events[].segs and windows), both parses must agree on the same
#        video (first/last cue text and overlapping coverage).
```

### Pass criteria

1. **≥ 90% of ASR-bearing videos pass** (words > 0 AND cues > 0 on the same
   payload). Report the raw fraction as **x/22** (the ASR-bearing subset the
   planning lane counted in the phase-0 list) for direct parity with
   phase-0, which measured 17/17 = 100% on the ANDROID path from this same
   box.
2. **Stratify every non-passing video** by failure class:

   | Symptom | Class | Verdict |
   |---|---|---|
   | no `captionTracks` or manual-only tracks | structural | not a parser bug — the video has no ASR captions; excluded from the ASR denominator |
   | timedtext intercepted but empty, or no timedtext request at all | POT/IP access | the player's own request failed — same class as phase-0's `caption-fetch-empty` (context failure, not IP class); retry with a fresh session, then the escalation below |
   | payload parsed but `words === 0` | **PARSER BUG** | hard fail — the word-level windows path is broken on real payloads; word timing is the pause-bias and WPM input |

3. **No `bot-wall` or `consent-page` errors** (the hardened driver above is
   the default now, not an escalation).
4. **Pause-bias measured** per ok video and reported as a median:
   `pauseBias = (unifiedRate - filteredTokens / speechDur) / unifiedRate`
   - `unifiedRate`: the rate the extension applied — read
     `video.playbackRate` on the watch page while the extension drives it
     at the default 250 wpm target.
   - `filteredTokens`: letter/digit token count over non-bracket cues
     (`countWordTokens` — the same filter as
     `filteredTokensOverTrimmedSpan` in lib/wpm.ts).
   - `speechDur`: from per-word inter-start spans — the sum of
     `(start[i+1] - start[i])` over consecutive timed words, excluding gaps
     ≥ 1 s (cue-boundary pauses); i.e. the first-to-last word span minus
     pause time.
   A median > 0.25 means pauses eat > 25% of the applied speed and the
   unified-rate rule over-speeds: flag the per-video values to the demand
   lane.
5. **Rate-stick re-apply loop** (YouTube fights the rate — the extension's
   apply loop, lib/matcher.ts, must survive real player events):
   - pause > 2 s, resume → `video.playbackRate` returns to the applied rate
     within ~1 s (YouTube resets to 1.0 on pause/seek; videospeed#1523).
   - seek backward ~10 s → rate re-applies the same way.
   - during an ad → rate is suppressed (1.0) and re-applied on `adend`
     (Google Support #366842420).
6. **Fixture commitments** — this run must ship them:
   - 2–3 truncated real windows-format payloads (first ~20 events each),
     ASR-preferred, under `tests/fixtures/real/` (e.g.
     `windows-asr-<videoId>-trunc.json`).
   - provenance README `tests/fixtures/README` recording per fixture:
     videoId, video title, capture date, capture method (player-signed
     intercept), original vs truncated size, and which assertions it backs.

### Escalation — bot-walled or suspicious

If criteria 3 fails, re-run the 2–3 video spot check with a fresh session
(cookies dropped: new `--session-name`) and a human-in-the-loop CAPTCHA
check on the watch page — the captions toggle must fetch a non-empty
payload. Record which hop blocked (request never sent / empty response /
consent redirect).

---

## Gate 2 — audio probe (3-signal assertion)

**What it validates:** the MV3 audio chain end to end on a real Chrome with
real tab audio: toolbar-icon click (the tabCapture invocation gesture) →
`USER_MEDIA` offscreen document → `chrome.tabCapture.getMediaStreamId` →
`getUserMedia({chromeMediaSource: 'tab'})` in the offscreen document →
AudioContext → AnalyserNode RMS → meter.

**Why the click, not the Test button:** `getMediaStreamId` accepts a target
tab only after the extension was invoked on it, and invocation comes from
exactly four gestures — action click, context menu, commands shortcut,
omnibox. A `runtime.sendMessage` from the options page is none of these, so
the options **Test button alone cannot start a capture**; it returns the
guidance error (see fail path). The manifest declares `action` without
`default_popup` precisely so the click reaches the background's `onClicked`
listener instead of being swallowed by a popup (lib-7 verdict;
`docs/phase0-offscreen-audio.md`). After one click, the invocation grant
persists for that tab until it navigates — the Test button then works as
viewer/restart/stop for that same tab.

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

# 3. THE INVOCATION STEP — while the video tab is active, click the Speed
#    Watcher toolbar icon (via the puzzle menu first if the extension is not
#    pinned). This is browser chrome, which CDP cannot synthesize — the one
#    human step in this runbook (or X11-level automation, e.g. xdotool, if
#    coordinates are known). The click is what grants getMediaStreamId the
#    target tab; without it every capture attempt returns the guidance error.

# 4. Open the options page in a second tab:
agent-browser open "chrome-extension://<id>/options.html"
#    Expected status line (#status text): starting → capturing within ~2 s
#    of the click, error line appended if the chain broke (see below).

# 5. Read the three signals while the video speaks (wait ~2 s first):
agent-browser eval 'document.getElementById("meter-fill").style.width'
agent-browser eval 'chrome.runtime.sendMessage({kind:"probe-state"}).then(s => JSON.stringify(s))'
agent-browser eval 'chrome.storage.session.get("probeCapture").then(i => JSON.stringify(i.probeCapture))'

# 6. Pause the video (or play silence), wait 1 s, re-read signal 2:
#    pass: level drops to ~0 while the mirror stays capturing.

# 7. Stop: click #toggle again; #status returns to idle; mirror absent.
#    (Test/Stop work because the tab keeps its invocation grant until it
#    navigates; reloading the video tab re-requires step 3.)
```

### Pass / fail

**PASS:** the click at step 3 moved the status to `starting` → `capturing`;
all three signals read positive during speech (`width > 0%`, `level > 0`,
`state: capturing`), level tracks speech vs silence, and Stop returns to
idle. Level > 0 proves the streamId was accepted by the offscreen
document's `getUserMedia` and the analyser is reading real tab audio.

**FAIL — `error — tabCapture not invoked: click the Speed Watcher toolbar
icon on the video tab, then retry`:** the invocation never happened for the
target tab — the icon was not clicked, was clicked while another tab was
active, or the video tab navigated after the click. The orchestrator maps
Chrome's raw rejection (`Extension has not been invoked for the current
page (see activeTab permission)`) to this guidance
(`lib/capture-orchestrator.ts`). Re-do step 3 on the video tab and re-check;
this is a gesture failure, not an audio failure.

**FAIL — level 0 while capturing:** tab audio is not reaching the offscreen
AudioContext (stream connected, silence only). The Phase-2 STT bet is
falsified; the fallback is page-context capture via the content script
(different permission surface — research before choosing).

**FAIL — any other `error — ...`:** the status line names the failing hop
(streamId rejection, getUserMedia). Report the full line.

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

## Reference — measured state on this box (2026-08-12)

Reproduced here so a gate run that hits these exact results is recognized as
the known baseline, not a surprise:

- Playwright 1.62.1 managed Chromium = **Chrome for Testing 151.0.7922.34**
  (`channel: 'chromium'` and `channel: 'chrome-for-testing'` both resolve to
  it; `bunx playwright install chrome` installs nothing — it expects a system
  Chrome). `chrome.offscreen` is present; `createDocument` (USER_MEDIA),
  `getContexts`, `closeDocument` all work headless and headed.
- `chrome.tabCapture.getMediaStreamId` — every variant — rejected with
  `Extension has not been invoked for the current page (see activeTab
  permission). Chrome pages cannot be captured.` while the extension had no
  action entrypoint. **Resolved 2026-08-12:** the manifest now declares
  `action` without `default_popup` and the background wires
  `chrome.action.onClicked` to the orchestrator (lib-7 verdict; the click IS
  the invocation). The orchestrator maps the raw rejection to the guidance
  error, and `e2e/chromium/offscreen.spec.ts` pins the manifest contract +
  pre-invocation state. The residual — real click + real tab audio — is this
  runbook's gate 2.
- Offscreen `wasm-check` in the harness: `{ok: false, sab: true}` — WASM
  blocked by `script-src 'self'`, SharedArrayBuffer available. Matches the
  phase-0 CSP findings.
