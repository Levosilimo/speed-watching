// V1 model-lock and V2 chunk-seam measurements for the Phase-0 STT battery.
//
// V1: tiny.en q8 vs base.en q8 on the ~66 s real lecture clips; decomposed
// WER (S/D/I), count-bias (I-D)/ref_words, rate error vs the caption-derived
// reference rate (ratesFor from sample-analysis), timestamp sanity. Verdict
// rule (per clip): rate error <=10% (word-accurate), count-bias in
// [-2%,+8%], WER <=15%.
//
// V2: the same continuous clip crossing the whisper chunk boundary; control
// chunk_length_s=30 vs the transformers.js #1358 workaround chunk_length_s=29
// + stride_length_s=5 + force_full_sequences:false. Per-seam word continuity,
// dedup, out-of-order drops and the seam count-bias.
//
// Runs inference through the fixture origin (stt-battery-lib.ts) and appends
// numeric-only records to scripts/data/stt-battery/results-v1.jsonl and
// results-v2.jsonl.

import { appendFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { ParsedCaptions, Segment } from '../lib/captions';
import { timestampSanity, werDecomposed, type WordTimestamp } from './bench-whisper-lib';
import { ratesFor } from './sample-analysis';
import {
  BATTERY_DIR,
  BATTERY_MODELS,
  BATTERY_VIDEOS,
  SEAM_VIDEO,
  loadClipRef,
  runInference,
  startServer,
  type BatteryModel,
  type ChunkConfig,
} from './stt-battery-lib';

// ---------------------------------------------------------------------------
// V1 analysis: decomposed WER + count-bias + rate error per model/clip.

interface V1Record {
  kind: 'v1';
  ts: string;
  videoId: string;
  category: string;
  model: BatteryModel;
  chunkConfig: ChunkConfig;
  refWords: number;
  S: number;
  D: number;
  I: number;
  wer: number;
  countBias: number;
  refUnifiedRate: number | null;
  hypUnifiedRate: number | null;
  rateErrorUnifiedPct: number | null;
  refWordAccurateRate: number | null;
  hypWordAccurateRate: number | null;
  rateErrorWordAccuratePct: number | null;
  tsMonotonic: boolean | null;
  tsWithinDuration: boolean | null;
  tsLastEndSec: number | null;
  rtf: number | null;
  loadError: string | null;
  clipError: string | null;
}

// Hyp rate inputs: each word chunk becomes its own cue (word-timed ASR has no
// cue boundaries; production feeds these shapes to the same rate helpers).
function parsedFromChunks(chunks: WordTimestamp[]): ParsedCaptions {
  const segs: Segment[] = chunks.map((c) => ({
    text: c.text,
    startSec: c.start,
    durSec: c.end - c.start,
  }));
  return { cues: segs, words: segs };
}

function rateErrorPct(hyp: number | null, ref: number | null): number | null {
  if (hyp === null || ref === null || ref === 0) return null;
  return ((hyp - ref) / ref) * 100;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function transcribeStep(): Promise<void> {
  const server = await startServer();
  try {
    const clips = BATTERY_VIDEOS.map((v) => v.id);
    const records: V1Record[] = [];
    // Same chunk config as the locked seam strategy (transformers.js #1358
    // workaround): chunk 29 + stride 5 without force_full_sequences.
    const chunkConfig: ChunkConfig = { chunkLengthS: 29, strideLengthS: 5, forceFull: false };
    for (const model of BATTERY_MODELS) {
      console.log(`\n[transcribe] ${model} (chunk_length_s=29, stride_length_s=5)`);
      const result = await runInference(model, clips, chunkConfig);
      if (result.state !== 'done' || !result.clips) {
        console.error(`[transcribe] ${model}: harness/runner failure: ${result.error ?? result.state}`);
        process.exitCode = 1;
        continue;
      }
      for (const c of result.clips) {
        const ref = loadClipRef(c.id);
        const refText = ref.words.map((w) => w.text).join(' ');
        const hyp = c.words ?? '';
        const dec = werDecomposed(refText, hyp);
        const refRates = ratesFor({ cues: ref.cues, words: ref.words });
        const hypParsed = parsedFromChunks(c.chunks);
        const hypRates = ratesFor(hypParsed);
        const sanity = timestampSanity(c.chunks, c.durationSec ?? 60);
        const record: V1Record = {
          kind: 'v1',
          ts: new Date().toISOString(),
          videoId: c.id,
          category: ref.category,
          model,
          chunkConfig,
          refWords: ref.words.length,
          S: dec.S,
          D: dec.D,
          I: dec.I,
          wer: dec.wer,
          countBias: dec.countBias,
          refUnifiedRate: refRates?.unifiedRate ?? null,
          hypUnifiedRate: hypRates?.unifiedRate ?? null,
          rateErrorUnifiedPct: rateErrorPct(hypRates?.unifiedRate ?? null, refRates?.unifiedRate ?? null),
          refWordAccurateRate: refRates?.wordAccurateRate ?? null,
          hypWordAccurateRate: hypRates?.wordAccurateRate ?? null,
          rateErrorWordAccuratePct: rateErrorPct(
            hypRates?.wordAccurateRate ?? null,
            refRates?.wordAccurateRate ?? null,
          ),
          tsMonotonic: c.chunks.length > 1 ? sanity.monotonic : null,
          tsWithinDuration: c.chunks.length ? sanity.withinDuration : null,
          tsLastEndSec: sanity.lastEndSec,
          rtf: c.rtf,
          loadError: result.loadError ?? null,
          clipError: c.clipError,
        };
        records.push(record);
        const ok =
          Math.abs(record.rateErrorWordAccuratePct ?? 999) <= 10 &&
          record.countBias >= -0.02 &&
          record.countBias <= 0.08 &&
          record.wer <= 0.15;
        console.log(
          `  ${c.id.padEnd(12)} wer=${(dec.wer * 100).toFixed(1)}% bias=${(dec.countBias * 100).toFixed(1)}% ` +
            `rateErr(w)=${(record.rateErrorWordAccuratePct ?? NaN).toFixed(1)}% ` +
            `rateErr(u)=${(record.rateErrorUnifiedPct ?? NaN).toFixed(1)}% ` +
            `mono=${String(sanity.monotonic)} ${ok ? 'PASS' : 'FAIL'} ${c.clipError ?? ''}`,
        );
      }
    }
    await appendFile(join(BATTERY_DIR, 'results-v1.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`[transcribe] ${records.length} records -> results-v1.jsonl`);
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------
// Phase-0 smoke: one clip through the full harness path (server + runner +
// inference + V1 analysis), appended as a 'smoke' record to results-v2.jsonl.

export async function smokeStep(clipId: string, model: BatteryModel): Promise<void> {
  const server = await startServer();
  try {
    const chunkConfig: ChunkConfig = { chunkLengthS: 29, strideLengthS: 5, forceFull: false };
    console.log(`[smoke] ${model} clip=${clipId} chunk=29 stride=5`);
    const result = await runInference(model, [clipId], chunkConfig);
    if (result.state !== 'done' || !result.clips) {
      console.error(`[smoke] harness/runner failure: ${result.error ?? result.state}`);
      process.exitCode = 1;
      return;
    }
    const c = result.clips[0]!;
    if (!c.words || c.clipError) {
      console.error(`[smoke] FAIL clipError=${c.clipError} words=${JSON.stringify(c.words?.slice(0, 120))}`);
      process.exitCode = 1;
      return;
    }
    const ref = loadClipRef(c.id);
    const dec = werDecomposed(ref.words.map((w) => w.text).join(' '), c.words);
    const sanity = timestampSanity(c.chunks, c.durationSec ?? 60);
    const record = {
      kind: 'smoke',
      ts: new Date().toISOString(),
      videoId: c.id,
      model,
      chunkConfig,
      refWords: ref.words.length,
      hypWords: c.chunks.length,
      S: dec.S,
      D: dec.D,
      I: dec.I,
      wer: dec.wer,
      countBias: dec.countBias,
      tsMonotonic: sanity.monotonic,
      rtf: c.rtf,
      loadError: result.loadError ?? null,
      clipError: c.clipError,
    };
    await appendFile(join(BATTERY_DIR, 'results-v2.jsonl'), JSON.stringify(record) + '\n');
    console.log(
      `[smoke] PASS words=${c.chunks.length} wer=${(dec.wer * 100).toFixed(1)}% ` +
        `bias=${(dec.countBias * 100).toFixed(1)}% mono=${String(sanity.monotonic)} ` +
        `rtf=${c.rtf?.toFixed(2) ?? 'n/a'} -> results-v2.jsonl`,
    );
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------
// V2 seam analysis.

interface SeamMetrics {
  seamSec: number;
  refInWindow: number;
  inOrderMatches: number;
  recall: number;
  boundaryRef: number;
  boundaryHyp: number;
  outOfOrderHyp: number;
  dupPairsHyp: number;
  S: number;
  D: number;
  I: number;
  wer: number;
  countBias: number;
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

// Greedy in-order match of hyp words against the ref window (LCS-ish; enough
// to expose seam-local drops and reorderings).
function inOrderMatches(refWords: string[], hypWords: string[]): number {
  let matched = 0;
  let j = 0;
  for (const hw of hypWords) {
    while (j < refWords.length && refWords[j] !== hw) j += 1;
    if (j >= refWords.length) break;
    matched += 1;
    j += 1;
  }
  return matched;
}

function seamMetrics(
  seamSec: number,
  refWords: Array<{ text: string; startSec: number }>,
  hypChunks: WordTimestamp[],
): SeamMetrics {
  const WINDOW = 3;
  const refIn = refWords.filter((w) => Math.abs(w.startSec - seamSec) <= WINDOW);
  const hypIn = hypChunks.filter((c) => Math.abs(c.start - seamSec) <= WINDOW);
  const refToks = refIn.map((w) => normalizeWord(w.text)).filter(Boolean);
  const hypToks = hypIn.map((c) => normalizeWord(c.text)).filter(Boolean);
  const boundaryRef = refIn.filter((w) => Math.abs(w.startSec - seamSec) <= 0.5).length;
  const boundaryHyp = hypIn.filter((c) => Math.abs(c.start - seamSec) <= 0.5).length;
  let outOfOrderHyp = 0;
  for (let i = 1; i < hypIn.length; i++) {
    if (hypIn[i]!.start < hypIn[i - 1]!.start - 0.05) outOfOrderHyp += 1;
  }
  let dupPairsHyp = 0;
  for (let i = 1; i < hypToks.length; i++) {
    if (hypToks[i] === hypToks[i - 1]) dupPairsHyp += 1;
  }
  const dec = werDecomposed(refIn.map((w) => w.text).join(' '), hypIn.map((c) => c.text).join(' '));
  return {
    seamSec,
    refInWindow: refIn.length,
    inOrderMatches: inOrderMatches(refToks, hypToks),
    recall: refIn.length > 0 ? inOrderMatches(refToks, hypToks) / refIn.length : 1,
    boundaryRef,
    boundaryHyp,
    outOfOrderHyp,
    dupPairsHyp,
    S: dec.S,
    D: dec.D,
    I: dec.I,
    wer: dec.wer,
    countBias: dec.countBias,
  };
}

function wholeClipDupPairs(chunks: WordTimestamp[]): number {
  let dup = 0;
  for (let i = 1; i < chunks.length; i++) {
    if (normalizeWord(chunks[i]!.text) === normalizeWord(chunks[i - 1]!.text)) dup += 1;
  }
  return dup;
}

interface V2Record {
  kind: 'v2';
  ts: string;
  videoId: string;
  model: BatteryModel;
  chunkConfig: ChunkConfig;
  clipSec: number;
  seams: SeamMetrics[];
  wholeClipCountBias: number;
  wholeClipDupPairs: number;
  tsMonotonic: boolean | null;
  clipError: string | null;
  loadError: string | null;
  rtf: number | null;
  overflowObserved: boolean;
}

export async function seamStep(): Promise<void> {
  const server = await startServer();
  try {
    const model: BatteryModel = 'Xenova/whisper-base.en';
    const clipId = SEAM_VIDEO;
    const ref = loadClipRef(clipId);
    // Clip-relative reference timestamps (whisper output is relative to the
    // clip start).
    const refWords = ref.words.map((w) => ({
      text: w.text,
      startSec: w.startSec - ref.window.startSec,
    }));
    const only = process.env.SEAM_CONFIG;
    const allConfigs: Array<{ label: string; chunkConfig: ChunkConfig }> = [
      { label: 'chunk=30 (production default)', chunkConfig: { chunkLengthS: 30, strideLengthS: null, forceFull: false } },
      { label: 'chunk=29 stride=5 (workaround)', chunkConfig: { chunkLengthS: 29, strideLengthS: 5, forceFull: false } },
    ];
    const configs = only === undefined ? allConfigs : allConfigs.filter((c) => c.label.startsWith(only));
    const records: V2Record[] = [];
    for (const cfg of configs) {
      console.log(`\n[seam] ${cfg.label}`);
      const result = await runInference(model, [clipId], cfg.chunkConfig);
      if (result.state !== 'done' || !result.clips) {
        console.error(`[seam] harness/runner failure: ${result.error ?? result.state}`);
        process.exitCode = 1;
        continue;
      }
      const c = result.clips[0]!;
      const seamSecs = cfg.chunkConfig.chunkLengthS === 29 ? [29] : [30];
      const seams = seamSecs.map((s) => seamMetrics(s, refWords, c.chunks));
      const decWhole = werDecomposed(
        ref.words.map((w) => w.text).join(' '),
        c.words ?? '',
      );
      const sanity = timestampSanity(c.chunks, c.durationSec ?? 60);
      const record: V2Record = {
        kind: 'v2',
        ts: new Date().toISOString(),
        videoId: clipId,
        model,
        chunkConfig: cfg.chunkConfig,
        clipSec: c.durationSec ?? 60,
        seams,
        wholeClipCountBias: decWhole.countBias,
        wholeClipDupPairs: wholeClipDupPairs(c.chunks),
        tsMonotonic: c.chunks.length > 1 ? sanity.monotonic : null,
        clipError: c.clipError,
        loadError: result.loadError ?? null,
        rtf: c.rtf,
        overflowObserved: c.clipError !== null || c.chunks.length === 0 || c.words === '',
      };
      records.push(record);
      for (const s of seams) {
        console.log(
          `  seam@${s.seamSec}s recall=${(s.recall * 100).toFixed(1)}% ` +
            `(ref ${s.refInWindow}, match ${s.inOrderMatches}) boundary=${s.boundaryHyp}/${s.boundaryRef} ` +
            `o3=${s.outOfOrderHyp} dup=${s.dupPairsHyp} wer=${(s.wer * 100).toFixed(1)}% ` +
            `bias=${(s.countBias * 100).toFixed(1)}%`,
        );
      }
      console.log(
        `  whole: words=${c.chunks.length} dup=${record.wholeClipDupPairs} ` +
          `bias=${(record.wholeClipCountBias * 100).toFixed(1)}% mono=${String(sanity.monotonic)} ` +
          `rtf=${c.rtf?.toFixed(2) ?? 'n/a'} overflow=${record.overflowObserved} ${c.clipError ?? ''}`,
      );
    }
    await appendFile(join(BATTERY_DIR, 'results-v2.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`[seam] ${records.length} records -> results-v2.jsonl`);
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------


