// Offscreen-document E2E on the CfT lane.
//
// Playwright 1.62.1's managed Chromium build IS Chrome for Testing 151
// (measured on this box: channel 'chromium' and 'chrome-for-testing' both
// resolve to 151.0.7922.34). It exposes chrome.offscreen — createDocument,
// getContexts and closeDocument all work, headless and headed — so the
// phase-0 "#26693: offscreen impossible in Playwright" claim is stale.
//
// The capture chain is gated on tabCapture invocation (lib-7 verdict, sourced
// to Chrome docs + sample.tabcapture-recorder): getMediaStreamId accepts a
// target tab only after the extension was invoked on it, and the action click
// IS that invocation. The manifest now declares `action` WITHOUT
// default_popup (a popup would consume the click and onClicked would never
// fire) and the background wires chrome.action.onClicked to the orchestrator
// (entrypoints/background.ts).
//
// This suite cannot click the toolbar: Playwright has no browser-UI
// action-click synthesis and chrome.action exposes no programmatic click
// (openPopup needs a user gesture and a popup). A fake invocation is not
// possible either — the invocation state is browser-side, tied to the real
// gesture. So the suite pins the honest split:
//   (a) the manifest contract that makes onClicked fire (action key, no
//       default_popup, permissions unchanged),
//   (b) the pre-invocation state: probe-start lands on the documented
//       guidance error, the mirror stays idle, the offscreen document is
//       still created,
//   (c) offscreen createDocument/lifecycle (unchanged).
// The invoked path (real click → streamId → getUserMedia → level) is unit-
// covered in tests/capture-orchestrator.test.ts (startFromAction) and needs
// a real click + real tab audio — gate 2 of docs/manual-gates-runbook.md.

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURE_PORT } from '../server';

const extensionPath = resolve('.output/chrome-mv3');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl = 'http://www.youtube.com/watch?v=e2e-fixture&fixture=real/manual-cue.json';

// Pinned orchestrator guidance: tabCapture rejected because no invocation
// gesture (action click) happened on the target tab.
const INVOCATION_GUIDANCE =
  'tabCapture not invoked: click the Speed Watcher toolbar icon on the video tab, then retry';

// The pinned @types/chrome (0.0.114) predates the promise-based MV3 APIs,
// chrome.offscreen, runtime.getContexts and storage.session — all present at
// runtime in CfT 151. Augment the ambient types so the evaluated calls
// typecheck; the runtime shape is verified by these very tests.
declare global {
  namespace chrome {
    namespace runtime {
      // Overloads for the exact messages this suite sends; everything else
      // stays loosely typed.
      function sendMessage(
        message: { kind: 'probe-start' } | { kind: 'probe-stop' },
      ): Promise<{ state: string; level: number; error?: string }>;
      function sendMessage(message: { kind: 'offscreen-wasm-check' }): Promise<{ received: boolean }>;
      function sendMessage(message: unknown): Promise<unknown>;
      function getContexts(filter: { contextTypes?: string[] }): Promise<unknown[]>;
    }
    namespace storage {
      namespace session {
        function get(key: string): Promise<Record<string, unknown>>;
      }
    }
    namespace offscreen {
      function createDocument(options: {
        url: string;
        reasons: string[];
        justification: string;
      }): Promise<void>;
      function closeDocument(): Promise<void>;
    }
  }
}

let context: BrowserContext;
let serviceWorker: Worker;
let optionsPage: Page;

test.beforeAll(async () => {
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(`built extension not found at ${extensionPath} — run \`bun run build\` first`);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-cft-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // The CfT-managed build: Playwright 1.57+ ships Chrome for Testing as its
    // default chromium; 1.62.1 resolves both channels to CfT 151.
    channel: 'chrome-for-testing',
    // Headless works for everything this suite asserts (measured). E2E_CFT_HEADED=1
    // opts into headed for debugging; the window is parked off-screen.
    headless: process.env.E2E_CFT_HEADED !== '1',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...(process.env.E2E_CFT_HEADED === '1' ? ['--window-position=-9999,-9999'] : []),
    ],
  });
  // Same youtube-origin fixture interception as the main suite: the watch
  // page and caption fetch are fulfilled from the local fixture server.
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
  serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${new URL(serviceWorker.url()).host}/options.html`);
  // The capture target: an active, capturable web tab. pickCaptureTab skips
  // the sender tab (the options page) and takes the active one.
  const watchPage = await context.newPage();
  await watchPage.goto(watchUrl);
  await watchPage.bringToFront();
});

test.afterAll(async () => {
  await context?.close();
});

test('chrome.offscreen.createDocument works (USER_MEDIA) and the document answers messages', async () => {
  const result = await serviceWorker.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('/offscreen.html'),
      reasons: ['USER_MEDIA'],
      justification: 'e2e: offscreen document probe',
    });
    // The ack proves main.ts attached its listener — the delivery contract
    // forwardToOffscreen depends on.
    const ack = await chrome.runtime.sendMessage({ kind: 'offscreen-wasm-check' });
    await chrome.offscreen.closeDocument();
    return ack;
  });
  expect(result).toEqual({ received: true });
});

test('offscreen document lifecycle: getContexts reflects create and close', async () => {
  const counts = await serviceWorker.evaluate(async () => {
    const count = async (): Promise<number> => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts.length;
    };
    const before = await count();
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('/offscreen.html'),
      reasons: ['USER_MEDIA'],
      justification: 'e2e: offscreen document lifecycle',
    });
    const during = await count();
    await chrome.offscreen.closeDocument();
    const after = await count();
    return { before, during, after };
  });
  expect(counts).toEqual({ before: 0, during: 1, after: 0 });
});

test('manifest exposes the action entrypoint (no popup) that makes onClicked fire', async () => {
  const manifest = await serviceWorker.evaluate(async () => {
    const m = await chrome.runtime.getManifest();
    return {
      action: m.action,
      permissions: m.permissions,
    };
  });
  // The action click is the tabCapture invocation gesture; a default_popup
  // would swallow the click and onClicked would never fire.
  expect(manifest.action?.default_title).toBe('Speed Watcher');
  expect(manifest.action?.default_popup).toBeUndefined();
  expect(manifest.action?.default_icon).toMatchObject({
    '16': 'icon/16.png',
    '32': 'icon/32.png',
    '48': 'icon/48.png',
    '128': 'icon/128.png',
  });
  // action is not a permission; the set stays exactly as before.
  expect(manifest.permissions).toEqual(['storage', 'tabCapture', 'offscreen']);
});

test('capture orchestrator: probe-start without invocation lands on the guidance error; mirror stays idle', async () => {
  // Without a toolbar click the invocation never happens (a runtime message
  // is not one of the four invocation gestures), so the options Test button
  // reaches the documented error path. The observable contract: guidance
  // error response, no mirror write, and the offscreen document still
  // created (ensureOffscreenDocument ran first).
  const start = await optionsPage.evaluate(() => chrome.runtime.sendMessage({ kind: 'probe-start' }));
  expect(start.state).toBe('error');
  expect(start.error).toBe(INVOCATION_GUIDANCE);

  const after = await serviceWorker.evaluate(async () => {
    const items = await chrome.storage.session.get('probeCapture');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return { mirror: items.probeCapture ?? null, offscreenContexts: contexts.length };
  });
  expect(after.mirror).toBeNull();
  expect(after.offscreenContexts).toBe(1);

  const stop = await optionsPage.evaluate(() => chrome.runtime.sendMessage({ kind: 'probe-stop' }));
  // probe-state responses carry the wasm field once a wasm-check has run (test 1
  // populates it); only the capture fields are pinned here.
  expect(stop.state).toBe('idle');
  expect(stop.level).toBe(0);
  const finalMirror = await serviceWorker.evaluate(async () => {
    const items = await chrome.storage.session.get('probeCapture');
    return items.probeCapture ?? null;
  });
  expect(finalMirror).toBeNull();
});
