// Visual placement pin: golden screenshots of #player (the fixture player
// box) with the recommend pill anchored in its control zone, one golden per
// theme. The shot freezes every nondeterminism the pill could render:
// prefers-color-scheme is emulated before navigation so the pill is born in
// the theme under test, the clock is pinned (Date.now is part of the pill's
// live/saved line inputs even though a paused fixture video renders none),
// and reducedMotion is emulated so the environment cannot vary transition
// behavior. The pill's 200ms mode transition is waited out (transform back
// to none) before the shutter, mirroring settlePill in the main suite.
//
// The golden's premise is shared with the other lanes: the same Playwright
// chromium build (1.62.1 → CfT 151) on the same Linux/headless stack, with
// fontconfig resolving the pill's system-ui stack to DejaVu Sans on both
// this box and CI's ubuntu-latest. maxDiffPixelRatio 0.02 absorbs the
// antialiasing noise while still pinning the placement (a misanchored pill
// moves tens of thousands of pixels).
//
// The firefox/userscript lanes get their own basenames in a later wave —
// this wave pins the chromium pair only.

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURE_PORT } from '../server';

const extensionPath = resolve('.output/chrome-mv3-e2e');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl =
  'http://www.youtube.com/watch?v=e2e-fixture&fixture=real/manual-cue.json';

let context: BrowserContext;
let page: Page;

test.beforeAll(async () => {
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `built extension not found at ${extensionPath} — run \`bun run build:e2e\` first (the e2e build keeps the window test hooks)`,
    );
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-placement-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  // Same youtube-origin fixture interception as the main suite: the watch
  // page and the caption fetch are fulfilled from the local fixture server.
  await context.route('**://www.youtube.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/timedtext') {
      const fixture = url.searchParams.get('fixture');
      const response = await fetch(`${fixtureBase}/api/timedtext?fixture=${fixture}`);
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      });
      return;
    }
    if (request.resourceType() !== 'document') {
      await route.abort();
      return;
    }
    const fixture = url.searchParams.get('fixture');
    const response = await fetch(`${fixtureBase}/watch?fixture=${fixture}`);
    await route.fulfill({
      status: response.status,
      contentType: 'text/html',
      body: await response.text(),
    });
  });
  page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
  await context?.close();
});

/** Emulate the theme + freeze the clock, navigate, and wait for the pill's
 * mode transition to settle (transform back to none, 200ms). */
async function renderStablePill(colorScheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date('2026-01-01T00:00:00Z'));
  await page.goto(watchUrl);
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state?.mode === 'recommend',
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () => {
      const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
      const pill = host?.shadowRoot?.querySelector<HTMLElement>('.pill');
      return pill !== null && pill !== undefined && getComputedStyle(pill).transform === 'none';
    },
    undefined,
    { timeout: 15_000 },
  );
}

test('placement pin: recommend pill in the player control zone (light)', async () => {
  await renderStablePill('light');
  await expect(page.locator('#player')).toHaveScreenshot('pill-in-player-light.png', {
    maxDiffPixelRatio: 0.02,
  });
});

test('placement pin: recommend pill in the player control zone (dark)', async () => {
  await renderStablePill('dark');
  await expect(page.locator('#player')).toHaveScreenshot('pill-in-player-dark.png', {
    maxDiffPixelRatio: 0.02,
  });
});
