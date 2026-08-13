// G6 VAD-denominator articulation-rate measurement (scripts/stt-battery.ts
// --vad). The G1/G5 failures were timing-shape-driven: whisper's word
// timestamps span the full 66 s window while the caption reference's speech
// span starts at the first word, so the caption-derived speechDurationSec
// (inter-start spans, >= 1 s gaps excluded) is not a defensible arbiter —
// quantized YouTube-ASR word timing collapses it to ~435 wpm on iG9CE55wbtY
// (85 tokens / 16.3 s). The settled G6 denominator: speech seconds from
// silero VAD v4 on the repo's pinned ort (16k, 512-sample frames, h/c
// [2,1,64] state reset per clip, threshold 0.35, min_speech 0.25 s,
// min_silence 0.4 s, pad 50 ms — the ~/va sherpa-onnx config) with an RMS
// gate: frames under VAD_RMS_FLOOR are silence without inference (v4
// hallucinates speech on zero input; measured prob 0.88+). Reference:
// hand-annotated speech seconds (scripts/data/stt-battery/hand-speech.jsonl,
// energy bands + caption span geometry, same pause scale) and the caption
// word count. Gate: >= 4/5 clips within +-10% of the hand-derived rate;
// the caption comparison stays in the record for transparency.
//
// Appends numeric-only 'vad' records to scripts/data/stt-battery/results-vad.jsonl.

import { createHash } from 'node:crypto';
import { copyFile, appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeForWer, werDecomposed } from './bench-whisper-lib';
import { countWordTokens } from '../lib/tokenizer';
import { speechDurationSec } from '../lib/wpm';
import {
  BATTERY_DIR,
  BATTERY_VIDEOS,
  VAD_DIR,
  VAD_MODEL_FILE,
  VAD_MODEL_SHA256,
  VAD_MODEL_SOURCE,
  batteryModels,
  loadClipRef,
  runInference,
  startServer,
  type BatteryModel,
  type ChunkConfig,
  type RunnerClip,
} from './stt-battery-lib';
import { closeServer, rateErrorPct } from './stt-battery-analysis';

// RMS silence floor shared by the gate (documented with calibration evidence
// in verdicts.md G6): true-silence regions of the corpus sit <= 0.004 RMS
// (HtSuA80QTyo/jGwO_UgTS7I/WUvTyaaNkzM p5: 0.000-0.003), the quietest speech
// median is 0.0096 (jGwO_UgTS7I). Interpolated into the page-side runner.
const VAD_RMS_FLOOR = 0.005;

// ---------------------------------------------------------------------------
// Page-side VAD runner (plain JS, served by the battery server at
// /vad/runner.js; the runner page imports it only when ?vad=1).
const VAD_RUNNER_SOURCE = `
import * as ort from '/ort/ort.webgpu.min.mjs';

// silero VAD v4 (get_speech_timestamps port): 512-sample frames at 16 kHz,
// h/c LSTM state [2,1,64] carried across frames, reset per clip. Graph I/O
// names x/h/c -> prob/new_h/new_c (the v4 export's metadata map mislabels
// them "0"/"1"/"2"; feed by graph name). Config = the ~/va sherpa-onnx
// values: threshold 0.35, min_speech 0.25 s, min_silence 0.4 s, pad 50 ms.
const VAD_WINDOW = 512;
const VAD_THRESHOLD = 0.35;
const VAD_MIN_SPEECH_MS = 250;
const VAD_MIN_SILENCE_MS = 400;
const VAD_PAD_MS = 50;
const VAD_RMS_FLOOR = ${VAD_RMS_FLOOR};

function frameRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

let vadSession = null;
let vadSessionError = null;

function getVadSession() {
  if (vadSession === null && vadSessionError === null) {
    vadSession = ort.InferenceSession.create('/vad/silero_vad.onnx', {
      executionProviders: ['wasm'],
    }).catch((e) => {
      vadSessionError = String(e && e.message ? e.message : e);
      return null;
    });
  }
  return vadSession;
}

// Per-frame speech probs; frames under rmsFloor are silence without
// inference (rmsFloor 0 disables the gate — the music-lead A/B).
async function vadProbs(samples, rmsFloor) {
  const session = await getVadSession();
  if (!session) return { error: vadSessionError };
  let h = new Float32Array(128);
  let c = new Float32Array(128);
  const probs = [];
  const frames = Math.ceil(samples.length / VAD_WINDOW);
  for (let i = 0; i < frames; i++) {
    const buf = new Float32Array(VAD_WINDOW);
    buf.set(samples.subarray(i * VAD_WINDOW, Math.min((i + 1) * VAD_WINDOW, samples.length)));
    if (rmsFloor > 0 && frameRms(buf) < rmsFloor) {
      probs.push(0);
      continue;
    }
    const out = await session.run({
      x: new ort.Tensor('float32', buf, [1, VAD_WINDOW]),
      h: new ort.Tensor('float32', h, [2, 1, 64]),
      c: new ort.Tensor('float32', c, [2, 1, 64]),
    });
    probs.push(out.prob.data[0]);
    h = out.new_h.data;
    c = out.new_c.data;
  }
  return { probs };
}

// Prob trace -> segments: runs >= threshold close after min_silence,
// runs < min_speech dropped, pad 50 ms, overlapping pads merge.
function vadSegments(probs, sampleCount) {
  const minSilence = Math.ceil(VAD_MIN_SILENCE_MS / 32);
  const minSpeech = Math.ceil(VAD_MIN_SPEECH_MS / 32);
  const segs = [];
  let start = -1;
  let silence = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] >= VAD_THRESHOLD) {
      if (start < 0) start = i;
      silence = 0;
    } else if (start >= 0 && ++silence >= minSilence) {
      const end = i - silence + 1;
      if (end - start >= minSpeech) segs.push({ start: start * VAD_WINDOW, end: end * VAD_WINDOW });
      start = -1;
      silence = 0;
    }
  }
  if (start >= 0 && probs.length - start >= minSpeech) {
    segs.push({ start: start * VAD_WINDOW, end: sampleCount });
  }
  const pad = (VAD_PAD_MS * 16000) / 1000;
  const merged = [];
  for (const s of segs) {
    const p = { start: Math.max(0, s.start - pad), end: Math.min(sampleCount, s.end + pad) };
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else merged.push(p);
  }
  return merged;
}

// One clip: gated and open (no-gate) segmentations; the open run is the
// music-lead A/B evidence (music is loud, so the gate cannot touch it).
export async function runClipVad(samples) {
  const gated = await vadProbs(samples, VAD_RMS_FLOOR);
  if (gated.error) return { error: gated.error };
  const open = await vadProbs(samples, 0);
  if (open.error) return { error: open.error };
  const segs = vadSegments(gated.probs, samples.length);
  const openSegs = vadSegments(open.probs, samples.length);
  return {
    segs,
    speechSec: segs.reduce((sum, s) => sum + (s.end - s.start), 0) / 16000,
    noGateSec: openSegs.reduce((sum, s) => sum + (s.end - s.start), 0) / 16000,
  };
}
`;

const VAD_EXTRA_FILES: Array<[string, string]> = [['/vad/runner.js', VAD_RUNNER_SOURCE]];

// English function-word stoplist: articles, pronouns, copulas, auxiliaries,
// conjunctions, prepositions, interjections, negators and filled pauses.
// Applied AFTER normalizeForWer (lowercase letters/digits), so 'I' -> 'i'.
const STOPWORDS = new Set([
  'a', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'him', 'his', 'i', 'in', 'is', 'it', 'may', 'me',
  'might', 'must', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'should',
  'so', 'that', 'the', 'their', 'them', 'these', 'they', 'this', 'those', 'to',
  'uh', 'um', 'us', 'was', 'we', 'well', 'were', 'will', 'with', 'would', 'yes',
  'you', 'your',
]);

interface VadRecord {
  kind: 'vad';
  ts: string;
  videoId: string;
  category: string;
  model: BatteryModel;
  chunkConfig: ChunkConfig;
  clipSec: number;
  refTokens: number;
  hypWordCount: number;
  handSpeechSec: number;
  refRate: number;
  vadSegs: number;
  vadSpeechSec: number | null;
  hypRate: number | null;
  rateErrorPct: number | null;
  vadSpeechSecNoGate: number | null;
  captionRefSpeechSec: number | null;
  captionRefRate: number | null;
  captionRateErrPct: number | null;
  vadLeadSec: number | null;
  countBias: number;
  countBiasContent: number;
  loadError: string | null;
  vadError: string | null;
  clipError: string | null;
}

// G6 per-clip gate: articulation-rate error vs the hand reference +-10%.
function vadGatePass(r: VadRecord): boolean {
  return r.rateErrorPct !== null && Math.abs(r.rateErrorPct) <= 10;
}

// Copies the box's canonical v4 model into the fixture dir and verifies the
// sha256 (provenance: the same bytes ~/va runs via sherpa-onnx at 16k).
async function ensureVadModel(): Promise<void> {
  if (existsSync(VAD_MODEL_FILE)) return;
  if (!existsSync(VAD_MODEL_SOURCE)) {
    throw new Error(`v4 vad model missing: copy ${VAD_MODEL_SOURCE} into the fixture dir`);
  }
  await mkdir(VAD_DIR, { recursive: true });
  await copyFile(VAD_MODEL_SOURCE, VAD_MODEL_FILE);
  const sha = createHash('sha256').update(await readFile(VAD_MODEL_FILE)).digest('hex');
  if (sha !== VAD_MODEL_SHA256) throw new Error(`vad model sha256 mismatch: ${sha}`);
  console.log(`[vad] ${VAD_MODEL_FILE} (${VAD_MODEL_SOURCE})`);
}

interface HandRef {
  speechSec: number;
  spanStart: number;
  spanEnd: number;
  segCount: number;
  method: string;
}

const HAND_FILE = join(BATTERY_DIR, 'hand-speech.jsonl');

// Hand-annotated speech seconds (energy bands + caption span geometry; the
// method field carries each clip's evidence). Same pause scale as the VAD:
// min_speech 0.25 s, min_silence 0.4 s.
function loadHandRef(videoId: string): HandRef {
  for (const line of readFileSync(HAND_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as HandRef & { videoId: string };
    if (r.videoId === videoId) return r;
  }
  throw new Error(`hand-speech.jsonl missing ${videoId}`);
}

function contentTokens(text: string): string[] {
  return normalizeForWer(text).filter((t) => !STOPWORDS.has(t));
}

// One G6 record: whisper word count over the VAD speech seconds vs the
// hand-annotated reference rate; caption reference kept for transparency.
function analyzeVadClip(
  c: RunnerClip,
  model: BatteryModel,
  chunkConfig: ChunkConfig,
  loadError: string | null,
): VadRecord {
  const ref = loadClipRef(c.id);
  const hand = loadHandRef(c.id);
  const refText = ref.words.map((w) => w.text).join(' ');
  const refTokens = countWordTokens(refText);
  const refRate = (refTokens / hand.speechSec) * 60;
  const vadSpeechSec = c.vad?.speechSec ?? null;
  const hypWordCount = countWordTokens(c.words ?? '');
  const hypRate = vadSpeechSec === null || vadSpeechSec <= 0 ? null : (hypWordCount / vadSpeechSec) * 60;
  const captionRefSpeechSec = speechDurationSec(ref.words);
  const captionRefRate = captionRefSpeechSec === null ? null : (refTokens / captionRefSpeechSec) * 60;
  return {
    kind: 'vad',
    ts: new Date().toISOString(),
    videoId: c.id,
    category: ref.category,
    model,
    chunkConfig,
    clipSec: c.durationSec ?? 60,
    refTokens,
    hypWordCount,
    handSpeechSec: hand.speechSec,
    refRate,
    vadSegs: c.vad?.segs?.length ?? 0,
    vadSpeechSec,
    hypRate,
    rateErrorPct: rateErrorPct(hypRate, refRate),
    vadSpeechSecNoGate: c.vad?.noGateSec ?? null,
    captionRefSpeechSec,
    captionRefRate,
    captionRateErrPct: rateErrorPct(hypRate, captionRefRate),
    vadLeadSec: c.vad?.segs?.[0] === undefined ? null : c.vad.segs[0].start / 16000,
    countBias: werDecomposed(refText, c.words ?? '').countBias,
    countBiasContent: werDecomposed(
      contentTokens(refText).join(' '),
      contentTokens(c.words ?? '').join(' '),
    ).countBias,
    loadError,
    vadError: c.vad?.error ?? null,
    clipError: c.clipError,
  };
}

export async function vadStep(): Promise<void> {
  await ensureVadModel();
  const server = await startServer(VAD_EXTRA_FILES);
  try {
    const records: VadRecord[] = [];
    const chunkConfig: ChunkConfig = {
      chunkLengthS: 29,
      strideLengthS: 5,
      forceFull: false,
      tsMode: 'word',
    };
    const clipIds = BATTERY_VIDEOS.map((v) => v.id);
    for (const model of batteryModels()) {
      console.log(
        `\n[vad] ${model} (tsMode=word, chunk 29/stride 5, silero v4, ` +
          `threshold 0.35, rms floor ${VAD_RMS_FLOOR})`,
      );
      const result = await runInference(model, clipIds, chunkConfig, true);
      if (result.state !== 'done' || !result.clips) {
        console.error(`[vad] ${model}: harness/runner failure: ${result.error ?? result.state}`);
        process.exitCode = 1;
        continue;
      }
      let passed = 0;
      for (const c of result.clips) {
        const r = analyzeVadClip(c, model, chunkConfig, result.loadError ?? null);
        records.push(r);
        if (vadGatePass(r)) passed += 1;
        console.log(
          `  ${c.id.padEnd(12)} words=${r.hypWordCount} vad=${r.vadSpeechSec?.toFixed(1) ?? 'n/a'}s ` +
            `hand=${r.handSpeechSec.toFixed(1)}s rate=${(r.hypRate ?? NaN).toFixed(0)}/${(r.refRate ?? NaN).toFixed(0)} ` +
            `rateErr=${(r.rateErrorPct ?? NaN).toFixed(1)}% bias=${(r.countBias * 100).toFixed(1)}%` +
            `/${(r.countBiasContent * 100).toFixed(1)}% lead=${(r.vadLeadSec ?? NaN).toFixed(1)}s ` +
            `${vadGatePass(r) ? 'PASS' : 'FAIL'} ${r.vadError ?? r.clipError ?? ''}`,
        );
      }
      console.log(`[vad] ${model} G6: ${passed}/5 clips pass (+-10% vs hand reference)`);
    }
    await appendFile(join(BATTERY_DIR, 'results-vad.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`[vad] ${records.length} records -> results-vad.jsonl`);
  } finally {
    await closeServer(server);
  }
}
