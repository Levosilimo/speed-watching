# Store Readiness

Status of the Chrome Web Store / AMO submission package. Everything in
"Ready" is verifiable from this repo; the "User action required" items need a
human or a residential network before the first upload.

## Single-purpose description

Manifest description (also `package.json`): **"WPM-based speed-watching
extension"** — 27 chars, well under the 132-char CWS limit, and single-purpose
by construction: the whole product is one feature (recommend playback speed
from caption speech rate). No secondary purposes are present or planned.

## Permissions

| Permission | Why it is declared |
|---|---|
| `storage` | Settings (`sw.settings`), override log (`sw.overrideLog`), audio-probe session state. Everything is `chrome.storage.local`; nothing syncs. |
| `tabCapture` | Required-not-optional: the Chrome API refuses this permission as optional, so it must sit in the manifest from day one. Serves the shipped audio capture test — the options-page "Test audio capture" button, which captures the audio of the video tab the user is watching, shows a live level meter, and stops on demand — and the future on-device STT feature, which stays feature-gated behind an explicit user opt-in. `tabCapture` is never called without a user gesture. |
| `offscreen` | `chrome.offscreen.createDocument` fails without this manifest permission (live Chrome docs); `lib/capture-orchestrator.ts` calls it with reason `USER_MEDIA` for the audio capture test. Offscreen documents cannot be created lazily on Chrome 116–, hence the static declaration. |
| `contextMenus` | The measure-link context menu (background `installContextMenu`): right-clicking a video link shows "Measure this video's rate", which opens the link in a tab where the existing measurement pipeline takes over — the pill appears there with no extra logic. |

No `host_permissions` block (STORE-4): the content scripts match
`<all_urls>` with `all_frames` (embedded players live in cross-origin
iframes — the generic matcher and the message bridge must run in every
frame), and that match already grants host access. Every fetch the
extension makes — YouTube timedtext, generic caption harvest — runs from
the MAIN world, the page's own context, so declaring named hosts would
only inflate the permission count CWS reviewers see. No `tabs`, no
wildcard host permissions, no network access from the extension's own
contexts.

## Pre-submission checklist

Run `bun run check:cws` after every build. It runs the offline
[`cws-check`](https://github.com/0prob/cws-check) CLI over
`.output/chrome-mv3` — the bundle CWS reviewers actually scan — and exits 1
on MV2, remote-code, or unsafe-CSP findings. Reference run on v0.0.2
(2026-08-14, manifest with all four permissions):

```
cws-check — Speed Watcher v0.0.2

Manifest version
  ✓ manifest_version 3 — current.

Remote code execution (MV3 hard ban)
  ✓ No remote-code patterns detected in scanned files.

Sensitive permissions & data-disclosure surface
  ✓ Declared permissions are not on the high-scrutiny list.

Content Security Policy
  ✓ No explicit content_security_policy override — MV3 default (strict) applies.

AI-guardrail-bypass / prediction-market ban (2026-08-01 policy)
  ✓ No AI-guardrail-bypass or prediction-market language detected.

Single-purpose statement (metadata completeness only)
  ✓ Manifest has a description and a modest permission count. (This tool cannot judge single-purpose intent — a human must still confirm the feature set matches one stated purpose.)

Summary: 6 pass, 0 warn, 0 fail
No issues detected by this tool. This does not replace human review of your single-purpose statement and CWS listing disclosures.
```

### Reading the output for this extension

- **remote-code / CSP** — expect 0 findings: no eval, no `new Function`, no
  remote scripts, no `content_security_policy` override in the production
  build (WXT dev mode injects one for HMR only).
- **sensitive-permissions** — `tabCapture` + `offscreen` are not on the
  checker's high-scrutiny list, but they are the declared surface a human
  reviewer will question; the justification lives in the Permissions table
  above (user-gesture-gated audio capture test, feature-gated STT).
- **single-purpose — clean since the STORE-4 cut**: 4 declared
  permissions, no `host_permissions`, so cws-check reports a modest count.
  The count only grows with new permissions — re-check the single-purpose
  story before adding any.

### Packaging-error check (manual)

CWS rejects bundles whose manifest references are missing or case-mismatched.
Before upload, verify against the built bundle:

1. Every `manifest.json` reference resolves in `.output/chrome-mv3`:
   `icons` (16/32/48/96/128), `background.service_worker`,
   `action.default_icon`, all `content_scripts.js` entries. A passing
   `bun run build` is the primary guard — WXT emits the bundle from the
   same paths the manifest references.
2. Case sensitivity: names inside the zip must match the manifest exactly.
   WXT emits lowercase hashed names, so this only breaks if a `public/`
   asset is hand-added later.
3. Upload the `bun run zip` artifact (`.output/*.zip`), not the unpacked
   directory.
4. HTML-internal asset links: a `<link href>` pointing outside the bundle
   breaks the same way — the options page stylesheet is imported by the
   entry, so `options.html` carries no `<link>`; re-check if one
   reappears.

## No-remote-code declaration

Ready: the built extension contains no remotely hosted code, no eval, no
`new Function`, no dynamically loaded scripts. The WASM/SharedArrayBuffer
findings from `docs/phase0-offscreen-audio.md` are probe-only diagnostics; no
WASM ships in the MVP. The manifest has no `content_security_policy` override
(WXT dev mode injects one for HMR; the production build ships the default
`script-src 'self'`).

## Bundle-weight note: dormant STT recorder plumbing

The shipped bundle carries ~6 KB of currently driver-less audio plumbing
— `lib/audio-recorder.ts`, `lib/resampler.ts`, `lib/recorder-worklet.ts`,
imported by `entrypoints/offscreen/main.ts` (the offscreen chunk plus the
worklet asset). Intentional, not dead weight: it is the de-risked STT
path — the recorder is created at offscreen load and wired into the
capture flow, so the on-device STT feature lands without a
bundle/permission change. The rest of the STT surface is already absent:
`lib/model-store.ts` is referenced by no entrypoint, so the bundler
tree-shakes it out entirely.

## Data usage

- Settings and the override log live only in `chrome.storage.local` on the
  user's machine.
- The demand proxy (`sw.demand`) records per-content-type counts of
  estimated-tier renders plus the STT demand gate counters (distinct render
  days, last render date). See `docs/demand-gate.md`. Local only, never
  transmitted.
- The override log records per action: timestamp, video id, site, content
  type, natural rate, multiplier, and recommendation mode. It is
  report-only — never transmitted, never used for learning, capped at 500
  entries.
- The content script requests caption data from YouTube's own endpoints
  using the video's public player response; the extension itself makes no
  outbound calls from its own contexts.
- No analytics, no telemetry, no third-party requests.

CWS data-safety form: "No data collected" is the honest answer — nothing
leaves the browser.

## Privacy policy

The privacy policy is live at
`https://levosilimo.github.io/speed-watching/privacy-policy`; paste that URL
into the CWS listing before submission. Questions route via the GitHub
profile: https://github.com/Levosilimo. AMO requires a "privacy policy"
field only for add-ons that collect data; this one does not, but a policy
page is still good practice.

Note: `tabCapture` is declared, so CWS will ask why it is present even
though nothing is collected. The justification is the audio probe + the
feature-gated future STT; publish anyway — the data-safety form stays "No
data collected".

## CWS listing assets (mandatory)

These are hard submission requirements, not polish:

1. **At least one screenshot** — CWS requires ≥1 screenshot at 1280×800 or
   640×400 (JPEG/PNG, ≤2 MB). Planned: the pill on a YouTube watch page and
   the options page.
2. **Listing description body** — a store description distinct from the
   manifest one-liner: what the pill does, the 250–275 wpm frame (a
   commonly cited comfortable listening range; the presentation-rate
   metric, pauses included), the pause-dilution warning when pause-heavy
   captions push the speech itself past that range, report-only
   override log, and the scope (YouTube captioned videos).
3. **Final icons** — CWS rejects placeholder art. The current 16/32/48/96/128
   icons are generated placeholders; real artwork is required before upload.

## Version policy

- `package.json` version is the single source; the CI `ci` job fails unless
  the built manifest version matches it (screenpipe pattern).
- Every store upload must bump the version (CWS rejects identical versions).
  Current: `0.0.2`.
- The publish workflow (`.github/workflows/publish.yml`) is draft/inert until
  store credentials exist.

## Pending before submission

1. **Residential WEB re-run** (hard Phase-1 gate from ora-2): verify the WEB
   timedtext path — windows-format json3 parsing and a 2-3 video timing
   spot-check. **PASSED.** The landmark re-run
   (`docs/phase0-caption-wpm.md` §8, 2026-08-12, `scripts/sample-captions.ts`)
   measured 16/17 = 94.1% WEB yield on this box (WSL2, residential Windows
   11 line; the one miss, 8mAITcNt710/CS50, is a documented video-specific
   empty-200 with the ANDROID control OK). Re-checked 2026-08-13 with the
   gate-1 runner after its fixes: 5/5 of the landmark's web-ok videos
   re-verified `web-ok` with word/cue counts identical to the landmark
   (`scripts/data/gate1-residential/results.jsonl`), and the landmark
   harness itself re-ran the same five videos with identical results. The
   ANDROID innertube fallback remains shipped and E2E-tested.
2. **Audio capture test manual verification** (from `docs/phase0-offscreen-audio.md`):
   the tabCapture → offscreen → getUserMedia flow is unit-tested only;
   `chrome.offscreen` is absent from every Playwright build, so a human must
   run the shipped options-page test on a real Chrome once before submission.
3. **Firefox AMO listing metadata** (name/description/summary fields) and
   the **mandatory source-code upload**: AMO requires the source of any
   bundled/minified add-on — this WXT build is both, so the upload is
   required, every version (the publish workflow already passes
   `--source-code-zip .output/source.zip`, the git archive of the release
   ref). Package the repo at the release tag (ports
   included), `bun.lock`, and a build note. Reviewer environments default
   to npm; the build is bun-run — `bun install --frozen-lockfile` with
   `bun.lock` as the lockfile, then `bun run build` (Chrome) or
   `bun run build:firefox` (Firefox) — so the note must state the bun
   requirement, or an npm-based reviewer gets no lockfile and a broken
   install.

The CWS listing assets (screenshots, description body, final icons) are
listed under "CWS listing assets" above and are mandatory before the first
upload.
