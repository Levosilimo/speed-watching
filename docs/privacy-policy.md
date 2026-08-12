# Privacy Policy — Speed Watcher

**Speed Watcher does not transmit data.** The extension measures the speech
rate of a video's captions and recommends a playback speed; every piece of
data it touches stays on your device. This policy covers the Chrome and
Firefox versions of the extension.

## Data stored on your device

All extension data lives in the browser's local extension storage
(`chrome.storage.local` / `browser.storage.local`) under three keys:

- `sw.settings` — your preferences: target speech rate, content-type
  defaults, and per-site overrides.
- `sw.overrideLog` — one entry per recommendation decision (apply, dismiss,
  or adjust), recording the site, content type, measured speech rate,
  multiplier, and whether the recommendation was applied. Capped at 500
  entries; the oldest entry is dropped when the cap is reached.
- `sw.demand` — counters of estimated-tier recommendation renders per
  content type, used only to decide whether an on-device speech-to-text
  feature is worth building. No page content, no identifiers.

Nothing here is synced to an account. To delete this data:

- Chrome: `chrome://extensions` → Speed Watcher → Details → "Clear
  extension data".
- Firefox: `about:addons` → Speed Watcher → Remove. Firefox deletes an
  add-on's stored data on uninstall.

## Data read from the pages you visit

When you play a video, the extension reads the page's caption data and
speech-rate measurements (for example, YouTube's word-timed captions) to
compute the playback-speed recommendation. The read happens in the page's
own context — the extension makes no outbound requests — and the data
serves the single purpose of computing the recommendation. It is not stored
outside the keys above and never leaves your device.

## Audio capture (Chrome)

Chrome builds include an optional audio probe, reachable only by clicking
"Test audio capture" in the options page. It measures a live audio level
from the tab you select to verify the capture path; it does not record,
store, or transmit audio. The `tabCapture` and `offscreen` permissions it
needs are declared in the manifest but never invoked without that click.
Firefox builds do not include this probe.

## What leaves your device

Nothing. The extension declares no network permissions, makes no outbound
requests from its own contexts, and contains no analytics, telemetry, or
third-party code.

## Updates and contact

This policy is updated when the extension's data handling changes; the
version in the store listing marks each release. Questions:
privacy@levosilimo.dev — placeholder address; replace with the real inbox
before the policy URL goes live.
