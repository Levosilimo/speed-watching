-- Unit tests for mpv/rate.lua: tokenizer, bracket markers, rate estimators
-- and both subtitle parsers. Run with: lua5.1 mpv/tests/rate_test.lua

local script_dir = debug.getinfo(1, "S").source:match("^@(.*)/[^/]*$")
package.path = package.path .. ";" .. script_dir .. "/?.lua;" .. script_dir .. "/../?.lua"

local harness = require("harness")
local rate = require("rate")
local fixtures = require("fixtures")

local assert_eq = harness.assert_eq
local assert_close = harness.assert_close

harness.run("count_word_tokens", function()
  assert_eq(rate.count_word_tokens("Hello world"), 2, "two words")
  assert_eq(rate.count_word_tokens("a1 b2 c3"), 3, "letter-digit runs")
  assert_eq(rate.count_word_tokens("one-two three"), 3, "dash splits tokens")
  assert_eq(rate.count_word_tokens("  spaced   out  "), 2, "whitespace tolerated")
  assert_eq(rate.count_word_tokens(""), 0, "empty text")
  assert_eq(rate.count_word_tokens("Привет мир"), 0, "non-Latin script counts zero (ASCII-only)")
  assert_eq(rate.count_word_tokens("日本語テキスト"), 0, "CJK counts zero (ASCII-only)")
end)

harness.run("is_bracket_marker", function()
  assert_eq(rate.is_bracket_marker("[Music]"), true, "single marker")
  assert_eq(rate.is_bracket_marker("  [Applause]  "), true, "whitespace tolerated")
  assert_eq(rate.is_bracket_marker("[♪ ♫]"), true, "symbols inside brackets")
  assert_eq(rate.is_bracket_marker("[]"), true, "empty brackets")
  assert_eq(rate.is_bracket_marker("Hello"), false, "plain text")
  assert_eq(rate.is_bracket_marker("[Music] playing"), false, "text after marker")
  assert_eq(rate.is_bracket_marker(""), false, "empty text")
end)

harness.run("filtered_tokens_over_trimmed_span", function()
  local cues = rate.parse_srt(fixtures.srt)
  assert_close(rate.filtered_tokens_over_trimmed_span(cues), 78, 1e-9, "en default")
  assert_close(rate.filtered_tokens_over_trimmed_span(cues, { syllables_per_word = 2.0 }), 156, 1e-9, "syllable factor applies")
  assert_eq(rate.filtered_tokens_over_trimmed_span(rate.parse_srt(fixtures.srt_same_start)), nil, "last == first is null")
  assert_eq(rate.filtered_tokens_over_trimmed_span({}), nil, "empty cues is null")
  assert_eq(rate.filtered_tokens_over_trimmed_span({ { text = "[Music]", start_sec = 0, dur_sec = 1 } }), nil, "only bracket cues is null")
end)

harness.run("manual_cue_rate", function()
  local cues = rate.parse_srt(fixtures.srt)
  assert_close(rate.manual_cue_rate(cues), 78, 1e-9, "silence-corrected rate")
  assert_close(rate.manual_cue_rate(cues, { syllables_per_word = 2.0 }), 156, 1e-9, "syllable factor applies")
  assert_close(rate.manual_cue_rate(rate.parse_srt(fixtures.srt_same_start)), 150, 1e-9, "same-start cues still rate via span+dur")
  assert_eq(rate.manual_cue_rate({}), nil, "empty cues is null")
  assert_eq(rate.manual_cue_rate({ { text = "x", start_sec = 0, dur_sec = 0 }, { text = "y", start_sec = 5, dur_sec = 0 } }), nil, "zero speech duration is null")
  assert_eq(rate.manual_cue_rate({ { text = "[Music]", start_sec = 0, dur_sec = 5 } }), nil, "only bracket cues is null")
end)

harness.run("parse_srt", function()
  local cues = rate.parse_srt(fixtures.srt)
  assert_eq(#cues, 5, "five cues")
  assert_eq(cues[1].text, "Hello world", "first cue text")
  assert_close(cues[1].start_sec, 0, 1e-9, "first cue start")
  assert_close(cues[1].dur_sec, 2.5, 1e-9, "first cue duration")
  assert_eq(cues[2].text, "[Music]", "bracket cue kept as text")
  assert_close(cues[5].start_sec, 10, 1e-9, "last cue start")
  assert_close(cues[5].dur_sec, 2.5, 1e-9, "last cue duration")
  assert_eq(#rate.parse_srt(""), 0, "empty input parses to no cues")
  assert_eq(#rate.parse_srt("no timestamps here\njust text"), 0, "timestamp-less input parses to no cues")
end)

harness.run("parse_vtt", function()
  local cues = rate.parse_vtt(fixtures.vtt)
  assert_eq(#cues, 2, "two cues")
  assert_eq(cues[1].text, "Hello world", "inline tags stripped")
  assert_close(cues[1].start_sec, 0, 1e-9, "first cue start")
  assert_close(cues[1].dur_sec, 2.5, 1e-9, "first cue duration")
  assert_eq(cues[2].text, "Italic caption with tags", "second cue text stripped")
  assert_close(cues[2].start_sec, 2.5, 1e-9, "second cue start")
  assert_eq(#rate.parse_vtt(""), 0, "empty input parses to no cues")
  assert_eq(#rate.parse_vtt("WEBVTT\n\njust a header"), 0, "header-only input parses to no cues")
end)

harness.finish()
