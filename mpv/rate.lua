-- Pure-math core of the mpv port (no mp.*, testable standalone). Port of
-- lib/wpm.ts (rate estimators + SRT/VTT parsers) and lib/recommend.ts
-- (multiplier recommendation); keep the arithmetic in sync with the TS.

local M = {}

M.TARGET_WPM = 250
M.SAFE_ZONE_CEILING = 275
M.ROUNDING_STEP = 0.05
M.MANUAL_CUE_CLAMP = 1.5
M.SLOW_DOWN_FLOOR = 0.5

-- Maximal runs of ASCII letters and digits; every other byte splits tokens.
-- ASCII-only: %a matches Latin letters, so CJK, Hangul, Devanagari and
-- Arabic script count zero tokens (the port has no Unicode tokenizer — see
-- mpv/README.md limits). The extension's Intl.Segmenter modes (chars,
-- mora, vowels, Hangul blocks) are not ported.
function M.count_word_tokens(text)
  local n = 0
  for _ in text:gmatch("[%a%d]+") do
    n = n + 1
  end
  return n
end

-- True when the text is only bracket markers like [Music], whitespace
-- tolerated (lib/tokenizer.ts isBracketMarker).
function M.is_bracket_marker(text)
  return text:match("^%s*%[%[^%]]*%]%s*$") ~= nil
end

-- Token count in the language's rate unit. Only the word-run tokenizer and
-- the syllables-per-word conversion are ported; hangul_blocks and the
-- vowel/mora/chars modes need Unicode counting (see count_word_tokens).
local function unit_tokens(text, lang)
  local n = M.count_word_tokens(text)
  if lang and lang.syllables_per_word then
    n = n * lang.syllables_per_word
  end
  return n
end

local function spoken_cues(cues)
  local spoken = {}
  for _, cue in ipairs(cues) do
    if not M.is_bracket_marker(cue.text) then
      spoken[#spoken + 1] = cue
    end
  end
  return spoken
end

-- Wall-clock span from the first cue start to the last cue end, in seconds
-- (lib/wpm.ts cueSpanSec).
local function cue_span_sec(cues)
  if #cues == 0 then return nil end
  local first = cues[1]
  local last = cues[#cues]
  local span = last.start_sec + (last.dur_sec or 0) - first.start_sec
  return span > 0 and span or nil
end

-- Tokens of non-bracket cues over the span from the first to the last such
-- cue's start, per minute. The span keeps its pauses, so this is the
-- presentation rate the safe-zone literature measures. Null when fewer
-- than two spoken cues or the last starts no later than the first
-- (lib/wpm.ts filteredTokensOverTrimmedSpan).
function M.filtered_tokens_over_trimmed_span(cues, lang)
  local spoken = spoken_cues(cues)
  if #spoken == 0 then return nil end
  local first = spoken[1].start_sec
  local last = spoken[#spoken].start_sec
  if last <= first then return nil end
  local tokens = 0
  for _, cue in ipairs(spoken) do
    tokens = tokens + unit_tokens(cue.text, lang)
  end
  return (tokens / (last - first)) * 60
end

-- Manual-cue rate: filtered tokens over the silence-corrected speech
-- duration — sum of cue durations, capped at the cue span; inter-cue gaps
-- count as pure silence. Null when the speech estimate is empty or
-- non-positive (lib/wpm.ts estimateSpeechDurationSec + manualCueRate).
-- The ≤1.5x clamp for this tier lives in recommend().
function M.manual_cue_rate(cues, lang)
  local spoken = spoken_cues(cues)
  local span = cue_span_sec(spoken)
  if span == nil then return nil end
  local dur = 0
  for _, cue in ipairs(spoken) do
    dur = dur + (cue.dur_sec or 0)
  end
  local speech = math.min(dur, span)
  if speech <= 0 then return nil end
  local tokens = 0
  for _, cue in ipairs(spoken) do
    tokens = tokens + unit_tokens(cue.text, lang)
  end
  return (tokens / speech) * 60
end

local function parse_timestamp_pair(line)
  local sh, sm, ss, sms, eh, em, es, ems =
    line:match("^(%d+):(%d+):(%d+)[,.](%d+)%s*%-%-%>%s*(%d+):(%d+):(%d+)[,.](%d+)")
  if not sh then return nil end
  local function to_sec(h, m, s, ms)
    return tonumber(h) * 3600 + tonumber(m) * 60 + tonumber(s) + tonumber(ms) / 1000
  end
  return to_sec(sh, sm, ss, sms), to_sec(eh, em, es, ems)
end

-- Shared block walker: a line carrying "start --> end" opens a cue, the
-- following non-timestamp lines (transformed by `transform`) are its text,
-- the next timestamp closes it. Cue ids and headers (SRT index lines, the
-- WEBVTT banner, VTT cue identifiers) fall through the timestamp branch
-- and are skipped.
local function parse_cues(text, transform)
  local cues = {}
  local pending
  local function flush()
    if pending and pending.text then
      cues[#cues + 1] = pending
    end
    pending = nil
  end
  for line in text:gmatch("[^\r\n]+") do
    local start_sec, end_sec = parse_timestamp_pair(line)
    if start_sec then
      flush()
      pending = { start_sec = start_sec, dur_sec = end_sec - start_sec }
    elseif pending then
      local text_line = transform(line)
      if pending.text then
        pending.text = pending.text .. "\n" .. text_line
      else
        pending.text = text_line
      end
    end
  end
  flush()
  return cues
end

-- SRT: numbered blocks of "HH:MM:SS,mmm --> HH:MM:SS,mmm" plus text lines.
function M.parse_srt(text)
  return parse_cues(text, function(line) return line end)
end

-- VTT: WEBVTT header, dot timestamps; inline <...> tags are stripped from
-- cue text. Cue identifiers and NOTE lines are skipped by the walker.
function M.parse_vtt(text)
  return parse_cues(text, function(line)
    return (line:gsub("<[^>]*>", ""))
  end)
end

local function round_to_step(value, step)
  return math.floor(value / step + 0.5) * step
end

local function format_multiplier(value)
  return string.format("%g", math.floor(value * 100 + 0.5) / 100)
end

-- Multiplier = target / natural_rate, rounded to 0.05 and clamped per
-- tier: manual-cue ≤1.5x, every tier within [slow-down floor, platformMax].
-- target and ceiling arrive pre-resolved from the language model (plus the
-- user target); natural_rate must be measured in the language's unit.
-- Unreachable when even platformMax cannot reach the target. Warning when
-- the effective rate crosses the ceiling ('above-zone') or a clamp keeps
-- it below the target ('capped-below'); the cliff outranks the clamp
-- (lib/recommend.ts recommend, minus the asr-word pause-diluted and
-- music branches, which the mpv port has no inputs for).
function M.recommend(natural_rate, tier, target, ceiling, platform_max, unit_label)
  unit_label = unit_label or "wpm"
  if natural_rate * platform_max < target then
    local effective = natural_rate * platform_max
    return {
      multiplier = platform_max,
      effective_wpm = effective,
      mode = "unreachable",
      reason = nil,
      label = string.format("safe zone unreachable — %sx ≈ %d %s",
        format_multiplier(platform_max), math.floor(effective + 0.5), unit_label),
    }
  end

  local multiplier = round_to_step(target / natural_rate, M.ROUNDING_STEP)
  if tier == "manual-cue" then
    multiplier = math.min(multiplier, M.MANUAL_CUE_CLAMP)
  end
  local floor = math.min(M.SLOW_DOWN_FLOOR, platform_max)
  multiplier = math.min(math.max(multiplier, floor), platform_max)

  local effective = natural_rate * multiplier
  local clamped_below_zone =
    (tier == "manual-cue" and multiplier == M.MANUAL_CUE_CLAMP) or
    (multiplier == M.SLOW_DOWN_FLOOR and floor == M.SLOW_DOWN_FLOOR)

  local reason
  if effective > ceiling then
    reason = "above-zone"
  elseif clamped_below_zone and effective < target then
    reason = "capped-below"
  end
  local mode = reason == nil and "recommend" or "warning"

  local label = string.format("→ %sx ≈ %d %s",
    format_multiplier(multiplier), math.floor(effective + 0.5), unit_label)
  if reason == "capped-below" then
    label = label .. " (capped below safe zone)"
  end
  return {
    multiplier = multiplier,
    effective_wpm = effective,
    mode = mode,
    reason = reason,
    label = label,
  }
end

return M
