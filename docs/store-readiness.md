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
| `tabCapture` | Required-not-optional: the Chrome API refuses this permission as optional, so it must sit in the manifest from day one. Used only by the audio probe (options-page "Test audio capture" button) and the future on-device STT feature. STT itself is feature-gated behind an explicit user opt-in and is not part of the MVP; `tabCapture` is never called without a user gesture. |
| `offscreen` | `chrome.offscreen.createDocument` fails without this manifest permission (live Chrome docs); `lib/capture-orchestrator.ts` calls it with reason `USER_MEDIA` for the audio probe. Offscreen documents cannot be created lazily on Chrome 116–, hence the static declaration. |

Host access is explicit and named: `host_permissions` lists only the
measured-player origins (vimeo, twitch, coursera, edx, youtube-nocookie),
and the content scripts match `<all_urls>` with `all_frames` because
embedded players live in cross-origin iframes — the generic matcher and
the message bridge must run in every frame. No `tabs`, no wildcard
`host_permissions`, no network access from the extension's own contexts
(the content script fetches YouTube caption endpoints from the page
context, same-origin).

## Pre-submission checklist

Run `bun run check:cws` after every build. It runs the offline
[`cws-check`](https://github.com/0prob/cws-check) CLI over
`.output/chrome-mv3` — the bundle CWS reviewers actually scan — and exits 1
on MV2, remote-code, or unsafe-CSP findings. Reference run on v0.0.1
(2026-08-12):

```
cws-check — Speed Watcher v0.0.1

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
  ! 8 permissions/host_permissions declared.
    Not a violation by itself, but a high permission count is the most common trigger for a CWS "does this serve a single purpose?" review question. Re-read CLAUDE.md's note on grab-bag rejection risk before adding more.

Summary: 5 pass, 1 warn, 0 fail
No hard blockers found, but review the warnings — several map to common review rejections.
```

### Reading the output for this extension

- **remote-code / CSP** — expect 0 findings: no eval, no `new Function`, no
  remote scripts, no `content_security_policy` override in the production
  build (WXT dev mode injects one for HMR only).
- **sensitive-permissions** — `tabCapture` + `offscreen` are not on the
  checker's high-scrutiny list, but they are the declared surface a human
  reviewer will question; the justification lives in the Permissions table
  above (user-gesture-only audio probe, feature-gated STT).
- **single-purpose warn (8 declared = 3 permissions + 5 named host
  permissions)** — a warning, not a failure. Every host is an explicit
  measured-player origin, and the `<all_urls>` content-script match exists
  because embedded players live in cross-origin iframes. The count only
  grows with new embed targets — re-check the single-purpose story before
  adding any.

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

## No-remote-code declaration

Ready: the built extension contains no remotely hosted code, no eval, no
`new Function`, no dynamically loaded scripts. The WASM/SharedArrayBuffer
findings from `docs/phase0-offscreen-audio.md` are probe-only diagnostics; no
WASM ships in the MVP. The manifest has no `content_security_policy` override
(WXT dev mode injects one for HMR; the production build ships the default
`script-src 'self'`).

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

Placeholder: CWS requires a hosted privacy-policy URL. The user must host a
short policy (the data-usage statement above is the content) and paste the
URL into the CWS listing before submission. AMO requires a "privacy policy"
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
   manifest one-liner: what the pill does, the 250–275 wpm safe-zone frame,
   report-only override log, and the scope (YouTube captioned videos).
3. **Final icons** — CWS rejects placeholder art. The current 16/32/48/96/128
   icons are generated placeholders; real artwork is required before upload.

## Version policy

- `package.json` version is the single source; the CI `ci` job fails unless
  the built manifest version matches it (screenpipe pattern).
- Every store upload must bump the version (CWS rejects identical versions).
  Current: `0.0.1`.
- The publish workflow (`.github/workflows/publish.yml`) is draft/inert until
  store credentials exist.

## Pending before submission

1. **Residential WEB re-run** (hard Phase-1 gate from ora-2): verify the WEB
   timedtext path from a residential IP — windows-format json3 parsing and a
   2-3 video stopwatch timing spot-check. The ANDROID innertube fallback is
   shipped and E2E-tested, but the WEB path's availability on residential
   networks is the unmeasured half of the chain.
2. **Audio probe manual verification** (from `docs/phase0-offscreen-audio.md`):
   the tabCapture → offscreen → getUserMedia flow is unit-tested only;
   `chrome.offscreen` is absent from every Playwright build, so a human must
   run the options-page probe on a real Chrome once before submission. The
   `offscreen` permission this flow needs is now declared in the manifest.
3. **Firefox AMO listing metadata** (name/description/summary fields) and the
   optional source-code upload for `web-ext sign --channel listed`.

The CWS listing assets (screenshots, description body, final icons) are
listed under "CWS listing assets" above and are mandatory before the first
upload.
