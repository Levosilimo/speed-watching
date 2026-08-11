// Firefox E2E: selenium-webdriver + geckodriver (npm wrapper) against the
// `wxt build -b firefox` output. Runs the same shared specs as chromium.
//
// geckodriver has no request interception, so the fixture watch page reaches
// the content script through a PAC proxy served by e2e/server.ts that routes
// www.youtube.com to the local fixture server — the Firefox analogue of the
// Playwright route interception used on chromium.
//
// Firefox binary resolution (first hit wins):
//   1. FIREFOX_BIN env var
//   2. Playwright's firefox build in ~/.cache/ms-playwright/firefox-*
//      (patched build — works with geckodriver as of Firefox 153/geckodriver
//      0.37; see docs/ci-e2e.md if a version pair drifts apart)
//   3. firefox / firefox-esr on PATH
//
// Run: bun run e2e:firefox

import { homedir } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Builder } from 'selenium-webdriver';
import { Options as FirefoxOptions, Driver as FirefoxDriver } from 'selenium-webdriver/firefox';
import { start as startGeckodriver } from 'geckodriver';
import { createFixtureServer } from '../server';
import type { PillState } from '../../ui/pill';
import {
  runMeasurementSpecs,
  runPillSpecs,
  type CaptionSource,
  type E2EDriver,
  type Measurement,
} from '../shared/specs';

const GECKODRIVER_PORT = 4444;

function which(bin: string): string | undefined {
  const result = spawnSync('which', [bin], { stdio: 'ignore' });
  return result.status === 0 ? bin : undefined;
}

function findFirefox(): string {
  const env = process.env.FIREFOX_BIN;
  if (env !== undefined && existsSync(env)) return env;
  if (env !== undefined) {
    throw new Error(`FIREFOX_BIN points at a missing file: ${env}`);
  }
  const playwrightDir = join(homedir(), '.cache/ms-playwright');
  if (existsSync(playwrightDir)) {
    const newest = readdirSync(playwrightDir)
      .filter((name) => name.startsWith('firefox-'))
      .map((name) => join(playwrightDir, name, 'firefox', 'firefox'))
      .filter((path) => existsSync(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (newest) return newest;
  }
  const onPath = which('firefox') ?? which('firefox-esr');
  if (onPath) return onPath;
  throw new Error(
    'no Firefox binary found. Install one, then re-run:\n' +
      '  bunx playwright install firefox            # patched build, ~/.cache/ms-playwright\n' +
      '  # or the official build:\n' +
      '  mkdir -p ~/.cache/firefox && curl -L https://download.mozilla.org/?product=firefox-latest&os=linux64&lang=en-US | tar -xj -C ~/.cache/firefox --strip-components=1\n' +
      '  # then: FIREFOX_BIN=~/.cache/firefox/firefox bun run e2e:firefox\n' +
      '  # (CI uses the Mozilla APT repo instead; see .github/workflows/ci.yml)',
  );
}

async function main(): Promise<void> {
  const extensionPath = resolve('.output/firefox-mv3');
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `built firefox extension not found at ${extensionPath} — run \`bun run build:firefox\` first`,
    );
  }

  const server = await createFixtureServer(0);
  const binary = findFirefox();
  console.log(`firefox binary: ${binary}`);
  console.log(`fixture server: ${server.baseUrl}`);

  const geckodriver = await startGeckodriver({ port: GECKODRIVER_PORT });
  const options = new FirefoxOptions();
  options.setBinary(binary);
  options.addArguments('-headless');
  options.setPreference('network.proxy.type', 2);
  options.setPreference('network.proxy.autoconfig_url', `${server.baseUrl}/proxy.pac`);
  // youtube.com is on the HSTS preload list; without this pref Firefox
  // rewrites the http fixture URL to https, which the plain fixture server
  // cannot answer (the PAC proxy would receive a TLS handshake).
  options.setPreference('network.stricttransportsecurity.preloadlist', false);

  const driver = (await new Builder()
    .forBrowser('firefox')
    .usingServer(`http://127.0.0.1:${GECKODRIVER_PORT}`)
    .setFirefoxOptions(options)
    .build()) as FirefoxDriver;

  try {
    await driver.installAddon(extensionPath, true);
    const e2e: E2EDriver = {
      async navigateToWatch(fixture) {
        await driver.get(`http://www.youtube.com/watch?v=e2e-fixture&fixture=${fixture}`);
      },
      async readMeasurement() {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const value = await driver.executeScript('return window.__speedwatcherLastMeasure');
          if (value !== null && value !== undefined) return value as unknown as Measurement;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return undefined;
      },
      async readPillState() {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const value = await driver.executeScript(
            'return window.__speedwatcherPill ? window.__speedwatcherPill.state : null',
          );
          if (value !== null && value !== undefined) return value as unknown as PillState;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return null;
      },
      async applyPill() {
        await driver.executeScript('window.__speedwatcherPill && window.__speedwatcherPill.apply()');
      },
      async dismissPill() {
        await driver.executeScript('window.__speedwatcherPill && window.__speedwatcherPill.dismiss()');
      },
      async readPlaybackRate() {
        const value = await driver.executeScript(
          'return document.querySelector("video") ? document.querySelector("video").playbackRate : null',
        );
        return value as unknown as number | null;
      },
      async readCaptionSource() {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const value = await driver.executeScript(
            'return window.__speedwatcherCaptionSource',
          );
          if (value !== null && value !== undefined) return value as unknown as CaptionSource;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return null;
      },
    };
    await runMeasurementSpecs(e2e);
    await runPillSpecs(e2e);
    if (server.androidPosts() === 0) {
      // The web-blocked fixture must have sent the ANDROID innertube POST
      // (same-origin, so the PAC proxy delivers it to this server).
      throw new Error('firefox e2e: ANDROID innertube fallback never fired');
    }
    console.log('firefox e2e: all shared specs passed');
  } finally {
    await driver.quit().catch(() => undefined);
    geckodriver.kill();
    await server.close();
  }
}

await main();
