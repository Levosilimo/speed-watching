// Page-side benchmark runner, executed inside the fixture origin in
// Playwright's Chromium (not in Node). Served from /runner.js with the CSP
// policy under test; imports the transformers.js browser build and fetches
// model + clips from the local fixture server only.
//
// Results are parked on window.__swBench for the harness to collect.

import { MODEL_ID } from './bench-whisper-lib';

export const RUNNER_SOURCE = `
import { env, pipeline, WhisperTextStreamer } from '/vendor/transformers.web.min.js';

const q = new URLSearchParams(location.search);
const backend = q.get('backend') || 'wasm';
const csp = q.get('csp') || 'prod';
const gpu = q.get('gpu') || 'none';
const dtype = q.get('dtype') || 'q8';
const clipIds = (q.get('clips') || '').split(',').filter(Boolean);

// Fire-and-forget phase beacon to the fixture server: survives page hangs,
// so a killed variant still leaves its last phase (and probe answers) on disk.
const telemetry = (p, at, extra) => {
  const d = extra ? '&d=' + encodeURIComponent(extra) : '';
  void fetch('/telemetry?b=' + backend + '&c=' + csp + '&g=' + gpu + '&p=' + encodeURIComponent(p) + '&m=' + Math.round(at) + d).catch(() => {});
};

const errs = [];
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  errs.push('unhandledrejection: ' + String(r && r.message ? r.message : r));
});
window.addEventListener('error', (ev) => {
  errs.push('error: ' + ev.message);
});

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = '/ort/';
env.backends.onnx.wasm.numThreads = 1;

let heapPeakMB = 0;
const memTimer = setInterval(() => {
  const m = performance.memory;
  if (m) heapPeakMB = Math.max(heapPeakMB, m.usedJSHeapSize / 1048576);
}, 200);

async function probeWasm() {
  try {
    await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return 'ok';
  } catch (e) {
    return String(e);
  }
}

async function probeGpu() {
  try {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return 'no-adapter';
    let label = a.constructor.name;
    try {
      if (a.info) label = a.info.vendor + '|' + a.info.architecture;
    } catch (_) { /* info absent on some builds */ }
    return 'adapter:' + label;
  } catch (e) {
    return String(e);
  }
}

async function loadClip(id) {
  const res = await fetch('/clips/' + id + '.f32');
  if (!res.ok) throw new Error('clip fetch ' + res.status);
  const buf = await res.arrayBuffer();
  return new Float32Array(buf);
}

async function main() {
  const t0 = performance.now();
  telemetry('start', 0);
  const wasmProbe = await probeWasm();
  const gpuProbe = await probeGpu();
  const sab = typeof SharedArrayBuffer !== 'undefined';
  const coi = typeof crossOriginIsolated === 'boolean' && crossOriginIsolated;
  telemetry('probed', performance.now() - t0, JSON.stringify({ wasm: wasmProbe, gpu: gpuProbe, sab, coi }));

  let transcriber = null;
  let loadMs = null;
  let loadError = null;
  telemetry('model-loading', performance.now() - t0);
  try {
    transcriber = await pipeline('automatic-speech-recognition', '${MODEL_ID}', {
      dtype: dtype,
      device: backend,
    });
    loadMs = performance.now() - t0;
    telemetry('model-loaded', performance.now() - t0);
  } catch (e) {
    loadError = String(e && e.message ? e.message : e);
    telemetry('model-failed', performance.now() - t0, loadError);
  }

  const clips = [];
  for (const id of clipIds) {
    const rec = {
      id,
      modelLoadMs: loadMs,
      loadError,
      firstTokenMs: null,
      firstTextMs: null,
      transcribeMs: null,
      rtf: null,
      words: null,
      chunks: [],
      clipError: null,
    };
    if (transcriber) {
      telemetry('clip-' + id + '-start', performance.now() - t0);
      try {
        const samples = await loadClip(id);
        const durationSec = samples.length / 16000;
        const tA = performance.now();
        const firstTokenAt = { v: null };
        const firstTextAt = { v: null };
        // v4 fires the callback options only through an explicit streamer;
        // fall back to a shape-based probe when the tokenizer is unavailable.
        const streamer = transcriber.tokenizer
          ? new WhisperTextStreamer(transcriber.tokenizer, {
              skip_prompt: true,
              token_callback_function: () => {
                if (firstTokenAt.v === null) firstTokenAt.v = performance.now();
              },
              callback_function: () => {
                if (firstTextAt.v === null) firstTextAt.v = performance.now();
              },
            })
          : {
              put: (t) => {
                if (firstTokenAt.v === null && t.length === 1 && t[0].length === 1) {
                  firstTokenAt.v = performance.now();
                }
              },
              end: () => {},
            };
        const out = await transcriber(samples, {
          return_timestamps: 'word',
          chunk_length_s: 30,
          streamer,
        });
        const tB = performance.now();
        rec.firstTokenMs = firstTokenAt.v === null ? null : firstTokenAt.v - tA;
        rec.firstTextMs = firstTextAt.v === null ? null : firstTextAt.v - tA;
        rec.transcribeMs = tB - tA;
        rec.rtf = rec.transcribeMs / (durationSec * 1000);
        rec.words = (out.text || '').trim();
        if (Array.isArray(out.chunks)) {
          rec.chunks = out.chunks.map((c) => ({
            text: c.text,
            start: c.timestamp[0],
            end: c.timestamp[1],
          }));
        }
        telemetry('clip-' + id + '-done', performance.now() - t0);
      } catch (e) {
        rec.clipError = String(e && e.message ? e.message : e);
        telemetry('clip-' + id + '-failed', performance.now() - t0, rec.clipError);
      }
    }
    clips.push(rec);
  }

  clearInterval(memTimer);
  telemetry('done', performance.now() - t0);
  const m = performance.memory;
  window.__swBench = {
    state: 'done',
    data: {
      backend,
      wasmProbe,
      gpuProbe,
      sab,
      coi,
      loadMs,
      loadError,
      heapPeakMB,
      heapLimitMB: m ? m.jsHeapSizeLimit / 1048576 : null,
      clips,
      errs,
      totalMs: performance.now() - t0,
    },
  };
}

main().catch((e) => {
  window.__swBench = {
    state: 'error',
    error: String(e && e.message ? e.message : e),
  };
});
`;
