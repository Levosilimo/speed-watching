# Dzen + Rutube caption adapters

Shipped with lib-12. The vk-probe (`docs/vk-probe.md`) found two more
captioned players behind the generic matcher's all_urls surface; both ride
one new generic probe — no platform code, no site-list change.

## Probe #5 — `video > track[src]` subtitles

`lib/captions-harvest.ts`, after the HLS probe. The content script
collects every `video > track[src]` attribute on the page; the harvest
(which stays DOM-free) fetches each src via the injected `fetchImpl` and
returns the first payload that yields words or cues. It runs before the
VTT-entries probe: when a page both loads a `.vtt` and mounts a `<track>`
for it, the word-level parse is strictly more informative than the
cue-level one — and Dzen's `vd*.okcdn.ru/?…` and Rutube's `…/*.srt` URLs
never match the `.vtt`-only regex anyway.

- **Dzen** (`dzen.ru/video`, MSE player, captions on OK.ru CDN): the track
  src is a signed `vd*.okcdn.ru/?…&type=2&subId=…` URL whose body is
  WebVTT. The new `parseVttWords` expands the inline
  `<00:00:19.225><c>самого</c>` runs into per-word segments (untimed lead
  text attaches to the first timed start); the same fetch also parses
  cue-level via the existing `parseVtt`. Word count ≥ 2 → **asr-word**.
- **Rutube** (`rutube.ru`, `pic.rtbcdn.ru/subtitle/<date>/<hash>.srt`):
  real SRT — vtt.js rejects it (no WEBVTT header, comma timestamps), so
  `parseSrt`/`normalizeSrt` apply the validated recipe: commas → dots,
  sequence-number lines dropped, `WEBVTT\n\n` prepended (the blank line is
  mandatory or the first cue is lost). Cue-level only → **manual-cue**.

`entrypoints/generic.content.ts` now mirrors the YouTube asr branch:
word-timed harvests measure `filteredTokensOverTrimmedSpan(cues)` and
render the `asrTierInputs` tier (`asr-word`/`asr-cue`), cue-only payloads
keep the `manualCueRate`/`manual-cue` path. The track's `srclang`/`lang`
resolves the language model (Dzen's `ru` → target 168/ceiling 180; the ru
target stays `derived: true` — the estimate chain in `lib/languages.ts`).

## Honest limits

- **Signed-URL expiry.** Dzen track URLs carry `expires=…`; the content
  script re-reads `track[src]` at measure time, but an expired URL still
  fetches 403 → the probe returns null → estimated tier. No refresh
  attempt (the player's own refresh is page-internal).
- **CORS inference.** The probe runs page-context `fetch` against CDNs it
  has never exercised from a content script. The e2e fixture server proves
  the path with `Access-Control-Allow-Origin: *`; a real CDN that withholds
  CORS headers degrades safely to estimated — never a crash.
- **Rutube author gate (~50%).** Trending videos whose authors did not
  enable subtitles expose no `<track>` element at all → null → estimated.
  The SRT hash URL is never guessed.
- **Dzen player variance.** Record 13 in the probe showed no apiCues and
  one video mounted no player; the track element appears/disappears with
  the player. The probe reads `track[src]` at measure time, so pre-toggle
  and player-less states yield estimated, and the MutationObserver
  re-measures when the track appears.
- **Tag-joined cue text.** Dzen cue text joins words with tags and no
  spaces (`С<00:00:19.225><c>самого</c>…`), so the cue-level fallback parse
  counts each cue as one token run — the asr-cue rate and the
  pause-diluted articulatory input run low. Safe direction: the warning
  stays off, never fabricates; the asr-word tier itself is unaffected
  (timing comes from the word runs). A word-derived cue-text reconstruction
  is a possible follow-up.
- **VK Video stays out.** The vk-probe's anti-bot wall (`vkvideo.ru/
  challenge.html`) was never cleared; the VK word-timestamp claim remains
  unverified from this box.
