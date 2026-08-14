-- Speed Watcher (mpv): measures the speech rate of the selected external
-- subtitle track and recommends — or applies — the playback speed that
-- lands the effective rate in the ~250-275 wpm safe zone. Port of the
-- extension's manual-cue tier (lib/wpm.ts + lib/recommend.ts); see
-- mpv/README.md for install and options.

local mp = require("mp")
local mp_options = require("mp.options")
local options = {
  target = nil,
  language = "en",
  auto_apply = false,
  mpv_max = 8.0,
  reset_sentinel = true,
  osd_ms = 4000,
}
mp_options.read_options(options, "speed_watcher")

local script_dir = debug.getinfo(1, "S").source:match("^@(.*)/[^/]*$")
package.path = package.path .. ";" .. script_dir .. "/?.lua"
local rate = require("rate")
local languages = require("languages")

local state = {
  measured_this_file = false,
  last_multiplier = nil,
  last_mode = nil,
}

local function unit_label(lang)
  return languages.UNIT_LABELS[lang.unit] or lang.unit
end

-- Selected external subtitle track from the track-list, or nil.
local function find_external_sub()
  local tracks = mp.get_property_native("track-list") or {}
  for _, track in ipairs(tracks) do
    if track.type == "sub" and track.selected and track.external
      and track["external-filename"] then
      return track
    end
  end
end

-- Reads the external subtitle track and returns the recommendation, the
-- natural rate and the language model; OSDs the failure and returns nil
-- when nothing usable is found.
local function measure()
  local lang = languages[options.language] or languages.en
  local track = find_external_sub()
  if not track then
    mp.osd_message("speed-watcher: no external subtitle track", options.osd_ms)
    return nil
  end
  if track.codec == "ass" then
    mp.osd_message("speed-watcher: ASS subtitles are not supported", options.osd_ms)
    return nil
  end
  local path = track["external-filename"]
  local ext = path:match("%.([^%.]+)$")
  if ext then ext = string.lower(ext) end
  local f = io.open(path, "rb")
  if not f then
    mp.osd_message("speed-watcher: cannot read subtitle file", options.osd_ms)
    return nil
  end
  local text = f:read("*a")
  f:close()
  local cues
  if ext == "srt" then
    cues = rate.parse_srt(text)
  elseif ext == "vtt" then
    cues = rate.parse_vtt(text)
  else
    mp.osd_message("speed-watcher: unsupported subtitle format", options.osd_ms)
    return nil
  end
  local natural = rate.manual_cue_rate(cues, lang)
  if natural == nil then
    mp.osd_message("speed-watcher: no usable cues", options.osd_ms)
    return nil
  end
  local user_target = options.target and tonumber(options.target) or nil
  local rec = rate.recommend(
    natural, "manual-cue",
    user_target or lang.target, lang.ceiling, options.mpv_max,
    unit_label(lang))
  return rec, natural, lang
end

local function run_measurement(apply)
  local rec, natural, lang = measure()
  if not rec then return end
  state.measured_this_file = true
  state.last_multiplier = rec.multiplier
  state.last_mode = rec.mode
  if apply then
    mp.set_property_number("speed", rec.multiplier)
  end
  local lines = { rec.label }
  if rec.mode == "warning" and rec.reason == "above-zone" then
    lines[#lines + 1] = "above the comprehension ceiling"
  end
  lines[#lines + 1] = string.format("measured %.0f %s", natural, unit_label(lang))
  lines[#lines + 1] = "Ctrl+Shift+W to apply · Ctrl+Alt+W to dismiss"
  mp.osd_message(table.concat(lines, "\n"), options.osd_ms)
end

mp.add_key_binding("Ctrl+w", "speed-watcher-measure", function()
  run_measurement(false)
end)
mp.add_key_binding("Ctrl+Shift+W", "speed-watcher-apply", function()
  run_measurement(true)
end)
mp.add_key_binding("Ctrl+Alt+W", "speed-watcher-dismiss", function()
  state.measured_this_file = false
  state.last_multiplier = nil
  state.last_mode = nil
  mp.set_property_number("speed", 1.0)
  mp.osd_message("speed watcher dismissed", options.osd_ms)
end)

mp.register_event("file-loaded", function()
  state.measured_this_file = false
  if options.auto_apply then
    run_measurement(true)
  end
end)

mp.register_event("end-file", function()
  state.measured_this_file = false
end)

-- Re-assert the applied speed when something resets it to 1.0 mid-file;
-- keeps the safe zone until dismissed or the file ends.
mp.observe_property("speed", "number", function(_, value)
  if value == 1.0 and state.measured_this_file and options.auto_apply
    and options.reset_sentinel
    and (state.last_mode == "recommend" or state.last_mode == "warning") then
    mp.set_property_number("speed", state.last_multiplier)
  end
end)
