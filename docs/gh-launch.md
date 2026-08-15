# GitHub Launch Runbook — Speed Watcher

Post-push setup, the release flow, and launch day, in order. Everything in
this repo that a Settings click or a workflow needs is either already
committed (rulesets script, Pages workflow, issue templates, social
preview) or pointed to here.

## 1. After the first push

```sh
git push -u origin main
gh auth login
./scripts/setup-rulesets.sh levosilimo/speed-watching
```

The rulesets script runs once — re-running it fails on the name conflict.
It creates the `main` ruleset (PR required, the five checks `ci`,
`e2e-chromium`, `e2e-chromium-cft`, `e2e-userscript`, `e2e-firefox`, zero
required reviews so self-merges work) and the `release tags` ruleset
(immutability only).

### Settings clicks (repo → Settings)

- **Pages** — Build and deployment → Source: **GitHub Actions**.
  `.github/workflows/pages.yml` publishes `site/` on every main push; the
  privacy policy must return 200 here before the CWS listing is submitted
  (CWS requires a privacy-policy URL).
- **Discussions** — enable. Pin a Welcome post: bugs go through the issue
  templates, feedback and edge cases (multi-speaker talks, pause-heavy
  lectures, non-English rates) go here, and every report is read — solo
  maintainer, replies may take a few days.
- **Topics** — add: `browser-extension chrome-extension firefox-addon
  userscript tampermonkey video-speed playback-speed wpm youtube captions
  mpv`.
- **Social preview** — upload `docs/social-preview.png` (1280×640) from a
  local clone of this repo.
- **Code security and analysis** — turn on secret scanning, push
  protection, and private vulnerability reporting.
- **Environments** — create `cws` and `amo`, each with a required
  reviewer (self). The publish workflow's jobs run in these environments;
  without the environments the jobs fail.

### Secrets

`publish.yml` reads seven secrets — five in the `cws` environment, two in
`amo`:

- `cws`: `EXTENSION_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`,
  `PUBLISHER_ID`
- `amo`: `WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET`

The OAuth client behind `CLIENT_ID`/`CLIENT_SECRET`/`REFRESH_TOKEN` must
be **published out of testing mode** in the Google Cloud Console before
the first `cws` job run — a testing-mode client rejects the upload.

## 2. Release flow (v0.0.3 example)

1. Add the `CHANGELOG.md` entry (what changed and why).
2. Bump `version` in `package.json` **and** the pinned zip name in
   `publish.yml` (`--source .output/speed-watcher-0.0.2-chrome.zip` →
   `-0.0.3-`). The zip glob matches every release's artifact, so the pin
   must move on every release.
3. Merge to main, then:
   ```sh
   git tag v0.0.3
   git push origin v0.0.3
   ```
4. The tag push runs `release.yml` (creates the GitHub Release with the
   userscript bundle) and `publish.yml` (CWS + AMO submission, gated by
   the environment approvals).
5. Verify:
   - `https://github.com/levosilimo/speed-watching/releases/latest` shows
     the new release.
   - The userscript download URL
     (`.../releases/latest/download/speed-watcher.user.js`) serves the
     bundle.
   - Both store jobs finished in Actions (or failed with a real upload
     error, not a missing-secrets one).

## 3. Launch day

1. Replace the README's commented badge placeholder with the CWS
   install-count badge once the listing is live.
2. Show HN per `docs/launch-notes.md` — Tue–Thu, 8–11 am ET, the title
   and first-comment anchor are drafted there, and every comment gets an
   answer for the first two hours. Reddit engagement lives in the same
   doc.
