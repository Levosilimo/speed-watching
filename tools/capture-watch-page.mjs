#!/usr/bin/env node
// Capture a 1280×800 screenshot of the fixture watch page with the pill in
// recommend mode, for the README hero and the social-preview card.
//
// Reuses the e2e machinery: `bun run build:e2e` first (the e2e build keeps
// the window test hooks), then this script serves the fixture server and
// drives a headed chromium on the live X display, exactly like the chromium
// e2e spec — no real YouTube traffic leaves the machine.
//
// Usage: node tools/capture-watch-page.mjs

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const extensionPath = join(ROOT, '.output', 'chrome-mv3-e2e');
const OUT_PATH = join(ROOT, 'docs', 'watch-page.png');
const FIXTURE_PORT = 4319;
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
// manual-cue renders a plain recommend pill (→ 1.4x ≈ 254 wpm) at default
// settings; asr-word would render the pause-diluted warning instead.
const WATCH_URL = 'http://www.youtube.com/watch?v=e2e-fixture&fixture=real/manual-cue.json';

function startFixtureServer() {
  const server = spawn('bun', ['e2e/server.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('fixture server did not start on port ' + FIXTURE_PORT));
    }, 15_000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('fixture server on')) {
        clearTimeout(timer);
        resolve(server);
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited early (code ${code})`));
    });
  });
}

/** Serve youtube.com from the local fixture server, mirroring the chromium
 * e2e spec: no document request ever reaches the real YouTube. */
async function routeWatchRequests(context) {
  await context.waitForEvent('serviceworker', { timeout: 30_000 });
  await context.route('**://www.youtube.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // The content script's ANDROID innertube fallback: drop it.
    if (url.pathname === '/youtubei/v1/player') {
      await route.abort();
      return;
    }
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
    const response = await fetch(`${fixtureBase}/watch?fixture=${fixture ?? ''}`);
    await route.fulfill({
      status: response.status,
      contentType: 'text/html',
      body: await response.text(),
    });
  });
}

/** Wait for the recommend-mode pill and give its host a paintable layout.
 *
 * On the fixture page #movie_player is the <video> element itself (on real
 * YouTube it is a div wrapping the video), and Chromium computes no styles
 * for children of a <video> — a pill host inside it never paints. So the
 * page is restructured to mirror YouTube and the measure is re-run on the
 * new anchor. The host needs no styling: its shadow :host rule anchors it
 * fixed to the viewport's bottom-right, so the pill paints wherever the
 * player sits.
 */
async function remountPill(page) {
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state?.mode === 'recommend',
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate(() => {
    document.querySelector('.speedwatcher-pill-host')?.remove();
    const video = document.querySelector('video#movie_player');
    if (video !== null) {
      const player = document.createElement('div');
      player.id = 'movie_player';
      video.id = '';
      video.replaceWith(player);
      player.appendChild(video);
    }
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state?.mode === 'recommend',
    undefined,
    { timeout: 20_000 },
  );
}

async function main() {
  const server = await startFixtureServer();
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-capture-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    await routeWatchRequests(context);
    const page = context.pages()[0] ?? (await context.newPage());
    // Dark pill theme, matching the dark page styling below.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(WATCH_URL);
    await remountPill(page);

    // Present the stub page as a dark watch page: the video fills a centered
    // 16:9 player. The pill is viewport-anchored, so styling cannot move it.
    await page.addStyleTag({
      content: `
        body { background: #0f0f0f; margin: 0; }
        #player { max-width: 1024px; margin: 0 auto; padding: 80px 0; }
        #movie_player {
          width: 100%;
          aspect-ratio: 16 / 9;
          display: block;
          position: relative;
          background: #000;
        }
        #movie_player video { width: 100%; height: 100%; display: block; }
      `,
    });
    await page.waitForTimeout(300);

    await page.screenshot({
      path: OUT_PATH,
      type: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    });
    console.log(`screenshot saved to ${OUT_PATH}`);
  } finally {
    await context.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
