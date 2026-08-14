-- Shared fixtures for the mpv Lua unit tests.

return {
  -- Five cues, one bracket marker. Spoken tokens: 2 + 6 + 3 + 2 = 13.
  -- Trimmed span: first.start 0 → last.start 10 → 13/10*60 = 78.
  -- Cue span 10 + 2.5 − 0 = 12.5; Σdur over spoken cues = 2.5+3+2+2.5 = 10
  -- → min 10 → 13/10*60 = 78.
  srt = [[
1
00:00:00,000 --> 00:00:02,500
Hello world

2
00:00:02,500 --> 00:00:05,000
[Music]

3
00:00:05,000 --> 00:00:08,000
This is a longer caption line

4
00:00:08,000 --> 00:00:10,000
More words here

5
00:00:10,000 --> 00:00:12,500
Final caption
]],

  -- Both cues start at the same instant: trimmed-span rate must be null.
  -- Spoken tokens 5, cue span 1 + 2 − 1 = 2, Σdur 3 → min is 2 → 5/2*60 = 150.
  srt_same_start = [[
1
00:00:01,000 --> 00:00:02,000
Same start

2
00:00:01,000 --> 00:00:03,000
Same start again
]],

  -- WEBVTT with inline tags; timestamps use the VTT dot separator.
  vtt = [[
WEBVTT

00:00:00.000 --> 00:00:02.500
Hello <b>world</b>

00:00:02.500 --> 00:00:05.000
<i>Italic caption</i> with tags
]],
}
