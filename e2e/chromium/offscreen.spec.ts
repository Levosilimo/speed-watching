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
// action-click synthesis. The invocation gesture is, however, synthesizable
// through the CDP `Extensions.triggerAction` command (browser-level session;
// the extension-side chrome.action.triggerExtensionAction() does not exist on
// CfT 151). It fires chrome.action.onClicked for the no-popup action and
// satisfies the tabCapture invocation requirement — the full capture chain
// runs to `capturing` in headless. The meter level needs real tab audio,
// which headless Chrome does not render (Chromium issue 40176215); the
// audio-path evidence lives in the puppeteer spike scripts/audio-invocation-
// probe (level 0.2832 on this box, headed under xvfb), and the level
// assertion here activates under E2E_CFT_HEADED=1.
//
// So the suite pins the honest split:
//   (a) the manifest contract that makes onClicked fire (action key, no
//       default_popup, permissions unchanged),
//   (b) the pre-invocation state: probe-start lands on the documented
//       guidance error, the mirror stays idle, the offscreen document is
//       still created,
//   (c) offscreen createDocument/lifecycle (unchanged),
//   (d) the invoked path: CDP triggerAction → onClicked → startFromAction →
//       getMediaStreamId → offscreen getUserMedia → `capturing` within 2 s on
//       the active tab (mirror-written), meter level > 0 in headed mode.
// The unit-level startFromAction path stays covered in
// tests/capture-orchestrator.test.ts.

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURE_PORT } from '../server';

const extensionPath = resolve('.output/chrome-mv3-e2e');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl = 'http://www.youtube.com/watch?v=e2e-fixture&fixture=real/manual-cue.json';
const toneUrl = `${fixtureBase}/tone.html`;

// 440 Hz oscillator at gain 0.4 — the audio-invocation spike's tone.
// window.__toneStarted lets the suite wait for the AudioContext to run.
const TONE_HTML = `<!doctype html><html><body><script>
const ctx = new AudioContext();
const osc = ctx.createOscillator();
const gain = ctx.createGain();
gain.gain.value = 0.4;
osc.frequency.value = 440;
osc.connect(gain).connect(ctx.destination);
osc.start();
window.__toneStarted = true;
</script></body></html>`;

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
    namespace tabs {
      function query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
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
    throw new Error(
      `built extension not found at ${extensionPath} — run \`bun run build:e2e\` first (the e2e build keeps the window test hooks)`,
    );
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
      // The tone tab's AudioContext must start without a click gesture.
      '--autoplay-policy=no-user-gesture-required',
      ...(process.env.E2E_CFT_HEADED === '1' ? ['--window-position=-9999,-9999'] : []),
    ],
  });
  // The tone page for the invocation test (same origin as the fixture
  // server; route-fulfilled so no network leaves the machine).
  await context.route(toneUrl, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: TONE_HTML }),
  );
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
  // action is not a permission; the set is exactly the shipped one
  // (contextMenus: the measure-link menu, Tier 4).
  expect(manifest.permissions).toEqual(['storage', 'tabCapture', 'offscreen', 'contextMenus']);
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

test('action invocation via CDP triggerAction: orchestrator reaches capturing within 2s on the active tab', async () => {
  // chrome.action.triggerExtensionAction() does not exist on CfT 151
  // (measured: hasTrigger false); the CDP Extensions.triggerAction command is
  // the browser-side equivalent of a toolbar click and satisfies the
  // tabCapture invocation requirement (spike evidence: audio-invocation-probe).
  // It fires onClicked for the window's ACTIVE tab, so the tone tab must be
  // in front at trigger time.
  const tone = await context.newPage();
  await tone.goto(toneUrl);
  await tone.waitForFunction(() => (window as unknown as { __toneStarted?: boolean }).__toneStarted === true);
  await tone.bringToFront();

  const cdp = await context.browser()!.newBrowserCDPSession();
  const tabTargets: Array<{ type: string; targetId: string; url: string }> = [];
  cdp.on('Target.attachedToTarget', (ev: { targetInfo: { type: string; targetId: string; url?: string } }) => {
    tabTargets.push({
      type: ev.targetInfo.type,
      targetId: ev.targetInfo.targetId,
      url: ev.targetInfo.url ?? '',
    });
  });
  // Tab targets sit above page targets and are not listed by a plain
  // Target.getTargets; auto-attach (as Puppeteer does) surfaces them.
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'tab', exclude: false }],
  });
  await tone.waitForTimeout(500);
  const toneTab = tabTargets.find((t) => t.type === 'tab' && t.url.includes('tone.html'));
  expect(toneTab, 'tone tab target discovered').toBeDefined();
  // The captured tab is the window's ACTIVE tab (invocation semantics; the
  // mirror records which tab got captured). chrome.tabs.query does not
  // expose urls without the tabs permission, so pin identity via the active
  // tab id captured right before the trigger.
  expect(await tone.evaluate(() => document.visibilityState)).toBe('visible');
  const activeTabId = await serviceWorker.evaluate(async () => {
    const [active] = await chrome.tabs.query({ active: true });
    return active?.id ?? null;
  });
  const extensionId = new URL(serviceWorker.url()).host;
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: toneTab!.targetId });

  // Orchestrator must reach `capturing` fast (spike: first poll already
  // capturing); the 2s bound is the runbook expectation.
  const startedAt = Date.now();
  const snap = await optionsPage.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const s = (await chrome.runtime.sendMessage({ kind: 'probe-state' })) as {
        state: string;
        level: number;
        error?: string;
      };
      if (s.state === 'capturing' || s.state === 'error') return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  const elapsedMs = Date.now() - startedAt;
  expect(snap).not.toBeNull();
  expect(snap!.state).toBe('capturing');
  expect(snap!.error).toBeUndefined();
  expect(elapsedMs).toBeLessThan(2000);

  const mirror = await serviceWorker.evaluate(async () => {
    const items = (await chrome.storage.session.get('probeCapture')) as {
      probeCapture?: { state: string; tabId: number };
    };
    return items.probeCapture ?? null;
  });
  expect(mirror?.tabId).toBe(activeTabId);

  // The meter: real tab audio only flows headed (headless Chrome renders no
  // audio, Chromium issue 40176215; the spike measured level 0.2832 headed
  // on this box). Assert the audio path under E2E_CFT_HEADED=1, pin the
  // headless zero otherwise.
  if (process.env.E2E_CFT_HEADED === '1') {
    const level = await optionsPage.evaluate(async () => {
      let max = 0;
      for (let i = 0; i < 40; i++) {
        const s = (await chrome.runtime.sendMessage({ kind: 'probe-state' })) as { level: number };
        if (typeof s.level === 'number') max = Math.max(max, s.level);
        if (max > 0.01) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      return max;
    });
    expect(level).toBeGreaterThan(0.01);
  } else {
    const level = (await optionsPage.evaluate(() =>
      chrome.runtime.sendMessage({ kind: 'probe-state' }),
    )) as { level: number };
    expect(level.level).toBe(0);
  }

  await optionsPage.evaluate(() => chrome.runtime.sendMessage({ kind: 'probe-stop' }));
});
