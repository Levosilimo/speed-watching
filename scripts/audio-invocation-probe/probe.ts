// SPIKE probe: can the tabCapture audio chain be exercised with no human
// click, via Puppeteer's extension surface?
//
// Chain under test: page.triggerExtensionAction → chrome.action.onClicked →
// orchestrator.startFromAction → tabCapture.getMediaStreamId → offscreen
// getUserMedia(streamId) → AudioContext/AnalyserNode → level > 0.
//
// Run headed (tab capture is impossible in headless, Chromium issue
// 40176215), on a display with no physical speakers — the tone tab's WebAudio
// provides real tab audio:
//
//   xvfb-run -a bun run scripts/audio-invocation-probe/probe.ts
//
// Env:
//   PROBE_CHROME        chrome binary to use (default: newest Playwright CfT
//                       build under ~/.cache/ms-playwright)
//   PROBE_EXTENSION     built extension dir (default: .output/chrome-mv3)
//
// Exit code 0 only when every chain step passed; every step prints PASS/FAIL
// with the exact error text. No extension code is touched.
import puppeteer, { type Browser, type Extension, type Page, type WebWorker } from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createToneServer } from './server';

// Minimal shape of the extension APIs the evaluated callbacks touch. Runtime
// shape is verified by the probe itself.
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  storage: { session: { get(key: string): Promise<Record<string, unknown>> } };
  tabs: { query(info: unknown): Promise<Array<{ id?: number; audible?: boolean; url?: string }>> };
};

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

interface ProbeSnapshot {
  state: string;
  level: number;
  error?: string;
}

interface ProbeContext {
  browser: Browser;
  tone: Page;
  ext: Extension | null;
  opts: Page | null;
  sw: WebWorker | null;
}

interface PollSummary {
  snapshot: ProbeSnapshot;
  transitions: string[];
  sawStarting: boolean;
  sawCapturing: boolean;
  sawInvocationError: boolean;
  maxLevel: number;
}

const steps: Step[] = [];

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function asProbe(raw: unknown): ProbeSnapshot {
  const value = raw as Partial<ProbeSnapshot> | null;
  return {
    state: typeof value?.state === 'string' ? value.state : 'unknown',
    level: typeof value?.level === 'number' ? value.level : 0,
    error: typeof value?.error === 'string' ? value.error : undefined,
  };
}

// Newest Playwright CfT build wins; PROBE_CHROME overrides.
function resolveChrome(): string {
  const override = process.env.PROBE_CHROME;
  if (override) {
    if (!existsSync(override)) throw new Error(`PROBE_CHROME not found: ${override}`);
    return override;
  }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) throw new Error('no ~/.cache/ms-playwright; set PROBE_CHROME');
  const candidates: Array<{ bin: string; version: string }> = [];
  for (const dir of readdirSync(cache)) {
    if (!dir.startsWith('chromium-')) continue;
    const bin = join(cache, dir, 'chrome-linux64', 'chrome');
    if (!existsSync(bin)) continue;
    const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    candidates.push({ bin, version });
  }
  candidates.sort((a, b) => (a.version < b.version ? -1 : 1));
  const best = candidates.at(-1);
  if (!best) throw new Error('no chromium build found; set PROBE_CHROME');
  console.log(`chrome: ${best.version} (${best.bin})`);
  return best.bin;
}

async function readProbeState(opts: Page | null, sw: WebWorker | null): Promise<ProbeSnapshot> {
  if (opts) {
    try {
      return asProbe(await opts.evaluate(() => chrome.runtime.sendMessage({ kind: 'probe-state' })));
    } catch {
      // options page gone; fall through to the service worker
    }
  }
  if (sw) {
    return asProbe(await sw.evaluate(() => chrome.runtime.sendMessage({ kind: 'probe-state' })));
  }
  return { state: 'unreachable', level: 0, error: 'no probe-state channel' };
}

async function readAudibleTabs(sw: WebWorker | null): Promise<string> {
  if (!sw) return 'no service worker';
  const tabs = (await sw.evaluate(() => chrome.tabs.query({}) as Promise<unknown>)) as Array<{
    id?: number;
    audible?: boolean;
    url?: string;
  }>;
  return tabs
    .map((tab) => `${tab.id}:${tab.audible === true ? 'audible' : 'silent'} ${tab.url ?? ''}`)
    .join(' | ');
}

async function readMirror(opts: Page | null, sw: WebWorker | null): Promise<unknown> {
  if (opts) {
    try {
      const raw = (await opts.evaluate(() => chrome.storage.session.get('probeCapture'))) as Record<string, unknown>;
      return raw['probeCapture'] ?? null;
    } catch {
      // fall through to the service worker
    }
  }
  if (sw) {
    const raw = (await sw.evaluate(() => chrome.storage.session.get('probeCapture'))) as Record<string, unknown>;
    return raw['probeCapture'] ?? null;
  }
  return null;
}

function launchBrowser(chromeBin: string, extensionPath: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chromeBin,
    headless: false,
    enableExtensions: [extensionPath],
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
}

async function openToneTab(browser: Browser, baseUrl: string): Promise<Page> {
  const tone = await browser.newPage();
  await tone.goto(`${baseUrl}/tone`);
  await tone.bringToFront();
  return tone;
}

async function resolveExtensionContext(browser: Browser): Promise<{ ext: Extension | null; opts: Page | null; sw: WebWorker | null }> {
  const ext = (await browser.extensions()).values().next().value ?? null;
  let opts: Page | null = null;
  if (ext) {
    opts = await browser.newPage();
    try {
      await opts.goto(`chrome-extension://${ext.id}/options.html`, { waitUntil: 'load' });
    } catch {
      opts = null;
    }
  }
  let sw: WebWorker | null = null;
  for (const target of await browser.targets()) {
    if (target.type() === 'service_worker') {
      sw = await target.worker();
      if (sw) break;
    }
  }
  return { ext, opts, sw };
}

async function pollProbeState(ctx: ProbeContext, pollMs: number): Promise<PollSummary> {
  const deadline = Date.now() + pollMs;
  const summary: PollSummary = {
    snapshot: { state: 'idle', level: 0 },
    transitions: [],
    sawStarting: false,
    sawCapturing: false,
    sawInvocationError: false,
    maxLevel: 0,
  };
  let previous = '';
  while (Date.now() < deadline) {
    summary.snapshot = await readProbeState(ctx.opts, ctx.sw);
    if (summary.snapshot.state !== previous) {
      const error = summary.snapshot.error ? ` (${summary.snapshot.error})` : '';
      summary.transitions.push(`${previous || 'idle'} -> ${summary.snapshot.state}${error}`);
      previous = summary.snapshot.state;
    }
    if (summary.snapshot.state === 'starting') summary.sawStarting = true;
    if (summary.snapshot.state === 'capturing') summary.sawCapturing = true;
    if (summary.snapshot.error?.includes('not invoked') ?? false) summary.sawInvocationError = true;
    summary.maxLevel = Math.max(summary.maxLevel, summary.snapshot.level);
    if (summary.sawCapturing && summary.maxLevel > 0.01) break;
    await sleep(400);
  }
  return summary;
}

function recordChainOutcomes(ctx: ProbeContext, summary: PollSummary): void {
  const { snapshot, transitions, sawStarting, sawCapturing, sawInvocationError, maxLevel } = summary;
  record('probe-state-observed', true, `final state=${snapshot.state} level=${snapshot.level.toFixed(4)} transitions=[${transitions.join(' | ')}]`);

  const invoked = sawStarting || sawCapturing || (snapshot.state === 'error' && !sawInvocationError && snapshot.error !== undefined);
  const invokedDetail = sawInvocationError
    ? `getMediaStreamId rejected: "${snapshot.error}" — the action click did NOT invoke the extension`
    : snapshot.state === 'error'
      ? `getMediaStreamId path reached ${snapshot.state} without the invocation error (${snapshot.error ?? 'no message'})`
      : 'getMediaStreamId resolved (orchestrator past the invocation gate)';
  record('invocation-satisfied', invoked, invokedDetail);

  const captureDetail = sawCapturing
    ? 'offscreen getUserMedia + AudioContext started (started event delivered)'
    : `never reached 'capturing' (${snapshot.error ?? 'no error message'})`;
  record('offscreen-capture', sawCapturing, captureDetail);

  record('level-greater-than-zero', maxLevel > 0.01, `max observed AnalyserNode level=${maxLevel.toFixed(4)}`);
}

async function main(): Promise<void> {
  const extensionPath = resolve(process.env.PROBE_EXTENSION ?? '.output/chrome-mv3');
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    console.error(`built extension not found at ${extensionPath} — run \`bun run build\` first`);
    process.exitCode = 1;
    return;
  }
  if (!process.env.DISPLAY) {
    console.error('no DISPLAY — run headed under xvfb: xvfb-run -a bun run scripts/audio-invocation-probe/probe.ts');
    process.exitCode = 1;
    return;
  }

  const chromeBin = resolveChrome();
  const { baseUrl, close } = await createToneServer();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(chromeBin, extensionPath);
    record('launch', true, 'headed CfT with the extension loaded via enableExtensions');

    const tone = await openToneTab(browser, baseUrl);
    await sleep(2000);
    const toneRms = (await tone.evaluate(() => (window as unknown as { __toneRms?: number }).__toneRms)) ?? -1;
    record('tone-page-audio', toneRms > 0.01, `tone tab RMS=${toneRms.toFixed(4)} (WebAudio renders without an audio device: ${toneRms > 0.01 ? 'yes' : 'no'})`);

    const { ext, opts, sw } = await resolveExtensionContext(browser);
    record('extension-installed', ext !== null, ext ? `${ext.name} ${ext.version} id=${ext.id}` : 'no extensions visible via browser.extensions()');
    if (opts) {
      record('options-page', true, `chrome-extension://${ext?.id}/options.html loaded`);
    } else {
      record('options-page', false, 'options page unreachable; probe-state reads fall back to the service worker');
    }

    let triggerThrew: string | null = null;
    if (ext) {
      // Extensions.triggerAction simulates the toolbar click: onClicked
      // receives the window's ACTIVE tab, not the page passed to the call.
      // The tone tab must be the active one at trigger time.
      await tone.bringToFront();
      try {
        await tone.triggerExtensionAction(ext);
        record('triggerExtensionAction', true, `Extensions.triggerAction({id: ${ext.id}, targetId: tone tab}) sent without error`);
      } catch (error) {
        triggerThrew = String(error);
        record('triggerExtensionAction', false, triggerThrew);
      }
    } else {
      record('triggerExtensionAction', false, 'skipped: no extension handle');
    }

    const ctx: ProbeContext = { browser, tone, ext, opts, sw };
    const summary = await pollProbeState(ctx, triggerThrew ? 8_000 : 30_000);
    recordChainOutcomes(ctx, summary);

    const mirror = await readMirror(opts, sw);
    console.log(`mirror (chrome.storage.session probeCapture): ${JSON.stringify(mirror)}`);
    console.log(`tabs: ${await readAudibleTabs(sw)}`);
    process.exitCode = steps.every((step) => step.ok) ? 0 : 1;
  } catch (error) {
    record('probe-crash', false, String(error));
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await close();
  }
}

void main();
