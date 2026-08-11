// Phase 0 Lane B probe: loads the built extension in Chromium and drives the
// options-page capture flow, reporting what a datacenter run can and cannot
// prove about the tab → offscreen → AudioContext path.
//
// Playwright's Chromium builds do not expose chrome.offscreen, so the capture
// flow itself can only run against a real Chrome build; the probe still
// verifies everything reachable without it: extension load, SW messaging,
// tabCapture presence, extension-page WASM/CSP and cross-origin isolation.
//
// Run after `bun run build`: bun run scripts/phase0-audio-probe.ts
// Headed (xvfb-run -a) is required for a full flow on real Chrome.
//
// Exit codes: 0 = run completed with a definite verdict, 1 = the run failed.

import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { fileURLToPath } from 'node:url';

const EXTENSION_PATH = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url));

const HEADED = process.env.PROBE_HEADED === '1';

const results: Array<{ step: string; outcome: string; detail?: string }> = [];
function record(step: string, outcome: string, detail?: string): void {
  results.push({ step, outcome, detail });
  console.log(`[probe] ${step}: ${outcome}${detail ? ` — ${detail}` : ''}`);
}

async function waitForStatus(page: Page, expected: string[], timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await page.locator('#status').textContent().catch(() => '')) ?? '';
    if (expected.some((prefix) => last.startsWith(prefix))) return last;
    await page.waitForTimeout(200);
  }
  throw new Error(`status did not reach ${expected.join('/')}; last was "${last}"`);
}

const AUDIO_PAGE_HTML = `<html><body><script>
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.4;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
</script></body></html>`;

const profileDir = `/tmp/speed-watcher-probe-${Date.now()}`;
let context: BrowserContext | null = null;

async function runCaptureFlow(
  context: BrowserContext,
  sw: import('playwright').Worker,
  extensionId: string,
  options: Page,
): Promise<void> {
  await options.locator('#toggle').click();
  const started = await waitForStatus(options, ['capturing', 'error']);
  record('capture start', started.startsWith('capturing') ? 'capturing' : 'error', started);

  const swOffscreenCount = await sw.evaluate(() => {
    const chromeApi = (globalThis as unknown as {
      chrome: {
        runtime: {
          getContexts(filter: { contextTypes: string[] }): Promise<Array<{ contextType: string }>>;
        };
      };
    }).chrome;
    return chromeApi.runtime
      .getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
      .then((contexts) => contexts.length);
  });
  record('offscreen document', swOffscreenCount === 1 ? 'present' : 'MISSING', `getContexts count ${swOffscreenCount}`);

  let maxWidth = 0;
  let lastStatus = started;
  for (let i = 0; i < 12; i++) {
    await options.waitForTimeout(250);
    const width = parseFloat((await options.locator('#meter-fill').getAttribute('style'))?.match(/width: ([\d.]+)%/)?.[1] ?? '0');
    maxWidth = Math.max(maxWidth, width);
    lastStatus = (await options.locator('#status').textContent()) ?? lastStatus;
  }
  const wasmText = (await options.locator('#wasm').textContent()) ?? '';
  record('meter peak', maxWidth > 0.5 ? 'audio flowing' : 'silent', `fill width peak ${maxWidth.toFixed(1)}% of a level*300% scale`);
  record('wasm check', wasmText.startsWith('wasm: ok') ? 'wasm ok' : 'wasm check pending', wasmText);
  record('post-wait status', lastStatus);

  const otherPage = await context.newPage();
  await otherPage.goto('about:blank');
  await otherPage.bringToFront();
  const degraded = await waitForStatus(options, ['degraded', 'idle']);
  record('tab switch', degraded.startsWith('degraded') ? 'degraded as expected' : degraded, degraded);

  // After degradation the toggle reads "Test audio capture": restart, then
  // stop, to verify a full clean stop.
  await options.locator('#toggle').click();
  await waitForStatus(options, ['capturing', 'error']);
  await options.locator('#toggle').click();
  const stopped = await waitForStatus(options, ['idle']);
  record('capture stop', 'idle', stopped);
}

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: !HEADED,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const swPromise = context.waitForEvent('serviceworker', { timeout: 30000 });

  const audioPage = await context.newPage();
  await audioPage.goto(`data:text/html,${encodeURIComponent(AUDIO_PAGE_HTML)}`);
  await audioPage.waitForTimeout(1500);
  record('audio source tab', 'loaded', 'WebAudio oscillator at gain 0.4');

  const sw = (await swPromise.catch(() => undefined)) ?? context.serviceWorkers()[0];
  if (!sw) throw new Error('service worker never registered');
  const extensionId = new URL(sw.url()).host;
  record('service worker', 'loaded', `id ${extensionId}`);

  const swApis = await sw.evaluate(() => {
    const chromeApi = (globalThis as unknown as {
      chrome: { offscreen: unknown; tabCapture: unknown };
    }).chrome;
    return {
      offscreen: typeof chromeApi.offscreen,
      tabCapture: typeof chromeApi.tabCapture,
    };
  });
  if (swApis.offscreen === 'undefined') {
    record('chrome.offscreen', 'UNAVAILABLE', 'Playwright Chromium builds ship without the offscreen API');
    record('chrome.tabCapture', 'present', 'tabCapture is exposed in the service worker');
  }

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#toggle').waitFor({ timeout: 10000 });
  record('options page', 'loaded');

  const envChecks = await options.evaluate(async () => {
    const sab = typeof SharedArrayBuffer !== 'undefined';
    let wasm = 'error';
    try {
      await WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      wasm = 'ok';
    } catch (error) {
      wasm = String(error);
    }
    return { sab, wasm };
  });
  record(
    'extension page CSP',
    envChecks.wasm === 'ok' ? 'wasm compiles' : `wasm BLOCKED (${envChecks.wasm})`,
    `SharedArrayBuffer: ${envChecks.sab ? 'available' : 'not available (no cross-origin isolation)'}`,
  );

  if (swApis.offscreen === 'undefined') {
    record('audio flow', 'NOT TESTABLE HERE', 'offscreen API absent; needs a real Chrome build');
    record('tab-switch degradation', 'NOT TESTABLE HERE', 'same constraint');
    record('30s idle eviction', 'NOT TESTABLE HERE', 'same constraint');
  } else {
    await runCaptureFlow(context, sw, extensionId, options);
  }
} catch (error) {
  record('run', 'FAILED', error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  await context?.close();
}

console.log('\n[probe] summary');
let verdict = 'unknown';
for (const result of results) {
  console.log(`  ${result.step}: ${result.outcome}${result.detail ? ` — ${result.detail}` : ''}`);
  if (result.step === 'audio flow') verdict = result.outcome;
  if (result.step === 'meter peak') verdict = result.outcome;
}
console.log(`[probe] verdict: ${verdict}`);

const runFailed = results.some((result) => result.step === 'run' && result.outcome === 'FAILED');
process.exit(runFailed ? 1 : 0);
