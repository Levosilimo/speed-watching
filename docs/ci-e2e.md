# CI and E2E

Two safety nets guard the extension before it ever reaches a store:

- **`bun run ci`** — the local pipeline. Runs typecheck, lint, knip, the
  aislop gate, the vitest suite, and the production build, in order, with
  real exit codes (first failure stops the run).
- **GitHub Actions** — the same pipeline in CI plus a two-browser E2E suite
  (Playwright/Chromium + WebDriver/Firefox) against local fixtures.

## Layout

| Path | Purpose |
|---|---|
| `.github/workflows/ci.yml` | CI: `ci`, `e2e-chromium`, `e2e-chromium-cft`, `e2e-firefox` jobs |
| `.github/workflows/publish.yml` | Draft store-submission workflow (inert until secrets exist) |
| `scripts/run-ci.ts` | The `bun run ci` pipeline |
| `e2e/server.ts` | Local fixture server: stub watch page, caption JSON, PAC proxy |
| `e2e/shared/fixtures.ts` | Fixture metadata (caption-track kind, blocked captions) shared by server and specs |
| `e2e/shared/specs.ts` | Browser-agnostic E2E specs (fixture wpm math + pill behavior) |
| `e2e/chromium/e2e.spec.ts` | Playwright suite: SW reachability + shared specs + console hook |
| `e2e/chromium/offscreen.spec.ts` | CfT lane: offscreen document API + orchestrator error path |
| `e2e/firefox/run.ts` | selenium-webdriver runner for the shared specs |
| `playwright.config.chromium.ts` | Playwright config (webServer, chromium channel, ignores offscreen.spec.ts) |
| `playwright.config.chromium.cft.ts` | CfT lane config (same webServer, offscreen.spec.ts only) |

## The `ci` job

ubuntu-latest, Node 22 (actions/setup-node) + bun 1.3.14 (oven-sh/setup-bun),
`bun install --frozen-lockfile`, then:

1. `bun run lint` — oxlint. No `--type-aware` and no SARIF output exist in
   oxlint 0.16 (checked `--help`; formats are checkstyle/default/github/
   gitlab/json/junit/stylish/unix). Deviation from lib-6's research, which
   assumed an oxlint-json-to-sarif path: oxlint stays plain; the aislop gate
   is the SARIF-based linter in this pipeline.
2. `bun run typecheck` — `tsc --noEmit`.
3. `bun run knip` — dead-code/dep check.
4. aislop gate — `bunx aislop scan . --format sarif | tee aislop.sarif |
   bun run scripts/aislop-gate.ts`, then `github/codeql-action/upload-sarif`
   (always, so findings are visible even when the gate fails).
5. `bun run test` — vitest, unit only.
6. `bun run build` — production chrome-mv3 build (dead-code-eliminates
   the window test hooks; the SEC-2 CI step greps the output to prove it).
7. Manifest-version gate — `.output/chrome-mv3/manifest.json` version must
   equal `package.json` version (screenpipe pattern; both are `0.0.1`).
8. `bun run zip` + `actions/upload-artifact@v4` — the zip the publish
   workflow would upload.

`e2e-chromium` and `e2e-firefox` depend on `ci` and build their own browser
target with the e2e hooks toggle (`bun run build:e2e` /
`bun run build:firefox:e2e` — `wxt build --mode e2e`, which compiles
`__E2E__` to true so the window test hooks exist; production builds compile
it to false, per wxt.config.ts). The e2e build lands in
`.output/{browser}-mv3-e2e` (wxt suffixes unknown modes) and the specs load
that dir — the prod `.output/chrome-mv3` stays the artifact — the artifact download
path would save a few seconds but the firefox job needs its own build anyway,
and each job stays self-contained. `e2e-chromium-cft` mirrors
`e2e-chromium` (same build, `xvfb-run -a bun run e2e:cft`) — xvfb is
installed by `playwright install --with-deps` and is a harmless wrapper:
the offscreen spec defaults to headless (`E2E_CFT_HEADED=1` opts into
headed, e.g. for debugging).

## E2E architecture

Both suites drive the **built** extension (`.output/chrome-mv3-e2e` and
`.output/firefox-mv3-e2e`, the e2e-mode builds that keep the window test
hooks — the prod dirs stay hook-free, proven by the SEC-2 CI grep) — no
dev server, no source maps. Both assert the same
things via `e2e/shared/specs.ts`:

- navigate to a fixture watch page at a `www.youtube.com` origin,
- wait for the content script's `speedwatcher:measure` window event,
- compare the reported word/cue/corrected wpm and `nWords` against values
  recomputed in the runner from the same `lib/wpm.ts` functions, within
  ±0.5 wpm,
- wait for the pill state test hook (`window.__speedwatcherPill` — the pill's
  shadow root is closed) and compare it against `lib/recommend.ts` over the
  same fixture; then assert Apply changes the fixture `<video>` playbackRate,
  Dismiss hides the pill, music/unreachable variants suppress Apply, and the
  WEB-blocked fixture (`synthetic/web-blocked.json`) makes the content script
  exercise the ANDROID innertube fallback (asserted per browser at the
  network layer: Playwright route counter / fixture-server POST counter).

No real YouTube traffic: the fixture server serves the stub page, the caption
JSON (the real `tests/fixtures/real/*.json` files), and — for Firefox — a PAC
file. Expected wpm comes from the fixture data, not from any network.

### Chromium (Playwright)

Persistent context with `channel: 'chromium'` (the bundled Playwright build —
Chrome/Edge dropped the side-load flags) and
`--disable-extensions-except`/`--load-extension` pointing at
`.output/chrome-mv3-e2e`. The service worker is reached via
`waitForEvent('serviceworker')` + `sw.evaluate()`. A context route
(`**://www.youtube.com/**`) fulfills the watch page and the caption fetch
(`/api/timedtext`) from the fixture server; both schemes are covered because
Chrome's HSTS preload can rewrite the http navigation to https.

Chromium-only assertions (product guard): service worker reachability, and
that the `console.info` measurement line equals the event payload's `line`
field. Playwright cannot do Firefox add-ons, so the shared specs run there
through WebDriver instead.

### Chromium CfT lane (offscreen)

Playwright ≥ 1.57 ships **Chrome for Testing** as its managed Chromium build
(verified 151.0.7922.34 on this box; `channel: 'chromium'` and `channel:
'chrome-for-testing'` resolve to the same binary, and `playwright install
chrome` installs nothing — it expects a system Chrome). CfT is real Chrome:
`chrome.offscreen` exists and `createDocument`/`getContexts`/`closeDocument`
work headless and headed — the phase-0 claim that Playwright builds strip
the offscreen API is stale. The lane (`e2e/chromium/offscreen.spec.ts`, run
via `bun run e2e:cft`) asserts: offscreen document creation with the built
extension (USER_MEDIA reason), document lifecycle through `getContexts`, and
the capture orchestrator's documented error path through the `storage.session`
mirror.

The full capture chain (getMediaStreamId → getUserMedia → level > 0) does
**not** run in this lane: `chrome.tabCapture.getMediaStreamId` only accepts
a target tab after the extension was invoked on it — the toolbar action
click IS that invocation — and Playwright has no browser-UI action-click
synthesis (`chrome.action` exposes no programmatic click), so the
extension is never invoked and the call rejects with the documented
"not been invoked" guidance error. The spec pins that pre-invocation state
plus the manifest contract that makes onClicked fire (action key, no
`default_popup`); the audio chain's pass/fail lives in the manual gate
(`docs/manual-gates-runbook.md`).

### Firefox (WebDriver + geckodriver)

`selenium-webdriver` talks to geckodriver (npm wrapper package; `GECKODRIVER_VERSION` pins the binary — 0.37.1 in CI — because the wrapper otherwise fetches "latest" at runtime) via `usingServer`. The addon is installed
with `driver.installAddon(.output/firefox-mv3-e2e, temporary = true)`. Firefox
runs headless (`-headless` — full browser, extensions included; no Xvfb).

geckodriver cannot intercept requests, so the fixture page reaches the
content script through a PAC proxy: `network.proxy.type=2` +
`network.proxy.autoconfig_url` pointing at the fixture server's `/proxy.pac`,
which proxies `www.youtube.com` to the local server and everything else
direct. Two prefs make this work:

- `network.stricttransportsecurity.preloadlist=false` — youtube.com is on
  the HSTS preload list; without this Firefox rewrites the fixture URL to
  https, and the plain fixture server cannot answer a TLS handshake.
- `browser_specific_settings.gecko.id` in the manifest (see below) — MV3
  add-ons need an id before geckodriver will install them.

### Firefox binary

The runner resolves, in order: `FIREFOX_BIN` env var, the newest Playwright
firefox build in `~/.cache/ms-playwright/firefox-*/`, then `firefox`/
`firefox-esr` on PATH.

Verified locally: **geckodriver 0.37.1 works with the Playwright-patched
Firefox build** (firefox-1538, Firefox 153) — the patched build still speaks
Marionette. The suite passes end-to-end with it.

- Local install: `bunx playwright install firefox` (~110 MB download, about
  400 MB on disk).
- CI: the `e2e-firefox` job installs the same Playwright-patched Firefox
  (`bunx playwright install --with-deps firefox`, its own cache key so the
  chromium jobs' shared cache entry cannot shadow it) and sets
  `GECKODRIVER_VERSION=0.37.1` so the wrapper cannot drift to a newer driver.

## gecko.id and MV3

`wxt.config.ts` now sets `browser_specific_settings.gecko.id:
'speed-watcher@levosilimo.dev'` and `manifestVersion: 3` (WXT defaults
Firefox to MV2; this project is MV3-only, so both browser targets build the
same manifest shape). Permissions are `[storage, tabCapture, offscreen]` on
both targets (`offscreen` added for the audio probe). The `world: 'MAIN'`
content script is emitted for Firefox too;
Firefox has no isolated worlds, so it runs in the content-script world, which
is what the E2E exercises.

## Publishing (draft, inert)

`.github/workflows/publish.yml` contains the two store jobs from the lib-6
research. They are written but cannot run until credentials exist — they
fail at the upload/sign step with the tools' own missing-auth errors, which
is the intended state. Triggers: a `v*` tag push, or `workflow_dispatch`
with `confirm: "publish"` (a stray manual run cannot publish anything). Each
job runs in its own GitHub environment (`cws` / `amo`) for per-store secret
scoping.

Secrets needed:

| Store | Secrets | Tool |
|---|---|---|
| Chrome Web Store | `EXTENSION_ID`, `PUBLISHER_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN` (OAuth2 desktop client, scope `chromewebstore`) | `chrome-webstore-upload-cli@4 upload --source ...` — v4 is draft-only (no `--auto-publish`); the launch gate is the dashboard submit |
| AMO | `WEB_EXT_API_KEY` (JWT issuer), `WEB_EXT_API_SECRET` | `web-ext@8 sign --channel listed --amo-metadata --source-code-zip .output/source.zip` (source archive = `git archive` of the release ref, per AMO source-submission policy) |

web-ext stays out of devDependencies (the addons-linter/image-size
vulnerability that removed it); the workflow pulls it via `npx` only at
publish time, pinned to `@8`.

## Local vs CI

| | Local | CI |
|---|---|---|
| Pipeline | `bun run ci` | `ci` job (same steps + SARIF upload + zip artifact) |
| Chromium E2E | `bun run e2e:chromium` (needs `bun run build:e2e` first — the spec fails with instructions otherwise) | `e2e-chromium` job (`playwright install --with-deps chromium`) |
| Chromium CfT E2E (offscreen) | `bun run e2e:cft` (needs `bun run build:e2e` — offscreen.spec.ts loads `.output/chrome-mv3-e2e`) | `e2e-chromium-cft` job (`xvfb-run -a bun run e2e:cft`) |
| Firefox E2E | `bun run e2e:firefox` (needs `bun run build:firefox:e2e` + a Firefox binary) | `e2e-firefox` job (Playwright-patched Firefox, geckodriver pinned) |
| Both | `bun run e2e` | — |

`bun run e2e:chromium` starts the fixture server itself via Playwright's
`webServer` (port 4319); the firefox runner starts it on a random port.

## Known limitations

- **Offscreen documents: E2E-covered on the CfT lane, but the audio chain
  itself is gated.** `e2e/chromium/offscreen.spec.ts` (headless, CI job
  `e2e-chromium-cft`) asserts offscreen create/lifecycle and the
  orchestrator's documented error path. The full tabCapture → getUserMedia
  chain is blocked at `getMediaStreamId`: the target tab is never invoked
  (the toolbar click cannot be synthesized from Playwright — see the CfT
  lane section above) and is covered by the manual gate in
  `docs/manual-gates-runbook.md` and the vitest suite.
- **The stub page is not YouTube.** It mimics the watch page structure (a
  `div#movie_player` wrapping a `<video>`, `ytInitialPlayerResponse`,
  `yt-navigate-finish`) so the content script's real code path runs; it does
  not exercise the real player's DOM. The pill specs run against the same
  stub (the pill host mounts inside the stub's `#movie_player` div, which
  mirrors real YouTube's shape). The ANDROID innertube fallback is exercised
  via the WEB-blocked fixture; the android-success path needs real YouTube
  and stays covered by the residential re-run (docs/store-readiness.md).
- **Twitch/Coursera/Disney+** remain blocked for probing (429 /
  enrollment-gated / geo-redirect, from `docs/phase0-generic-probe.md`);
  E2E never touches them.
- **Playwright's patched Firefox + geckodriver** is verified at Firefox 153
  / geckodriver 0.37.1. If a version pair drifts (geckodriver stops talking
  to the patched build), point `FIREFOX_BIN` at a release Firefox:
  `curl -L https://download.mozilla.org/?product=firefox-latest&os=linux64&lang=en-US | tar -xj -C ~/.cache/firefox --strip-components=1`,
  then `FIREFOX_BIN=~/.cache/firefox/firefox bun run e2e:firefox`.
- **oxlint SARIF**: not available (see the `ci` job section).

## Remote

The repository has no GitHub remote yet. The workflows in `.github/` are
inert until the repo is pushed — `bun run ci` and the two e2e scripts are
the safety net in the meantime. Nothing in CI touches the network except
package/browser installs; the E2E suites never leave the machine.
