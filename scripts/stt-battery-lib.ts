// Infrastructure for the Phase-0 STT battery (scripts/stt-battery.ts): shared
// paths, the local fixture origin (model/ort/transformers/clips), the
// in-browser transcription runner, and the Playwright driver. Mirrors the
// bench-whisper harness split; CLI + analysis live in stt-battery.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { chromium, type Browser as PWBrowser, type BrowserContext as PWContext } from 'playwright';
import type { Segment } from '../lib/captions';
import { DIST_DIR, MODELS_DIR, ORT_DIR, ROOT, type WordTimestamp } from './bench-whisper-lib';

export const BATTERY_DIR = join(ROOT, 'scripts', 'data', 'stt-battery');
export const AUDIO_DIR = join(BATTERY_DIR, 'audio');
export const REFS_DIR = join(BATTERY_DIR, 'refs');
export const CLIPS_DIR = join(BATTERY_DIR, 'clips');
export const BATTERY_PORT = 8793;
export const BATTERY_BASE = `http://127.0.0.1:${BATTERY_PORT}`;

export const BATTERY_MODELS = ['Xenova/whisper-tiny.en', 'Xenova/whisper-base.en'] as const;
export type BatteryModel = (typeof BATTERY_MODELS)[number];

// Env filter so a battery step can be confined to one model (also the
// workaround for the measured hang when the second model runs in the same
// process — see verdicts.md G5 harness note).
export function batteryModels(): BatteryModel[] {
  const only = process.env.BATTERY_MODEL;
  return only === undefined ? [...BATTERY_MODELS] : BATTERY_MODELS.filter((m) => m === only);
}

// Phase-0 word-timed corpus, three content types; every clip is the first
// ~66 s of the video (the POT range cap; see stt-battery.ts fetchStep).
export const BATTERY_VIDEOS = [
  { id: 'iG9CE55wbtY', category: 'talk' },
  { id: 'Ks-_Mh1QhMc', category: 'talk' },
  { id: 'jGwO_UgTS7I', category: 'lecture' },
  { id: 'HtSuA80QTyo', category: 'lecture' },
  { id: 'WUvTyaaNkzM', category: 'explainer' },
] as const;

export const SEAM_VIDEO = 'jGwO_UgTS7I';

export interface ClipRef {
  videoId: string;
  category: string;
  window: { startSec: number; durSec: number };
  words: Segment[];
  cues: Segment[];
}

export function loadClipRef(videoId: string): ClipRef {
  return JSON.parse(readFileSync(join(REFS_DIR, `${videoId}.clip.json`), 'utf8')) as ClipRef;
}

// ---------------------------------------------------------------------------
// Local fixture origin.

const RUNNER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>stt battery</title></head>
<body>
<script type="module" src="/runner.js"></script>
</body></html>`;

// transformers.js v4's browser build imports ort by bare specifier; the
// fixture server rewrites them to the same-origin ort entry (see
// bench-whisper-page.ts for the same approach).
const ORT_ENTRY = '/ort/ort.webgpu.min.mjs';

function rewriteTransformerBundle(source: Buffer): Buffer {
  return Buffer.from(
    source
      .toString('utf8')
      .replaceAll('from"onnxruntime-common"', `from"${ORT_ENTRY}"`)
      .replaceAll('from"onnxruntime-web/webgpu"', `from"${ORT_ENTRY}"`),
  );
}

const RUNNER_SOURCE = `
import { env, pipeline } from '/vendor/transformers.web.min.js';

const q = new URLSearchParams(location.search);
const model = q.get('model');
const dtype = q.get('dtype') || 'q8';
const clipIds = (q.get('clips') || '').split(',').filter(Boolean);
const chunkLengthS = q.get('chunk') === null ? null : Number(q.get('chunk'));
const strideLengthS = q.get('stride') === null ? null : Number(q.get('stride'));
const forceFull = q.get('forceFull') === '1';
const tsMode = q.get('ts') || 'word';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = '/ort/';
env.backends.onnx.wasm.numThreads = 1;

async function loadClip(id) {
  const res = await fetch('/clips/' + id + '.f32');
  if (!res.ok) throw new Error('clip fetch ' + res.status);
  const buf = await res.arrayBuffer();
  return new Float32Array(buf);
}

const errs = [];
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  errs.push('unhandledrejection: ' + String(r && r.message ? r.message : r));
});
window.addEventListener('error', (ev) => errs.push('error: ' + ev.message));

async function main() {
  const t0 = performance.now();
  let transcriber = null;
  let loadError = null;
  try {
    transcriber = await pipeline('automatic-speech-recognition', model, { dtype, device: 'wasm' });
  } catch (e) {
    loadError = String(e && e.message ? e.message : e);
  }
  const clips = [];
  for (const id of clipIds) {
    const rec = { id, loadError, transcribeMs: null, rtf: null, words: null, chunks: [], clipError: null };
    if (transcriber) {
      try {
        const samples = await loadClip(id);
        const durationSec = samples.length / 16000;
        const tA = performance.now();
        const opts = { return_timestamps: tsMode };
        if (chunkLengthS !== null) opts.chunk_length_s = chunkLengthS;
        if (strideLengthS !== null) opts.stride_length_s = strideLengthS;
        if (forceFull) opts.force_full_sequences = true;
        const out = await transcriber(samples, opts);
        rec.transcribeMs = performance.now() - tA;
        rec.rtf = rec.transcribeMs / (durationSec * 1000);
        rec.words = (out.text || '').trim();
        if (Array.isArray(out.chunks)) {
          rec.chunks = out.chunks.map((c) => ({
            text: c.text,
            start: c.timestamp[0],
            end: c.timestamp[1],
          }));
        }
        rec.durationSec = durationSec;
      } catch (e) {
        rec.clipError = String(e && e.message ? e.message : e);
      }
    }
    clips.push(rec);
  }
  window.__swBattery = {
    state: 'done',
    loadMs: transcriber ? performance.now() - t0 : null,
    loadError,
    clips,
    errs,
  };
}

main().catch((e) => {
  window.__swBattery = { state: 'error', error: String(e && e.message ? e.message : e) };
});
`;

async function serveFile(rootDir: string, reqPath: string): Promise<{ body: Buffer; type: string } | null> {
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
  const url = new URL(req.url ?? '/', BATTERY_BASE);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(RUNNER_HTML);
    return;
  }
  if (url.pathname === '/runner.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(RUNNER_SOURCE);
    return;
  }
  if (url.pathname === '/vendor/transformers.web.min.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(rewriteTransformerBundle(await readFile(join(DIST_DIR, 'transformers.web.min.js'))));
    return;
  }
  for (const [prefix, dir] of STATIC_ROUTES) {
    if (!url.pathname.startsWith(prefix)) continue;
    const hit = await serveFile(dir, url.pathname.slice(prefix.length));
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
    server.listen(BATTERY_PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

// ---------------------------------------------------------------------------
// Playwright driver.

export interface RunnerClip {
  id: string;
  loadError: string | null;
  transcribeMs: number | null;
  rtf: number | null;
  words: string | null;
  chunks: WordTimestamp[];
  durationSec?: number;
  clipError: string | null;
}

export interface BatteryResult {
  state: string;
  error?: string;
  loadMs?: number | null;
  loadError?: string | null;
  clips?: RunnerClip[];
  errs?: string[];
}

export interface ChunkConfig {
  chunkLengthS: number | null;
  strideLengthS: number | null;
  forceFull: boolean;
  tsMode?: 'word' | 'true' | 'false';
}

export async function runInference(
  model: string,
  clipIds: string[],
  chunkConfig: ChunkConfig,
): Promise<BatteryResult> {
  const params = new URLSearchParams({ model, clips: clipIds.join(',') });
  if (chunkConfig.chunkLengthS !== null) params.set('chunk', String(chunkConfig.chunkLengthS));
  if (chunkConfig.strideLengthS !== null) params.set('stride', String(chunkConfig.strideLengthS));
  if (chunkConfig.forceFull) params.set('forceFull', '1');
  if (chunkConfig.tsMode !== undefined) params.set('ts', chunkConfig.tsMode);
  const url = `${BATTERY_BASE}/?${params.toString()}`;

  // Measured on this box: under load the browser can die during spawn and
  // playwright's launch then waits on the debug pipe forever. Fail fast so a
  // battery run reports a harness failure instead of hanging silently.
  const browser: PWBrowser = await Promise.race([
    chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('chromium launch exceeded 120s')), 120_000)),
  ]);
  try {
    const context: PWContext = await browser.newContext();
    try {
      await context.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(BATTERY_BASE)) {
          void route.continue();
        } else {
          void route.abort('blockedbyclient');
        }
      });
      const page = await context.newPage();
      if (process.env.BENCH_DEBUG) {
        page.on('console', (msg) => console.log('[page]', msg.type(), msg.text().slice(0, 300)));
        page.on('pageerror', (err) => console.log('[pageerr]', String(err).slice(0, 500)));
      }
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await Promise.race([
          page.waitForFunction(
            () => {
              const b = (window as unknown as { __swBattery?: { state: string } }).__swBattery;
              return b !== undefined && b.state !== 'running';
            },
            undefined,
            { timeout: 900_000 },
          ),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('inference exceeded 900s')), 900_000);
          }),
        ]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { state: 'timeout', error: msg };
      }
      return await page.evaluate(() => {
        const b = (window as unknown as { __swBattery: BatteryResult }).__swBattery;
        return b;
      });
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await Promise.race([
      browser.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
    ]);
  }
}
