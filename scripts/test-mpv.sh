#!/usr/bin/env sh
# mpv Lua unit tests (mpv/tests). The harness is plain Lua 5.1 — the rate
# math is require-able without the mpv runtime — so any lua5.1 or luajit
# binary runs it. Prefer lua5.1, fall back to luajit, fail loudly if
# neither is installed.

set -u

if command -v lua5.1 >/dev/null 2>&1; then
  LUA=lua5.1
elif command -v luajit >/dev/null 2>&1; then
  LUA=luajit
else
  echo "test:mpv: need lua5.1 or luajit on PATH (Debian/Ubuntu: apt install lua5.1)" >&2
  exit 1
fi

fail=0
for t in mpv/tests/rate_test.lua mpv/tests/recommend_test.lua; do
  "$LUA" "$t" || fail=1
done
exit $fail
