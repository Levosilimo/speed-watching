// Shared constants and pure helpers for the Phase-2 Whisper benchmark
// (scripts/bench-whisper.ts, scripts/bench-whisper-page.ts and
// tests/bench-whisper-wer.test.ts).

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-root-relative paths shared by the CLI driver and the page harness.
export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DIST_DIR = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist');
export const ORT_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
export const MODELS_DIR = join(ROOT, 'scripts', 'data', 'whisper-bench', 'models');
export const CLIPS_DIR = join(ROOT, 'scripts', 'data', 'whisper-bench', 'clips');
export const BENCH_PORT = 8791;
export const BENCH_BASE = `http://127.0.0.1:${BENCH_PORT}`;
// Page-phase telemetry (see bench-whisper-page.ts /telemetry handler).
export const TELEMETRY_PATH = join(ROOT, 'scripts', 'data', 'whisper-bench', 'telemetry.jsonl');

export interface BenchClip {
  id: string;
  seconds: number;
  transcript: string;
}

// LibriSpeech test-clean, speaker 260 (read audiobook speech, no music/noise).
// Source: openslr/librispeech_asr (HF dataset mirror of LibriSpeech, CC BY 4.0,
// Panayotov et al. 2015, OpenSLR resource 12). Clips downloaded once at dev
// time from the datasets-server rows API, decoded to 16 kHz mono f32 raw.
// Total audio: 49.2 s, each clip under 30 s (no Whisper chunking).
export const CLIPS: BenchClip[] = [
  {
    id: '260-123288-0015',
    seconds: 21.185,
    transcript:
      'FROM THE UNDER SURFACE OF THE CLOUDS THERE ARE CONTINUAL EMISSIONS OF LURID LIGHT ELECTRIC MATTER IS IN CONTINUAL EVOLUTION FROM THEIR COMPONENT MOLECULES THE GASEOUS ELEMENTS OF THE AIR NEED TO BE SLAKED WITH MOISTURE FOR INNUMERABLE COLUMNS OF WATER RUSH UPWARDS INTO THE AIR AND FALL BACK AGAIN IN WHITE FOAM',
  },
  {
    id: '260-123288-0024',
    seconds: 14.595,
    transcript:
      'THE FIREBALL HALF OF IT WHITE HALF AZURE BLUE AND THE SIZE OF A TEN INCH SHELL MOVED SLOWLY ABOUT THE RAFT BUT REVOLVING ON ITS OWN AXIS WITH ASTONISHING VELOCITY AS IF WHIPPED ROUND BY THE FORCE OF THE WHIRLWIND',
  },
  {
    id: '260-123288-0025',
    seconds: 13.445,
    transcript:
      'HERE IT COMES THERE IT GLIDES NOW IT IS UP THE RAGGED STUMP OF THE MAST THENCE IT LIGHTLY LEAPS ON THE PROVISION BAG DESCENDS WITH A LIGHT BOUND AND JUST SKIMS THE POWDER MAGAZINE HORRIBLE',
  },
];

// CSP policies. prod replicates Chrome's default for extension pages that
// declare no content_security_policy in the manifest (WXT built output).
// relaxed is the Lane B proposal adding 'wasm-unsafe-eval'.
// prod-workers is an isolator: it answers whether the WASM backend would also
// need worker-src allowances beyond the wasm-unsafe-eval question.
export const CSP_POLICIES = {
  prod: "script-src 'self'; object-src 'self'",
  relaxed: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  'prod-workers': "script-src 'self'; object-src 'self'; worker-src 'self' blob:",
} as const;

export type CspMode = keyof typeof CSP_POLICIES;
export type Backend = 'wasm' | 'webgpu';

export const MODEL_ID = 'Xenova/whisper-base';
export const MODEL_DTYPE = 'q8';

// Model files needed by transformers.js v4 Whisper (quantized q8 build).
export const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'generation_config.json',
  'added_tokens.json',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
  'normalizer.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
] as const;

// Lowercase, keep letters/digits, collapse whitespace. Whisper output is
// already lowercase; the LibriSpeech reference is uppercase prose.
export function normalizeForWer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

// Word-level Levenshtein distance over normalized tokens.
export function levenshtein(a: string[], b: string[]): number {
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  let curr = Array.from({ length: cols }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1]! === b[j - 1]! ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[cols - 1]!;
}

export function wer(reference: string, hypothesis: string): number {
  const ref = normalizeForWer(reference);
  const hyp = normalizeForWer(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}

// Substitution/deletion/insertion counts from the Levenshtein backtrace over
// normalized tokens. countBias = (I - D) / ref_words is the word-count drift
// of the hypothesis vs the reference: positive means the STT added words
// (over-counting the speech rate), negative means it dropped them. The G1/G2
// battery bounds it to [-2%, +8%] per model/clip.
export interface WerDecomposition {
  S: number;
  D: number;
  I: number;
  wer: number;
  countBias: number;
}

export function werDecomposed(reference: string, hypothesis: string): WerDecomposition {
  const ref = normalizeForWer(reference);
  const hyp = normalizeForWer(hypothesis);
  if (ref.length === 0) {
    return { S: 0, D: 0, I: hyp.length, wer: hyp.length === 0 ? 0 : 1, countBias: 1 };
  }
  const cols = hyp.length + 1;
  const rows = ref.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (let j = 1; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) d[i]![0] = i;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = ref[i - 1]! === hyp[j - 1]! ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  let i = rows - 1;
  let j = cols - 1;
  let S = 0;
  let D = 0;
  let I = 0;
  while (i > 0 || j > 0) {
    const diag = i > 0 && j > 0 ? d[i - 1]![j - 1]! : Number.POSITIVE_INFINITY;
    const up = i > 0 ? d[i - 1]![j]! : Number.POSITIVE_INFINITY;
    const left = j > 0 ? d[i]![j - 1]! : Number.POSITIVE_INFINITY;
    if (diag <= up && diag <= left) {
      if (d[i]![j]! !== diag) S += 1;
      i -= 1;
      j -= 1;
    } else if (up <= left) {
      D += 1;
      i -= 1;
    } else {
      I += 1;
      j -= 1;
    }
  }
  return { S, D, I, wer: (S + D + I) / ref.length, countBias: (I - D) / ref.length };
}

export interface WordTimestamp {
  text: string;
  start: number;
  end: number;
}

// Word timestamps must be non-decreasing and stay within the clip duration.
export function timestampSanity(
  chunks: WordTimestamp[],
  durationSec: number,
): { monotonic: boolean; lastEndSec: number | null; withinDuration: boolean } {
  if (chunks.length === 0) {
    return { monotonic: true, lastEndSec: null, withinDuration: true };
  }
  const EPSILON = 0.05;
  let monotonic = true;
  for (let i = 1; i < chunks.length; i++) {
    const cur = chunks[i]!;
    const prev = chunks[i - 1]!;
    if (cur.start < prev.end - EPSILON) {
      monotonic = false;
      break;
    }
  }
  const lastEndSec = chunks[chunks.length - 1]!.end;
  return { monotonic, lastEndSec, withinDuration: lastEndSec <= durationSec + 0.5 };
}

// Whisper word-level output from transformers.js v4: { text, chunks: [...] }.
export interface WhisperWordOutput {
  text: string;
  chunks: WordTimestamp[];
}
