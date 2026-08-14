# Ports: mpv Lua + userscript (lib-17, Aug 2026)

Both ports are cue-level ports of the extension's YouTube measure pipeline
(`lib/` modules shared unchanged). Gate safety is automatic: tsc/oxlint/
knip/ast-grep/aislop ignore `.lua`; the userscript's built `.user.js` is
kept out of the gate-scanned tree via `.gitignore` (`userscript/dist/`).

## A. mpv Lua port (`mpv/`)

A script for the mpv media player that measures the natural speech rate of
the currently loaded file's external subtitle track and recommends a
playback multiplier for the safe zone.

- **Files**: `speed-watcher.lua` (glue: options, events, keybindings, OSD),
  `rate.lua` (pure math, require-able without `mp`), `languages.lua` (the
  22-language table as Lua data), `README.md`, `tests/`.
- **Source of truth**: subtitle files read from
  `track-list/N/external-filename` (subtitle timing is not exposed to
  scripts); SRT and VTT only, ASS skipped. UTF-8 assumed.
- **Measurement**: cue-level manual-cue semantics — silence-corrected rate
  (`min(Σ cue.dur, span)`) with the ≤1.5x clamp, never the raw presentation
  rate.
- **Recommendation**: `recommend()` port with `tier='manual-cue'`,
  `contentType='generic'`, `platformMax=mpv_max`, `userTarget=target`,
  `language`. Music and estimated tiers are dropped.
- **Speed persistence**: mpv persists speed across seeks and files, so the
  script re-asserts only when speed is back at 1.0 after a measurement
  (`--reset-on-next-file=speed` resets it); the script's own sets carry a
  non-1.0 speed and are excluded by that rule.
- **Keys**: `Ctrl+w` measure, `Ctrl+Shift+w` apply (recommend/warning
  only), `Ctrl+Alt+w` dismiss. OSD shows `→ 1.6x ≈ 240 wpm` plus a hint
  line; unreachable renders `safe zone unreachable — 8x ≈ N wpm`.
- **Options** (script-opts `speed_watcher.conf` or
  `--script-opts=speed_watcher-*`): `target=nil` (→ language-model target),
  `language="en"`, `auto_apply=false`, `mpv_max=8.0`,
  `reset_sentinel=true`, `osd_ms=4000`.
- **Known divergence**: LuaJIT 5.1 has no Unicode-property regex, so the
  Lua tokenizer counts `[%a%d]+` runs — Cyrillic/CJK text undercounts
  tokens. Documented, not fixed in v1; the TS port uses `\p{L}\p{N}`.

## B. Userscript port (`userscript/`)

A userscript for YouTube watch pages with the identical measure flow: player
response → first caption track → WEB json3 fetch, ANDROID innertube
fallback → tier selection (`asr-word`/`asr-cue`/`manual-cue`) → content-type
auto-detect + music detection → `recommend()` at `platformMax=2`.

- **Files**: `src/main.ts` (measure flow, keybindings, entry),
  `src/pill.ts` (minimal fixed-position pill + target prompt),
  `src/storage.ts` (two-key GM storage shim), `scripts/build-userscript.ts`
  (bun build + metadata prepend + e2e hook append), bundle test, e2e spec,
  `README.md`.
- **Host**: `@match *://*.youtube.com/*`, `@grant GM_setValue`/`GM_getValue`,
  `@run-at document-start`. SPA navigation re-measures on
  `yt-navigate-finish`; capture-phase media listeners track the active
  video; live streams are suppressed. `Shift+W` applies, `Escape` dismisses.
- **Storage**: exactly two GM keys — `speedwatcher.target` (number,
  optional) and `speedwatcher.channelRates` (JSON map, LRU-50, mirroring
  `lib/channel-memory.ts`). Gated on `typeof GM_setValue !== 'undefined'`;
  Greasemonkey 4's async API no-ops gracefully and the script still
  measures. The estimated tier uses the channel-seeded rate when one was
  measured in the same language, else the prior midpoint — the full
  22-language table is bundled for that.
- **E2E hooks**: `speedwatcher:measure` CustomEvent and
  `window.__speedwatcherPill` behind the runtime flag
  `window.__speedwatcherE2E`; the build appends a relay that mirrors the
  last measure into `window.__speedwatcherLastMeasure`.

## C. Shared limits

- **mpv**: cue-level only, no music detection, no estimated tier, English
  OSD only, ASCII tokenization, UTF-8 SRT only, ASS skipped, auto-apply
  opt-in.
- **Userscript**: no options page/bridge/provider/override-log/demand;
  storage = target + channel memory only; live suppressed; music and
  estimated tiers included.
- **Not ported anywhere**: `chrome.*` everywhere, messaging bridge,
  wpm-protocol/provider, override-log, demand, settings store, shadow-DOM
  pill, captions-harvest/matcher, audio/stt, offscreen/options entrypoints,
  i18n layer.
