// Visual placement pin: golden screenshots of the PILL'S OWN bounding box
// (+20px margin), cropped out of the fixture player — one golden per theme.
// The shot freezes every nondeterminism the pill could render:
// prefers-color-scheme is emulated before navigation so the pill is born in
// the theme under test, the clock is pinned (Date.now is part of the pill's
// live/saved line inputs even though a paused fixture video renders none),
// and reducedMotion is emulated so the environment cannot vary transition
// behavior. The pill's 200ms mode transition is waited out (transform back
// to none) before the shutter, mirroring settlePill in the main suite.
//
// The golden is the COARSE visual pin: maxDiffPixelRatio 0.02 absorbs the
// antialiasing noise but cannot catch a 1-2px inset drift (a 420px-wide
// pill moved by 2px shifts ~0.3% of the crop). The EXACT insets are pinned
// by the control-zone geometry lane (e2e.spec.ts assertControlZone: the
// right >= 12px and bottom >= 40px bounding-box checks, plus containment
// and occlusion), which measures layout numbers, not pixels. This spec
// proves the pill still LOOKS right (colors, shape, spacing) within its
// region; the geometry lane proves it sits exactly there.
//
// The golden's premise is shared with the other lanes: the same Playwright
// chromium build (1.62.1 → CfT 151) on the same Linux/headless stack, with
// fontconfig resolving the pill's system-ui stack to DejaVu Sans on both
// this box and CI's ubuntu-latest.
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

/** The pill's bounding box inflated by a margin, clamped to the player box
 * (the screenshot clip must stay inside the page). The crop keeps the
 * golden focused on the pill — a background change in #player (the video
 * area, the controls bar) no longer trips the comparison. */
async function pillClip(margin = 20): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate((m) => {
    const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
    const player = document.querySelector<HTMLElement>('#player');
    const pill = host?.shadowRoot?.querySelector<HTMLElement>('.pill');
    if (host === null || player === null || pill === null || pill === undefined) {
      throw new Error('pill or player missing for the golden crop');
    }
    const r = pill.getBoundingClientRect();
    const p = player.getBoundingClientRect();
    const x = Math.max(p.left, r.left - m);
    const y = Math.max(p.top, r.top - m);
    const right = Math.min(p.right, r.right + m);
    const bottom = Math.min(p.bottom, r.bottom + m);
    return { x, y, width: right - x, height: bottom - y };
  }, margin);
}

test('placement pin: recommend pill in the player control zone (light)', async () => {
  await renderStablePill('light');
  await expect(page).toHaveScreenshot('pill-in-player-light.png', {
    clip: await pillClip(),
    maxDiffPixelRatio: 0.02,
  });
});

test('placement pin: recommend pill in the player control zone (dark)', async () => {
  await renderStablePill('dark');
  await expect(page).toHaveScreenshot('pill-in-player-dark.png', {
    clip: await pillClip(),
    maxDiffPixelRatio: 0.02,
  });
});
