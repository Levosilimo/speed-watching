#!/usr/bin/env bash
# Speed Watcher — one-shot GitHub publication setup (verified against gh 2.88.1).
# Run from the repo root AFTER `gh auth login`.
set -euo pipefail

OWNER="levosilimo"
REPO="speed-watching"
FULL="$OWNER/$REPO"
DESC="WPM-based speed-watching extension"
HOME_URL="https://levosilimo.github.io/$REPO/"

command -v gh >/dev/null || { echo "gh not installed" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }
gh repo view "$FULL" >/dev/null 2>&1 && { echo "repo already exists — aborting" >&2; exit 1; }

gh repo create "$FULL" --public --source . --remote origin --push \
  --description "$DESC" --homepage "$HOME_URL"

gh repo edit "$FULL" --default-branch main --delete-branch-on-merge \
  --allow-update-branch --enable-issues --enable-discussions \
  --enable-squash-merge --enable-auto-merge --enable-secret-scanning \
  --enable-secret-scanning-push-protection

gh api --method PUT "repos/$FULL/topics" --input <(printf '%s' '{
  "names": ["browser-extension","chrome-extension","firefox-addon","userscript",
            "tampermonkey","video-speed","playback-speed","wpm","youtube",
            "captions","mpv"]}')

gh api --method POST "repos/$FULL/rulesets" --input <(cat <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "required_status_checks": [
          { "context": "ci" },
          { "context": "e2e-chromium" },
          { "context": "e2e-chromium-cft" },
          { "context": "e2e-userscript" },
          { "context": "e2e-firefox" }
        ],
        "strict_required_status_checks_policy": false } },
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ]
}
JSON
) >/dev/null
gh api --method POST "repos/$FULL/rulesets" --input <(cat <<'JSON'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [ { "type": "non_fast_forward" }, { "type": "deletion" } ]
}
JSON
) >/dev/null

labels=(
  "bug:d73a4a:Something isnt working"
  "enhancement:a2eeef:New feature or request"
  "documentation:0075ca:Improvements or additions to documentation"
  "question:d876e3:Further information is requested"
  "good first issue:7057ff:Good for newcomers"
  "help wanted:008672:Extra attention is needed"
  "needs-triage:fbca04:Needs maintainer triage"
  "wontfix:ffffff:This will not be worked on"
  "i18n:1d76db:Localization and translation"
  "port:5319e7:Port to another platform or engine"
  "store:0e8a16:Store listing / submission"
  "launch:bfd4f2:Launch-day task"
  "triage:fef2c0:Needs attention"
)
for entry in "${labels[@]}"; do
  name="${entry%%:*}"; rest="${entry#*:}"; color="${rest%%:*}"; desc="${rest#*:}"
  gh label create "$name" --color "$color" --description "$desc" --force
done

OWNER_ID="$(gh api user --jq '.id')"
for env in cws amo; do
  gh api --method PUT "repos/$FULL/environments/$env" \
    --input <(printf '{"reviewers":[{"type":"User","id":%s}],"prevent_self_review":false}' "$OWNER_ID") >/dev/null
done

# Secrets: skipped unless all 7 values are exported (the user provides them).
if [[ -n "${EXTENSION_ID:-}" && -n "${CLIENT_ID:-}" && -n "${CLIENT_SECRET:-}" && -n "${REFRESH_TOKEN:-}" && -n "${PUBLISHER_ID:-}" && -n "${WEB_EXT_API_KEY:-}" && -n "${WEB_EXT_API_SECRET:-}" ]]; then
  gh secret set EXTENSION_ID   --env cws --body "$EXTENSION_ID"
  gh secret set CLIENT_ID      --env cws --body "$CLIENT_ID"
  gh secret set CLIENT_SECRET  --env cws --body "$CLIENT_SECRET"
  gh secret set REFRESH_TOKEN  --env cws --body "$REFRESH_TOKEN"
  gh secret set PUBLISHER_ID   --env cws --body "$PUBLISHER_ID"
  gh secret set WEB_EXT_API_KEY    --env amo --body "$WEB_EXT_API_KEY"
  gh secret set WEB_EXT_API_SECRET --env amo --body "$WEB_EXT_API_SECRET"
else
  echo "Secret values not exported — skipping the secrets step (user provides them)."
fi

gh api --method POST "repos/$FULL/pages" --input <(printf '%s' '{"build_type":"workflow"}') >/dev/null

gh api --method PUT "repos/$FULL/private-vulnerability-reporting" \
  --input <(printf '%s' '{"enabled":true}') >/dev/null
gh api --method PUT "repos/$FULL/vulnerability-alerts" >/dev/null
gh api --method PUT "repos/$FULL/automated-security-fixes" >/dev/null

REPO_ID="$(gh api graphql -f query='query($o:String!,$r:String!){repository(owner:$o,name:$r){id}}' -F o="$OWNER" -F r="$REPO" --jq '.data.repository.id')"
CATEGORY_ID="$(gh api graphql -f query='query($o:String!,$r:String!){repository(owner:$o,name:$r){discussionCategories(first:1){nodes{id}}}}' -F o="$OWNER" -F r="$REPO" --jq '.data.repository.discussionCategories.nodes[0].id')"
WELCOME_BODY="$(cat <<'EOF'
# Welcome to Speed Watcher

Speed Watcher sets video playback speed so effective speech rate lands in
the ~250-275 wpm safe zone.

**Bug reports** go through the issue templates. **Feedback and edge cases**
(multi-speaker talks, pause-heavy lectures, non-English rates) belong here
as discussions.

Every report is read. Solo maintainer: replies may take a few days.

If this project saves you time, consider sponsoring:
<https://github.com/sponsors/levosilimo>
EOF
)"
gh api graphql -f query='mutation($rid:ID!,$cid:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$rid,categoryId:$cid,title:$t,body:$b}){discussion{url}}}' \
  -F rid="$REPO_ID" -F cid="$CATEGORY_ID" -F t="Welcome to Speed Watcher" -F b="$WELCOME_BODY" \
  --jq '.data.createDiscussion.discussion.url'
