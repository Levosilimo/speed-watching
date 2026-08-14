#!/usr/bin/env bash
# Configure repository rulesets via the GitHub API.
#
# Run once after the first push to the new repository. Requires `gh auth
# login` and a token with admin:org / repo admin rights. Re-running fails
# with a name conflict — delete an existing ruleset of the same name first.
#
# Two rulesets, matching the solo-maintainer governance:
#   main  — every merge goes through a PR with the five required checks
#           (ci, e2e-chromium, e2e-chromium-cft, e2e-userscript,
#           e2e-firefox). Zero approving reviews so the maintainer can
#           merge their own PRs, strict policy off so the branch is never
#           blocked on a stale base. No force-push, no branch deletion.
#   v*    — release tags are immutable: no force-push, no deletion.

set -euo pipefail

usage() {
  echo "usage: $0 owner/repo" >&2
  exit 1
}

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  usage
fi

gh api "repos/$REPO/rulesets" --method POST --input <(cat <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [
    {
      "type": "required_pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "contexts": [
          "ci",
          "e2e-chromium",
          "e2e-chromium-cft",
          "e2e-userscript",
          "e2e-firefox"
        ]
      }
    },
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ]
}
JSON
) >/dev/null
echo "ruleset 'main' created"

gh api "repos/$REPO/rulesets" --method POST --input <(cat <<'JSON'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] }
  },
  "rules": [
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ]
}
JSON
) >/dev/null
echo "ruleset 'release tags' created"
