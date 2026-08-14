# Speed Watcher userscript

Userscript port of the extension's YouTube measure flow: reads the watch
page's player response, fetches the first caption track (WEB json3, ANDROID
innertube fallback), measures the natural speech rate, and renders a minimal
pill recommending a playback multiplier for the 250–275 wpm safe zone.

## Install

1. Build the bundle (or download a release build):

   ```sh
   bun run build:userscript
   ```

2. Open the produced `userscript/dist/speed-watcher.user.js` in your
   userscript manager:

   - **Tampermonkey** — dashboard → Utilities → "Import from file".
   - **Violentmonkey** — dashboard → the `+` menu → "Install from file".
   - **Greasemonkey 4+** — drag the file onto the add-ons page.

   The metadata block matches `*://*.youtube.com/*`, grants
   `GM_setValue`/`GM_getValue`, and runs at `document-start`. No other
   permissions are requested; the caption fetches use the page's own `fetch`
   (the same requests the watch page makes), never `GM_xmlhttpRequest`.

## Scope

- Watch pages (`/watch`) on YouTube. SPA navigation re-measures on
  `yt-navigate-finish`; the pill follows the video that actually plays.
- `Shift+W` applies the recommended multiplier, `Escape` dismisses the pill.
- The pill's Dismiss button opens the target prompt: a per-profile WPM target
  (clamped to the extension's 100–400 bounds) or Clear to drop it.
- Storage is exactly two GM keys:
  - `speedwatcher.target` — the explicit target (number).
  - `speedwatcher.channelRates` — per-channel last measured rates, LRU-50,
    mirroring the extension's channel memory. A channel's measured rate
    seeds the estimated tier of its captionless videos when the language
    matches.
- Both keys are optional: without GM (or on Greasemonkey 4, where the async
  API rejects before the document is ready) the script still measures and
  the estimated tier falls back to the language priors.
- Music detection and content-type auto-detect are included, exactly like
  the extension.

## Limits

- No options page, bridge, provider protocol, override log, or demand
  counter — the extension features that need chrome.* storage are not
  ported.
- Live streams are suppressed (pill hidden), like the extension.
- The estimated tier never applies — it only recommends (the pill's Apply
  stays inert on unreachable and music states, mirroring the extension).
- The pill is a plain `position:fixed` div; there is no shadow root and no
  i18n layer.

## E2E hooks

The bundle ships with its test hooks compiled behind the runtime flag
`window.__speedwatcherE2E`: set it on the page before the script runs to get
the `speedwatcher:measure` CustomEvent, `window.__speedwatcherPill`
(`state`/`apply`/`dismiss`), and `window.__speedwatcherCaptionSource`. The
appended relay also mirrors the last measure into
`window.__speedwatcherLastMeasure`. `e2e/userscript/userscript.spec.ts`
drives the bundle through these hooks against the fixture server; the
bundled file is gitignored and never enters the gate-scanned tree.
