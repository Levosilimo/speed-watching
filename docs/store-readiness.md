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

No other permissions: no `tabs`, no `<all_urls>`, no host permissions beyond
the `*://*.youtube.com/*` content-script matches, no network access at all
from the extension's own contexts (the content script fetches YouTube
caption endpoints from the page context, same-origin).

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
