# Speed Watcher for mpv

Sets playback speed so the effective speech rate of a video with an
external subtitle track lands in the ~250-275 wpm safe zone. A port of the
Speed Watcher browser extension's manual-cue tier: the rate math
(`rate.lua`) and the language model (`languages.lua`) mirror `lib/wpm.ts`,
`lib/recommend.ts` and `lib/languages.ts` in the repo root.

## Install

Put the files into a subdirectory of your mpv scripts folder, so mpv does
not auto-load `rate.lua` and `languages.lua` as scripts of their own:

```
mkdir -p ~/.config/mpv/scripts/speed-watcher
cp speed-watcher.lua rate.lua languages.lua ~/.config/mpv/scripts/speed-watcher/
```

Options go in `~/.config/mpv/script-opts/speed_watcher.conf`:

```
language=en
auto_apply=no
mpv_max=8.0
reset_sentinel=yes
osd_ms=4000
# target=250
```

## Keys

| Binding | Action |
|---|---|
| Ctrl+w | Measure and show the recommendation |
| Ctrl+Shift+W | Measure and apply the speed |
| Ctrl+Alt+W | Dismiss: stop watching and restore 1x |

## Options

- `target` — override the language's target rate, in the language's unit
  (wpm / cpm / syl/min / morae/min). Unset → the language model's target.
- `language` — language model code from `languages.lua`; default `en`.
- `auto_apply` — `yes` to measure and apply automatically on file load.
- `mpv_max` — speed cap the recommendation clamps to; default 8.0.
- `reset_sentinel` — with `yes` (default), re-apply the speed whenever it
  returns to 1.0 after we applied it (recovers from manual resets).
- `osd_ms` — OSD display time in ms; default 4000.

## How it measures

The natural rate is the spoken token count over the silence-corrected
speech duration: the sum of cue durations, capped at the first-to-last cue
span. `[Music]`-style bracket cues are skipped. The multiplier is
target ÷ natural rate, rounded to 0.05, clamped to [0.5, mpv_max] with a
1.5x cap on cue-level measurements; an effective rate above the ceiling
warns instead of recommending.

## Limits

- Cue-level only: inter-cue gaps count as silence; pauses inside a cue
  count as speech.
- ASCII tokenizer: `[a-zA-Z0-9]+` runs. Non-Latin script measures as
  ~0 wpm, so CJK, Hangul, Devanagari, Arabic and Cyrillic tracks are not
  measured correctly.
- UTF-8 only: subtitle files are read as raw bytes; other encodings
  misparse.
- ASS subtitles are skipped (no cue timing in the text payload).
- No music detection: only bracket-marker cues are filtered.
- No i18n: OSD messages are English only.

## Tests

Requires lua5.1 or luajit:

```
lua5.1 mpv/tests/rate_test.lua
lua5.1 mpv/tests/recommend_test.lua
```
