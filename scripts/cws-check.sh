#!/usr/bin/env sh
# CWS review-prep gate: cws-check over the BUILT bundle, not the entrypoints
# — .output/chrome-mv3 is what Chrome's reviewers actually scan. Exit code
# propagates (1 = compliance finding, 2 = bundle missing).

set -u

BUNDLE="${1:-.output/chrome-mv3}"

if [ ! -f "$BUNDLE/manifest.json" ]; then
  echo "cws-check: missing $BUNDLE/manifest.json — run 'bun run build' first" >&2
  exit 2
fi

# bunx resolves the local devDep; npx is the fallback when bun cannot reach
# its registry. The last command's exit code becomes the script's.
bunx cws-check "$BUNDLE" || npx --yes cws-check "$BUNDLE"
