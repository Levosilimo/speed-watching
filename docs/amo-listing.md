# AMO Listing — Speed Watcher

Firefox add-on listing package for addons.mozilla.org. Grounded in the
manifest (`wxt.config.ts`), the permission notes in `docs/store-readiness.md`,
and the Phase-0/Phase-3 measurements in `docs/phase0-generic-probe.md`.

## Name

Speed Watcher

## Summary (≤250 chars)

"Recommends a playback speed that lands speech in the 250–275 wpm comfortable
listening range, measured from the video's own captions. Works on YouTube,
Vimeo, and any page with a video element."

(180 chars — AMO limit 250; CWS limit 132 is separate, see store-readiness.)

## Description

Speed Watcher measures how fast people actually speak in a video — using the
video's own captions — and recommends a playback speed that lands your
effective listening speed in the 250–275 words-per-minute range, a commonly
cited comfortable listening range for speech. Faster speakers get slowed
down, slower ones sped up; content where that range is unreachable says so
honestly instead of guessing.

How it works:

- **YouTube**: reads the caption tracks from the watch page, measures the
  speech rate (word-level where the track has word timing, cue-level
  otherwise), and shows a recommendation pill over the player. Apply sets
  the playback rate; Dismiss leaves the video untouched.
- **Any other page with a video** (Vimeo, Twitch VOD, MOOC platforms, native
  players, embeds in cross-origin iframes): a generic matcher finds the
  active video element and applies the same measurement when the page
  exposes captions in its network layer (HLS subtitle manifests, Vimeo
  player config, WebVTT or transcript resources), and otherwise falls back
  to a per-content-type estimate.
- **Rate stickiness**: some players reset the playback rate on pause/play
  or reload; the matcher re-applies the chosen rate while the
  recommendation is active, and stops as soon as the pill is dismissed.
- **Music**: lyric-heavy content is detected and flagged "speed not
  recommended" instead of being sped up.
- **Your preferences**: target rate, per-site overrides, and a habits
  report (apply/dismiss history) live in the options page.

Everything runs locally. The extension reads caption text and playback
properties from pages you visit, writes your settings and habits into local
browser storage, and sends nothing anywhere.

## Categories

Primary: Video (the AMO category string is chosen from the taxonomy at
submission time; "Photos, Music & Videos" if "Video" is not offered).

## Permissions justification (for AMO review)

| Permission | Why |
|---|---|
| Content script on `<all_urls>`, all frames | The extension's function is to find and control video elements, and embedded players live in cross-origin iframes on arbitrary hosts (measured in the Phase-0 probe: no player was reachable from the top frame alone). A curated site list would miss native video elements on unlisted pages. The script only reads video element properties and caption resources and sets `playbackRate`; it never reads page content outside the active video. |
| No `host_permissions` | Caption harvesting fetches from measured origins (Vimeo player config, HLS subtitle manifests, transcript endpoints), but every fetch runs from the MAIN world — the page's own context — and the `<all_urls>` content-script match already grants host access, so no host permission is declared (declaring one would only inflate the review surface). |
| `storage` | Settings (`sw.settings`) and the override/habits log (`sw.overrideLog`), both in `chrome.storage.local` (browser.storage.local in Firefox). Nothing syncs, nothing leaves the machine. |
| `tabCapture`, `offscreen` | The audio capture test (options-page "Test audio capture" button), Chrome-only. Firefox has no offscreen API, so Firefox builds hide the test and these APIs are never called. |

No other permissions: no `tabs`, no `webRequest`, no background network
access, no remote code, no analytics.

## Version policy

- Semantic versions `x.y.z`; every upload must use a higher version than the
  last, and a version never gets reused.
- Chrome and Firefox releases stay in lockstep: the same version string is
  published to both stores so users and support can compare them.
- Only production builds are uploaded (no dev builds, no `--unlisted`
  experiments on the public listing). AMO metadata is passed with `web-ext
  sign` (`--channel=listed`), matching the CI publish job in
  `.github/workflows/publish.yml`.
- `browser_specific_settings.gecko.strict_min_version` is `128.0`:
  `runtime.getContexts` and content-script `world: "MAIN"` (used by the
  YouTube measurement script) both landed in Firefox 128.

## Privacy

The add-on collects no data. The data-usage statement in
`docs/store-readiness.md` applies unchanged; AMO's privacy-policy field is
only required for add-ons that collect data, but the store-readiness policy
placeholder is the intended home if one is ever needed.
