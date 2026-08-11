# Phase 0 Lane C: generic-player probe — feasibility report

Measured 2026-08-11 from a datacenter IP (Poland). Data:
`scripts/data/generic-player-results.jsonl` (11 records: 8 sites plus three
extra `vimeo-page` runs to pin down run-to-run variance). Probe script:
`scripts/probe-generic-players.ts` (standalone, not part of the vitest suite).

## Method

Per site: load the page headless (Playwright chromium, real Chrome UA, locale
en-US, no login, no bypass), wait up to 10 s for any video element across all
frames plus a 2 s settle, then walk every http(s) frame recording its URL,
whether it is same-origin with the top document, and its video count
(shadow-DOM piercing). On the first frame that has a video: assign
`playbackRate = 1.5` and read it back after 2 s, after a 2 s seek (+800 ms),
and after pause/play (+800 ms), counting `ratechange` events; read
`textTracks`, `track` elements, and cue access; scan `window` for player
libraries; record the main-document CSP and console errors.

Playwright evaluates through CDP, so cross-origin frames are measurable from
the driver — the same view an `all_frames` content script gets, and the
opposite of a top-frame-only script, which sees only the top document.

Site reachability limits this run: Twitch rate-limits this IP (HTTP 429 on
both the directory and the homepage), Disney+ geo-redirects to `/en-pl`, and
Vimeo's config endpoint returns 401/500, so Vimeo videos never actually play
(readyState 0). Element-level behavior was still measurable.

## Findings

| site (jsonl line) | (a) video elements | (b) playbackRate 1.5 | (c) captions | (d) player | (e) blockers |
|---|---|---|---|---|---|
| vimeo-page (1) | 1, top frame; 1 cross-origin helper iframe (`player.vimeo.com/static/proxy.html`) | accepted, player restored 1.0 within 2 s (2 ratechange events) | 0 textTracks, 0 track elements | none on window (custom player) | config 401/500, readyState 0 |
| vimeo-page (9, 11) | 1, top frame (same as line 1) | accepted, restored 1.0 within 2 s in both runs | — | — | config 401/500 |
| vimeo-page (10) | 0 — player never mounted the element | — | — | — | config 401 |
| vimeo-embed (2) | 1, top frame (the embeddable player page itself) | sticks through 2 s and seek; reset to 1.0 by pause/play (2 ratechange events) | 0 textTracks, 0 track elements | none on window (custom player) | strict CSP (`script-src 'self' 'unsafe-inline' vimeocdn …`), readyState 0 |
| coursera (3) | 0 on the public course landing | — | — | none (React app) | lecture path (`/home/welcome`) bounces back to the landing; content needs enrollment; React #418 errors |
| twitch-live (4) | unreachable | — | — | — | HTTP 429 on directory and homepage |
| embed-host-fixture (5) | 1, inside the cross-origin player.vimeo.com iframe (the youtube-nocookie iframe mounted no video this run); top document has 0 | reset to 1.0 by pause/play — same embed behavior as line 2 | 0 textTracks | none | file:// host stands in for a third-party page |
| youtube-embed-direct (6) | 1, top frame (youtube-nocookie embed loaded directly) | sticks through all steps (embed idle) | 0 textTracks | none (YouTube's own player) | none observed |
| native-baseline (7) | 2, top frame (w3schools sample page) | sticks through all steps, 1 ratechange event (only the assignment) | 0 textTracks (page has no track elements) | native element | none — readyState 4 |
| drm-landing (8) | 0 — landing page has no player | — | — | — | geo-redirect to `/en-pl`, login bridge iframe |

## Per-site verdicts

- **vimeo-page — partial.** The element is reachable same-origin and the
  assignment is accepted, but the player restores 1.0 within 2 s in every
  mounted run (lines 1, 9, 11; line 10 the element never mounted). A matcher
  must re-apply the rate on a loop or on `ratechange`, and tolerate a player
  that occasionally presents no element at all. Captions are not in
  `textTracks`.
- **vimeo-embed — feasible.** Rate sticks through time and seek; pause/play
  resets it. The embed frame is cross-origin from any host page, so
  `all_frames` is mandatory. Behavior is identical when the embed sits inside
  a host document (line 5), so the reset rule is the embed player's, not the
  page's.
- **coursera — blocked for measurement.** No public video element; the
  lecture URL redirects back to the landing for guests. Player behavior
  unmeasured.
- **twitch — blocked.** 429 from this IP on both attempts. Live-stream rate
  behavior unmeasured.
- **embed-host-fixture — feasible, with the iframe caveat.** Video elements
  exist only in cross-origin frames; a top-frame-only script sees none. The
  youtube-nocookie iframe mounted a video in an earlier run and not in line
  5 — embed presence is dynamic.
- **youtube-embed-direct — feasible for rate.** Element-level rate works; the
  embed exposes no `textTracks` either (YouTube captions are custom-rendered,
  matching the Phase-0 finding that captions come from
  `ytInitialPlayerResponse`, which is only present on youtube.com pages).
- **native-baseline — fully feasible.** Plain elements accept and hold the
  rate; no player interference.
- **drm-landing — not a measurement target.** Landing pages carry no player;
  DRM playback itself was established as captureStream-blocked in prior
  research (speech-speed repo) and is not re-proven here.

## Cross-origin iframe analysis

Every candidate third-party host probed for a real embed (w3schools
`html_youtube.asp`, Wikipedia articles, Google's player-parameters page, The
Verge) rendered **no eager player iframe** — w3schools' page now ships three
`src=""` iframes, and the rest lazy-load or consent-gate embeds. Two
consequences: embed presence is dynamic (the matcher must watch for
late-appearing iframes), and the only dependable way to measure an embed is
the embed itself.

Where an embed exists, the video lives entirely in a cross-origin frame
(lines 5, 6). A content script matching the host page sees zero videos; it
must run with `all_frames: true` and with host permissions covering the
player origins (`youtube.com`, `youtube-nocookie.com`, `player.vimeo.com`,
…), or `<all_urls>`.

## Phase-3 matcher design implications

1. **Rate control is feasible at element level on every reachable player.**
   The mechanism (set `playbackRate`, verify, re-apply) works on native
   elements, Vimeo's custom player, and YouTube embeds. It is not enough to
   set once: Vimeo's players reset the rate on re-init (page) and on
   pause/play (embed, page and embedded alike), so the matcher needs a
   re-apply loop or `ratechange`/`play` listeners with a short re-assert.
2. **Captions are not available through the standard API anywhere.**
   `textTracks` was empty on every site, including the YouTube embed. The
   caption-based wpm tier stays YouTube-only (via `ytInitialPlayerResponse`);
   every other site falls back to the estimated tier. No per-site caption
   extraction is planned in Phase 3.
3. **Player-library detection by global is a dead end.** No shaka/video.js/
   hls.js/jwplayer global was present in any measured frame. The matcher
   should key on the element and frame structure (where is the video, which
   origin, does the rate stick) rather than library names.
4. **`all_frames` is required, and the frame's origin decides reachability.**
   A top-only script misses every embedded player. The matcher's site list
   must include embed origins; the frame tables (lines 1, 5, 6, 8) show
   exactly which frames carry players.
5. **Slow-down and auto-apply both ride the same rate mechanism.** Auto-apply
   works wherever the rate sticks; the re-apply loop covers the reset cases.
   Slow-down (<1x) has no separate blocker found on native/Vimeo elements.
6. **Live streams (Twitch) remain unverified from this network.** The matcher
   should treat live as best-effort until a residential-IP re-probe.
7. **CSP is not a blocker for content scripts** (they run in an isolated
   world), so Vimeo's strict policy (line 2) does not stop rate control; it
   only rules out injected `<script>` approaches. DRM hosts stay excluded —
   landing pages expose no player, and prior research established
   captureStream is blocked on DRM content.

**Overall verdict: the generic matcher is feasible for rate control on
Vimeo pages and embeds, native elements, and YouTube embeds, provided it runs
in all frames with a re-apply loop. Caption-based wpm does not generalize;
non-YouTube sites get the estimated tier. Twitch live and Coursera need a
residential-IP re-probe before the matcher commits to them.**
