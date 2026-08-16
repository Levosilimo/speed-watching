-- Lifecycle tests for mpv/main.lua: when the reset sentinel arms and what
-- apply may do. main.lua runs against the mp stub (mp_stub.lua) — the rate
-- math and state transitions are real, only the mpv runtime boundary is
-- faked; the speed observer is driven like mpv fires it on a property
-- change. Run with: lua5.1 mpv/tests/main_lifecycle_test.lua

local script_dir = debug.getinfo(1, "S").source:match("^@(.*)/[^/]*$")
package.path = package.path .. ";" .. script_dir .. "/?.lua;" .. script_dir .. "/../?.lua"

local harness = require("harness")
local stub = require("mp_stub")
require("main") -- pulls the stub's mp via package.loaded

-- The sentinel only fires when auto_apply is on (main.lua line ~137).
stub.options.auto_apply = true

local assert_eq = harness.assert_eq
local assert_close = harness.assert_close

local function write_fixture(text)
  local path = os.tmpname() .. ".srt"
  local f = assert(io.open(path, "wb"))
  f:write(text)
  f:close()
  return path
end

-- 20 words over 6 s → 200 wpm; 250/200 → 1.25x, inside the manual-cue
-- clamp and the zone, so the recommendation is mode "recommend".
local recommend_srt = write_fixture([[
1
00:00:00,000 --> 00:00:06,000
a b c d e f g h i j k l m n o p q r s t
]])

-- 1 word over 60 s → 1 wpm; 1 × 8 < 250, so the recommendation is
-- mode "unreachable" at the platform max.
local unreachable_srt = write_fixture([[
1
00:00:00,000 --> 00:00:60,000
hello
]])

local function select_track(path)
  stub.track = {
    type = "sub", selected = true, external = true,
    ["external-filename"] = path, codec = "srt",
  }
end

-- Dismiss is a real user path that resets the armed state and speed; the
-- applied log is then cleared so each scenario counts only its own applies.
local function reset()
  stub.bindings["speed-watcher-dismiss"]()
  stub.applied = {}
end

harness.run("measure-only does not arm the reset sentinel", function()
  select_track(recommend_srt)
  reset()
  stub.bindings["speed-watcher-measure"]()
  assert_eq(#stub.applied, 0, "measure-only applies nothing")
  stub.speed_observer("speed", 1.0)
  assert_eq(#stub.applied, 0, "no re-assert after a measure-only")
end)

harness.run("apply arms the reset sentinel", function()
  select_track(recommend_srt)
  reset()
  stub.bindings["speed-watcher-apply"]()
  assert_eq(#stub.applied, 1, "apply sets the speed once")
  assert_close(stub.speed, 1.25, 1e-9, "applied multiplier")
  stub.speed_observer("speed", 1.0)
  assert_eq(#stub.applied, 2, "reset re-asserts the applied multiplier")
  assert_close(stub.speed, 1.25, 1e-9, "re-asserted multiplier")
end)

harness.finish()
