-- Minimal assertion harness for the mpv Lua unit tests. Run a test file
-- with lua5.1 or luajit; the file calls harness.finish() last.

local M = { total = 0, failures = 0 }

function M.assert_eq(actual, expected, msg)
  M.total = M.total + 1
  if actual ~= expected then
    M.failures = M.failures + 1
    io.write(string.format("  assertion failed: %s (expected %s, got %s)\n",
      msg or "assert_eq", tostring(expected), tostring(actual)))
  end
end

function M.assert_close(actual, expected, eps, msg)
  eps = eps or 1e-9
  M.total = M.total + 1
  if math.abs(actual - expected) > eps then
    M.failures = M.failures + 1
    io.write(string.format("  assertion failed: %s (expected %s ± %g, got %s)\n",
      msg or "assert_close", tostring(expected), eps, tostring(actual)))
  end
end

-- Runs one test function; prints PASS/FAIL. Assertion failures inside fn
-- are recorded by the helpers; a raised error fails the whole run.
function M.run(name, fn)
  local before = M.failures
  local ok, err = pcall(fn)
  if ok and M.failures == before then
    io.write("PASS " .. name .. "\n")
  elseif ok then
    io.write("FAIL " .. name .. " (see assertions above)\n")
  else
    M.failures = M.failures + 1
    io.write("FAIL " .. name .. ": " .. tostring(err) .. "\n")
  end
end

function M.finish()
  io.write(string.format("%d assertions, %d failures\n", M.total, M.failures))
  if M.failures > 0 then
    os.exit(1)
  end
end

return M
