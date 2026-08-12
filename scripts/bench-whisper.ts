// Phase-2 gate benchmark: is client-side word-timestamped STT (transformers.js
// Whisper) realtime-feasible inside the extension's constraints?
//
// Measures per backend (WASM / WebGPU) and per CSP policy (production
// extension default vs wasm-unsafe-eval relaxed): model load, first-chunk
// latency, RTF, JS heap peak, WER + word-timestamp sanity on 3 real
// LibriSpeech clips (49.2 s total, CC BY 4.0 — see bench-whisper-lib.ts).
//
// The model is served from a LOCAL HTTP server (no CDN during timed runs —
// enforced by allowRemoteModels=false plus Playwright route blocking of
// everything outside the fixture origin). Downloads happen once at dev time:
//   bun run scripts/bench-whisper.ts --download
//
// Process model (hang-hardening): each (backend × csp × gpu) variant runs in
// its OWN child process — one browser launch, one fixture server, one page.
// The orchestrator (this file, no --variant) spawns children sequentially,
// relays their output, and SIGKILLs the whole process group when a variant
// exceeds its hard timeout. Each child appends its records to the JSONL
// before exiting, so a killed variant never loses the variants before it,
// and no in-process browser state can leak across variants. The page also
// reports phase telemetry to the fixture server, so a hung variant leaves
// the last phase it reached in scripts/data/whisper-bench/telemetry.jsonl.
//
//   bun run scripts/bench-whisper.ts --backend=wasm --csp=all --gpu=none --out=results.jsonl
//   bun run scripts/bench-whisper.ts --variant=wasm:prod:none --out=results.jsonl  # one combo, own process
//
// Flags: --backend=wasm|webgpu|all (default all), --csp=prod|relaxed|prod-workers|all
// (default prod), --gpu=none|hardware|swiftshader|all (webgpu only, default all),
// --clip=N (default all 3), --headed, --smoke, --download.
//
// Exit 0 even when backends fail under strict CSP — failures are the measured
// data. Exit 1 only on harness errors (server/browser/download).
//
// NOT part of the vitest suite (drives a real browser).

import { existsSync } from 'node:fs';
import { mkdir, stat, writeFile, appendFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  CLIPS,
  CLIPS_DIR,
  CSP_POLICIES,
  MODEL_FILES,
  MODEL_ID,
  MODELS_DIR,
  ROOT,
  TELEMETRY_PATH,
  type Backend,
  type CspMode,
} from './bench-whisper-lib';
import { type ClipRecord, type Combo, type ProbeRecord, runCombo, startServer } from './bench-whisper-page';

const HF_MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const ROWS_API = (offset: number) =>
  `https://datasets-server.huggingface.co/rows?dataset=openslr/librispeech_asr&config=all&split=test.clean&offset=${offset}&length=100`;

// Hard per-variant caps. WASM variants measure ~1-2 min on this box; the cap
// is generous. WebGPU is an attempt only: the GTX 1070 is saturated by another
// workload, so a wedged GPU path must not hold the WASM results hostage.
const WASM_VARIANT_TIMEOUT_MS = 20 * 60_000;
const WEBGPU_VARIANT_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Download-once step. Clips come from the datasets-server rows API (signed
// media URLs); the model from the HF resolve endpoint. Requires network; the
// timed benchmark runs never do.

interface RowsApiRow {
  id: string;
  text: string;
  audio: Array<{ src: string }>;
}

async function downloadModel(): Promise<void> {
  const modelDir = join(MODELS_DIR, MODEL_ID);
  await mkdir(join(modelDir, 'onnx'), { recursive: true });
  for (const file of MODEL_FILES) {
    const target = join(modelDir, file);
    if (existsSync(target)) continue;
    const url = `${HF_MODEL_BASE}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model download failed ${file}: ${res.status}`);
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
    console.log(`[download] ${file} (${(await stat(target)).size} bytes)`);
  }
}

async function findClipAudio(id: string): Promise<string> {
  for (let offset = 0; offset < 2000; offset += 100) {
    const res = await fetch(ROWS_API(offset));
    if (!res.ok) throw new Error(`rows api ${res.status}`);
    const page = (await res.json()) as { rows: Array<{ row: RowsApiRow }> };
    const hit = page.rows.find((r) => r.row.id === id);
    const src = hit?.row.audio[0]?.src;
    if (src) return src;
    if (page.rows.length === 0) break;
  }
  throw new Error(`clip ${id} not found in test.clean`);
}

async function downloadClips(): Promise<void> {
  await mkdir(CLIPS_DIR, { recursive: true });
  for (const clip of CLIPS) {
    const target = join(CLIPS_DIR, `${clip.id}.f32`);
    if (existsSync(target)) continue;
    const src = await findClipAudio(clip.id);
    const audio = await fetch(src);
    if (!audio.ok) throw new Error(`audio download failed ${clip.id}: ${audio.status}`);
    const flac = join('/tmp', `${clip.id}.flac`);
    await writeFile(flac, Buffer.from(await audio.arrayBuffer()));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', flac, '-ar', '16000', '-ac', '1', '-f', 'f32le', target]);
    console.log(`[download] clip ${clip.id} (${clip.seconds}s)`);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator / single-variant child.

interface Options {
  variants: Combo[];
  clipIdx: number[];
  clipArgSet: boolean;
  headed: boolean;
  smoke: boolean;
  out: string;
  download: boolean;
}

const GPU_ATTEMPTS = ['none', 'hardware', 'swiftshader'] as const;

function parseVariant(spec: string): Combo {
  const [backend, csp, gpu] = spec.split(':');
  const validBackend = backend === 'wasm' || backend === 'webgpu';
  const validCsp = csp !== undefined && csp in CSP_POLICIES;
  const validGpu = (GPU_ATTEMPTS as readonly string[]).includes(gpu ?? '');
  if (!validBackend || !validCsp || !validGpu) {
    throw new Error(
      `bad --variant=${spec}; expected backend:csp:gpu where backend=wasm|webgpu, ` +
        `csp=${Object.keys(CSP_POLICIES).join('|')}, gpu=${GPU_ATTEMPTS.join('|')}`,
    );
  }
  return { backend: backend as Backend, csp: csp as CspMode, gpuAttempt: gpu as Combo['gpuAttempt'] };
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const val = (name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit?.split('=').slice(1).join('=');
  };
  const has = (name: string) => args.includes(`--${name}`);
  const variantArgs = args.filter((a) => a.startsWith('--variant=')).map((a) => a.split('=').slice(1).join('='));
  const variants = variantArgs.map(parseVariant);
  const clipArg = val('clip');
  return {
    variants,
    clipIdx: clipArg === undefined ? CLIPS.map((_, i) => i) : [Number(clipArg)],
    clipArgSet: clipArg !== undefined,
    headed: has('headed'),
    smoke: has('smoke'),
    out: val('out') ?? join(ROOT, 'scripts', 'data', 'whisper-bench', `results-${Date.now()}.jsonl`),
    download: has('download'),
  };
}

function buildVariantList(opts: Options): Combo[] {
  if (opts.variants.length > 0) return opts.variants;
  const args = process.argv.slice(2);
  const backendArg = args.find((a) => a.startsWith('--backend='))?.split('=').slice(1).join('=') ?? 'all';
  const cspArg = args.find((a) => a.startsWith('--csp='))?.split('=').slice(1).join('=') ?? 'prod';
  const gpuArg = args.find((a) => a.startsWith('--gpu='))?.split('=').slice(1).join('=') ?? 'all';
  const backends: Backend[] = backendArg === 'all' ? ['wasm', 'webgpu'] : ([backendArg] as Backend[]);
  const csps: CspMode[] = cspArg === 'all' ? (Object.keys(CSP_POLICIES) as CspMode[]) : ([cspArg] as CspMode[]);
  const gpus: Combo['gpuAttempt'][] = gpuArg === 'all' ? ['none', 'hardware', 'swiftshader'] : ([gpuArg] as Combo['gpuAttempt'][]);
  const combos: Combo[] = [];
  for (const backend of backends) {
    for (const csp of csps) {
      // WASM never uses the GPU; WebGPU gets the requested adapter attempts.
      const attempts: Combo['gpuAttempt'][] = backend === 'wasm' ? ['none'] : gpus;
      for (const gpuAttempt of attempts) combos.push({ backend, csp, gpuAttempt });
    }
  }
  return combos;
}

function printSummary(records: Array<ProbeRecord | ClipRecord>): void {
  const combos = new Map<string, ProbeRecord>();
  for (const r of records) if (r.kind === 'probe') combos.set(`${r.backend}/${r.csp}/${r.gpuAttempt}`, r);
  console.log('\n[bench] summary');
  for (const [key, p] of combos) {
    const [backend, csp, gpu] = key.split('/');
    const clipRecs = records.filter(
      (r) => r.kind === 'clip' && r.backend === backend && r.csp === csp && r.gpuAttempt === gpu,
    ) as ClipRecord[];
    const rtfs = clipRecs.map((c) => c.rtf).filter((x): x is number => x !== null);
    const wers = clipRecs.map((c) => c.wer).filter((x): x is number => x !== null);
    const first = clipRecs.map((c) => c.firstTextMs).filter((x): x is number => x !== null);
    const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '-');
    console.log(
      `  ${backend}/${csp} (gpu:${gpu}) load=${p.modelLoadMs?.toFixed(0) ?? 'ERR'}ms` +
        ` loadErr=${p.loadError ? p.loadError.slice(0, 80) : '-'}` +
        ` rtf=${avg(rtfs)} firstText=${avg(first)}ms heapPeak=${p.heapPeakMB.toFixed(0)}MB` +
        ` wer=${avg(wers)} clips=${clipRecs.length}`,
    );
  }
}

async function readRecords(outPath: string): Promise<Array<ProbeRecord | ClipRecord>> {
  const raw = await readFile(outPath, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ProbeRecord | ClipRecord);
}

// Last telemetry phase the page of this variant reached (empty when none).
async function lastTelemetryPhase(v: Combo): Promise<string> {
  try {
    const raw = await readFile(TELEMETRY_PATH, 'utf8');
    const mine = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { b: string; c: string; g: string; p: string; m: string })
      .filter((l) => l.b === v.backend && l.c === v.csp && l.g === v.gpuAttempt);
    const last = mine[mine.length - 1];
    return last ? `${last.p}@${last.m}ms` : 'none';
  } catch {
    return 'none';
  }
}

function timeoutProbe(v: Combo, timeoutMs: number, phase: string): ProbeRecord {
  return {
    kind: 'probe',
    ts: new Date().toISOString(),
    backend: v.backend,
    csp: v.csp,
    gpuAttempt: v.gpuAttempt,
    wasmCompile: '',
    gpu: '',
    sab: false,
    crossOriginIsolated: false,
    modelLoadMs: null,
    loadError: `killed by orchestrator: variant exceeded ${timeoutMs}ms hard timeout`,
    blockedExternal: 0,
    heapPeakMB: 0,
    heapLimitMB: null,
    errors: [`orchestrator SIGKILL after ${timeoutMs}ms; last page phase: ${phase}`],
  };
}

// One variant in its own process: own fixture server, own browser, append
// records, then exit hard so no browser handle can outlive the run.
async function runVariantChild(opts: Options): Promise<never> {
  if (opts.variants.length !== 1) {
    throw new Error('--variant mode requires exactly one variant per invocation');
  }
  const v = opts.variants[0]!;
  const server = await startServer();
  console.log(`[bench] run ${v.backend} csp=${v.csp} gpu=${v.gpuAttempt}`);
  let exitCode = 0;
  try {
    const { probes, clips } = await runCombo(v, opts.clipIdx, opts.headed, opts.smoke);
    const records = [...probes, ...clips];
    await appendFile(opts.out, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    printSummary(records);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[bench] harness error on ${v.backend}/${v.csp}/${v.gpuAttempt}: ${msg}`);
    const rec = timeoutProbe(v, 0, 'harness-error');
    rec.loadError = `harness error: ${msg}`;
    await appendFile(opts.out, JSON.stringify(rec) + '\n');
    exitCode = 1;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => process.stdout.write('\n[bench] variant complete\n', () => resolve()));
  process.exit(exitCode);
}

async function orchestrate(opts: Options): Promise<never> {
  const outPath = opts.out;
  await mkdir(dirname(outPath), { recursive: true });
  const combos = buildVariantList(opts);
  let exitCode = 0;

  for (const v of combos) {
    const timeoutMs = v.backend === 'wasm' ? WASM_VARIANT_TIMEOUT_MS : WEBGPU_VARIANT_TIMEOUT_MS;
    console.log(`\n[bench] variant ${v.backend} csp=${v.csp} gpu=${v.gpuAttempt} (cap ${timeoutMs / 1000}s)`);
    const childArgs = [
      'run',
      'scripts/bench-whisper.ts',
      `--variant=${v.backend}:${v.csp}:${v.gpuAttempt}`,
      `--out=${outPath}`,
      ...(opts.clipArgSet ? opts.clipIdx.map((i) => `--clip=${i}`) : []),
      ...(opts.headed ? ['--headed'] : []),
      ...(opts.smoke ? ['--smoke'] : []),
    ];
    // detached: child becomes its own process-group leader, so a timeout
    // SIGKILLs the browser with the child instead of orphaning it.
    const child = spawn('bun', childArgs, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => process.stdout.write(d));
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d));

    const outcome = await new Promise<'timeout' | number>((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        resolve('timeout');
      }, timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(-1);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    if (outcome === 'timeout') {
      const phase = await lastTelemetryPhase(v);
      await appendFile(outPath, JSON.stringify(timeoutProbe(v, timeoutMs, phase)) + '\n');
      console.log(`[bench] variant TIMED OUT after ${timeoutMs}ms (last page phase: ${phase}); synthetic probe appended`);
      exitCode = 1;
    } else if (outcome !== 0) {
      console.error(`[bench] variant exited ${outcome}`);
      exitCode = 1;
    }
    const count = (await readRecords(outPath)).length;
    console.log(`[bench] ${outPath} now holds ${count} records`);
  }

  const records = await readRecords(outPath);
  printSummary(records);
  console.log(`[bench] wrote ${records.length} records to ${outPath}`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (opts.download) {
    await downloadModel();
    await downloadClips();
    console.log('[download] done');
    return;
  }
  if (!existsSync(MODELS_DIR) || !existsSync(CLIPS_DIR)) {
    throw new Error('assets missing — run: bun run scripts/bench-whisper.ts --download');
  }
  if (opts.variants.length > 0) {
    await runVariantChild(opts);
  } else {
    await orchestrate(opts);
  }
}

await main();
