// Page-side harness for the Phase-2 Whisper benchmark: the fixture origin
// (CSP policy under test), its local static server, and the Playwright driver
// that runs one backend/CSP combo and returns probe + clip records. CLI
// orchestration lives in bench-whisper.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { chromium, type Browser as PWBrowser, type BrowserContext as PWContext } from 'playwright';
import {
  BENCH_BASE,
  BENCH_PORT,
  CLIPS,
  CLIPS_DIR,
  CSP_POLICIES,
  DIST_DIR,
  MODELS_DIR,
  ORT_DIR,
  TELEMETRY_PATH,
  timestampSanity,
  wer,
  type Backend,
  type CspMode,
} from './bench-whisper-lib';
import { RUNNER_SOURCE } from './bench-whisper-runner';

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>whisper bench</title></head>
<body>
<script type="module" src="/runner.js"></script>
</body></html>`;

// transformers.js v4's browser build imports ort by bare specifier. The
// extension resolves these at bundle time (WXT/vite); the harness replicates
// that by rewriting the specifiers to the same-origin ort entry, since
// external import maps are ignored by Chromium and inline ones are blocked by
// script-src 'self'.
const ORT_ENTRY = '/ort/ort.webgpu.min.mjs';

function rewriteTransformerBundle(source: Buffer): Buffer {
  return Buffer.from(
    source
      .toString('utf8')
      .replaceAll('from"onnxruntime-common"', `from"${ORT_ENTRY}"`)
      .replaceAll('from"onnxruntime-web/webgpu"', `from"${ORT_ENTRY}"`),
  );
}

// ---------------------------------------------------------------------------
// Local static server: fixture page (with the policy under test), runner,
// transformers bundle, ort wasm, model files, clips. Same origin throughout,
// approximating extension:// where the model would be bundled.

async function serve(rootDir: string, reqPath: string): Promise<{ body: Buffer; type: string } | null> {
  const rel = decodeURIComponent(reqPath).replace(/^\/+/, '');
  const target = resolve(join(rootDir, rel));
  if (!target.startsWith(rootDir + sep)) return null;
  try {
    const body = await readFile(target);
    const ext = basename(target).split('.').pop() ?? '';
    const type =
      ext === 'js' || ext === 'mjs'
        ? 'text/javascript'
        : ext === 'wasm'
          ? 'application/wasm'
          : ext === 'json'
            ? 'application/json'
            : ext === 'html'
              ? 'text/html'
              : 'application/octet-stream';
    return { body, type };
  } catch {
    return null;
  }
}

const STATIC_ROUTES: Array<[string, string]> = [
  ['/vendor/', DIST_DIR],
  ['/ort/', ORT_DIR],
  ['/models/', MODELS_DIR],
  ['/clips/', CLIPS_DIR],
];

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', BENCH_BASE);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const csp = CSP_POLICIES[(url.searchParams.get('csp') ?? 'prod') as CspMode] ?? CSP_POLICIES.prod;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
    });
    res.end(FIXTURE_HTML);
    return;
  }
  if (url.pathname === '/runner.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(RUNNER_SOURCE);
    return;
  }
  // Page-phase telemetry: survives a hung page (fire-and-forget fetches), so
  // a killed variant still leaves the last phase it reached on disk.
  if (url.pathname === '/telemetry') {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      b: url.searchParams.get('b') ?? '',
      c: url.searchParams.get('c') ?? '',
      g: url.searchParams.get('g') ?? '',
      p: url.searchParams.get('p') ?? '',
      m: url.searchParams.get('m') ?? '',
      d: url.searchParams.get('d'),
    });
    await appendFile(TELEMETRY_PATH, line + '\n');
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/vendor/transformers.web.min.js') {
    const raw = await readFile(join(DIST_DIR, 'transformers.web.min.js'));
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(rewriteTransformerBundle(raw));
    return;
  }
  for (const [prefix, dir] of STATIC_ROUTES) {
    if (!url.pathname.startsWith(prefix)) continue;
    const hit = await serve(dir, url.pathname.slice(prefix.length));
    if (!hit) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': hit.type });
    res.end(hit.body);
    return;
  }
  res.writeHead(404);
  res.end('not found');
}

export function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      res.writeHead(500);
      res.end('server error');
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(BENCH_PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

// ---------------------------------------------------------------------------
// Playwright driver.

export interface Combo {
  backend: Backend;
  csp: CspMode;
  gpuAttempt: 'none' | 'hardware' | 'swiftshader';
}

export interface ClipRecord {
  kind: 'clip';
  ts: string;
  backend: Backend;
  csp: CspMode;
  gpuAttempt: Combo['gpuAttempt'];
  clipId: string;
  durationSec: number;
  modelLoadMs: number | null;
  loadError: string | null;
  firstTokenMs: number | null;
  firstTextMs: number | null;
  transcribeMs: number | null;
  rtf: number | null;
  heapPeakMB: number;
  heapLimitMB: number | null;
  wordTokens: number | null;
  tsFirstSec: number | null;
  tsLastSec: number | null;
  tsMonotonic: boolean | null;
  tsWithinDuration: boolean | null;
  wer: number | null;
  words: string | null;
  errors: string[];
}

export interface ProbeRecord {
  kind: 'probe';
  ts: string;
  backend: Backend;
  csp: CspMode;
  gpuAttempt: Combo['gpuAttempt'];
  wasmCompile: string;
  gpu: string;
  sab: boolean;
  crossOriginIsolated: boolean;
  modelLoadMs: number | null;
  loadError: string | null;
  blockedExternal: number;
  heapPeakMB: number;
  heapLimitMB: number | null;
  errors: string[];
}

interface BenchData {
  backend: string;
  wasmProbe: string;
  gpuProbe: string;
  sab: boolean;
  coi: boolean;
  loadMs: number | null;
  loadError: string | null;
  heapPeakMB: number;
  heapLimitMB: number | null;
  clips: Array<{
    id: string;
    modelLoadMs: number | null;
    loadError: string | null;
    firstTokenMs: number | null;
    firstTextMs: number | null;
    transcribeMs: number | null;
    rtf: number | null;
    words: string | null;
    chunks: Array<{ text: string; start: number; end: number }>;
    clipError: string | null;
  }>;
  errs: string[];
  totalMs: number;
}

interface ComboResult {
  result: { state: string; data: BenchData | null; error: string | null };
  consoleLines: string[];
  blockedExternal: number;
}

function launchArgs(combo: Combo): string[] {
  const args = ['--disable-dev-shm-usage'];
  if (combo.backend === 'webgpu') {
    args.push('--enable-unsafe-webgpu');
    if (combo.gpuAttempt === 'swiftshader') {
      args.push('--use-webgpu-adapter=swiftshader');
    } else if (combo.gpuAttempt === 'hardware') {
      // The first hardware attempt reported adapter:google|swiftshader — the
      // GPU process silently fell back to software rendering. These switches
      // pin it to the real Vulkan stack (ANGLE + Dawn backend), keep the
      // adapter off Chromium's blocklist, and grant the unsafe APIs without
      // which adapter.info is blanked and the probe cannot name the adapter.
      // The swiftshader variant deliberately gets none of them: it must stay
      // a pure software control.
      args.push(
        '--use-angle=vulkan',
        '--ignore-gpu-blocklist',
        '--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist',
        '--disable-dawn-features=disallow_unsafe_apis',
      );
    }
  }
  return args;
}

async function runPage(combo: Combo, url: string, headed: boolean, smoke: boolean): Promise<ComboResult> {
  const browser: PWBrowser = await chromium.launch({
    headless: !headed,
    args: launchArgs(combo),
  });
  try {
    const context: PWContext = await browser.newContext();
    try {
      let blockedExternal = 0;
      await context.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(BENCH_BASE)) {
          void route.continue();
        } else {
          blockedExternal += 1;
          void route.abort('blockedbyclient');
        }
      });
      const consoleLines: string[] = [];
      context.on('console', (msg) => {
        if (msg.type() === 'error') consoleLines.push(msg.text().slice(0, 300));
      });

      const page = await context.newPage();
      if (process.env.BENCH_DEBUG) {
        page.on('console', (msg) => console.log('[page]', msg.type(), msg.text().slice(0, 300)));
        page.on('pageerror', (err) => console.log('[pageerr]', String(err).slice(0, 500)));
        page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 150), r.failure()?.errorText));
      }
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // 15 min per combo: model load can take minutes on the contended GTX
      // 1070 box, and SwiftShader WebGPU is software-rendered. Playwright's
      // own timeout does not fire while the page main thread is blocked (a
      // long synchronous ort call starves its polling), so race it with a
      // node-side watchdog.
      const timeoutMs = smoke ? 120_000 : 900_000;
      try {
        await Promise.race([
          page.waitForFunction(
            () => {
              const b = (window as unknown as { __swBench?: { state: string } }).__swBench;
              return b !== undefined && b.state !== 'running';
            },
            undefined,
            { timeout: timeoutMs },
          ),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`combo exceeded ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } catch (e) {
        // A timed-out combo is measured data (backend too slow), not a
        // harness failure: surface it as a probe record.
        const msg = e instanceof Error ? e.message : String(e);
        return { result: { state: 'timeout', data: null, error: msg }, consoleLines, blockedExternal };
      }
      const result = await page.evaluate(() => {
        const b = (window as unknown as { __swBench: { state: string; data?: BenchData; error?: string } }).__swBench;
        return { state: b.state, data: b.data ?? null, error: b.error ?? null };
      });
      return { result, consoleLines, blockedExternal };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    // Best-effort bounded close: a wedged browser must not stall the variant
    // past its deadline (the orchestrator SIGKILLs the process group anyway).
    await Promise.race([
      browser.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
    ]);
  }
}

export async function runCombo(
  combo: Combo,
  clipIdx: number[],
  headed: boolean,
  smoke: boolean,
  dtype = 'q8',
): Promise<{ probes: ProbeRecord[]; clips: ClipRecord[] }> {
  const clips = clipIdx.map((i) => CLIPS[i]!);
  const clipIds = clips.map((c) => c.id);
  const url = `${BENCH_BASE}/?backend=${combo.backend}&csp=${combo.csp}&gpu=${combo.gpuAttempt}&dtype=${dtype}&clips=${clipIds.join(',')}`;

  const { result, consoleLines, blockedExternal } = await runPage(combo, url, headed, smoke);

  const ts = new Date().toISOString();
  if (result.state === 'error' || !result.data) {
    const err = result.error ?? 'runner state ' + result.state;
    const probe: ProbeRecord = {
      kind: 'probe',
      ts,
      backend: combo.backend,
      csp: combo.csp,
      gpuAttempt: combo.gpuAttempt,
      wasmCompile: '',
      gpu: '',
      sab: false,
      crossOriginIsolated: false,
      modelLoadMs: null,
      loadError: err,
      blockedExternal,
      heapPeakMB: 0,
      heapLimitMB: null,
      errors: [err, ...consoleLines],
    };
    return { probes: [probe], clips: [] };
  }

  const d = result.data;
  const probe: ProbeRecord = {
    kind: 'probe',
    ts,
    backend: combo.backend,
    csp: combo.csp,
    gpuAttempt: combo.gpuAttempt,
    wasmCompile: d.wasmProbe,
    gpu: d.gpuProbe,
    sab: d.sab,
    crossOriginIsolated: d.coi,
    modelLoadMs: d.loadMs,
    loadError: d.loadError,
    blockedExternal,
    heapPeakMB: d.heapPeakMB,
    heapLimitMB: d.heapLimitMB,
    errors: [...d.errs, ...consoleLines],
  };

  const clipRecords: ClipRecord[] = [];
  const clipById = new Map(clips.map((c) => [c.id, c]));
  for (const c of d.clips) {
    const clip = clipById.get(c.id)!;
    const hyp = c.words ?? '';
    const ref = clip.transcript;
    const sanity = timestampSanity(c.chunks, clip.seconds);
    clipRecords.push({
      kind: 'clip',
      ts,
      backend: combo.backend,
      csp: combo.csp,
      gpuAttempt: combo.gpuAttempt,
      clipId: c.id,
      durationSec: clip?.seconds ?? 0,
      modelLoadMs: c.modelLoadMs,
      loadError: c.loadError,
      firstTokenMs: c.firstTokenMs,
      firstTextMs: c.firstTextMs,
      transcribeMs: c.transcribeMs,
      rtf: c.rtf,
      heapPeakMB: d.heapPeakMB,
      heapLimitMB: d.heapLimitMB,
      wordTokens: c.chunks.length || null,
      tsFirstSec: c.chunks.length ? c.chunks[0]!.start : null,
      tsLastSec: c.chunks.length ? c.chunks[c.chunks.length - 1]!.end : null,
      tsMonotonic: c.chunks.length > 1 ? sanity.monotonic : null,
      tsWithinDuration: c.chunks.length ? sanity.withinDuration : null,
      wer: c.words === null ? null : wer(ref, hyp),
      words: c.words,
      errors: [...d.errs, ...(c.clipError ? [c.clipError] : [])],
    });
  }
  return { probes: [probe], clips: clipRecords };
}
