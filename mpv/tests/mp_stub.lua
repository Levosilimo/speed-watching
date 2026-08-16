-- mpv runtime stub: the mp API surface main.lua uses, capturing the key
-- bindings, events, the speed observer and every applied speed so the
-- lifecycle can be driven without an mpv instance. The test drives the
-- captured callbacks directly; nothing runs on its own. Must be required
-- before main.lua: it seeds package.loaded["mp"] and ["mp.options"].

local M = {
  speed = 1.0,
  applied = {}, -- { name = ..., value = ... } in call order
  bindings = {}, -- binding name -> fn
  events = {}, -- event name -> fn
  speed_observer = nil, -- observe_property("speed") callback
  track = nil, -- track-list payload for get_property_native
  options = nil, -- the options table read_options received
}

function M.osd_message() end

function M.set_property_number(name, value)
  M.applied[#M.applied + 1] = { name = name, value = value }
  if name == "speed" then M.speed = value end
end

function M.get_property_native(name)
  if name == "track-list" then
    return M.track and { M.track } or {}
  end
  return nil
end

function M.add_key_binding(_, name, fn)
  M.bindings[name] = fn
end

function M.register_event(name, fn)
  M.events[name] = fn
end

function M.observe_property(_, _, fn)
  M.speed_observer = fn
end

-- read_options mutates the script's options table in real mpv; capture the
-- table so the test can flip auto_apply the way a script-opts file would.
local mp_options = {}
function mp_options.read_options(opts)
  M.options = opts
end

package.loaded["mp"] = M
package.loaded["mp.options"] = mp_options

return M
