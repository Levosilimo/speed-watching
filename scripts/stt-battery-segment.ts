// V5 segment-only re-run (G5): tsMode 'true' — whisper's native segment
// timestamps — over the same 5 clips, same chunk config and same references
// as the V1 word-timed run (scripts/stt-battery-analysis.ts). The hypothesis
// under test: segment cue starts fall at silence boundaries like caption
// cues, so the unified span-trimmed rate over segment timing should clear
// the +-10% band where word timing read ~-20% systematically (G1). Verdict:
// refuted — whisper's first segment starts at 0.0 s on all records, so the
// unified-rate denominator spans the full window incl. the silent lead (see
// scripts/data/stt-battery/verdicts.md G5). Appends numeric-only 'seg'
// records to scripts/data/stt-battery/results-seg.jsonl.

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timestampSanity, werDecomposed } from './bench-whisper-lib';
import { ratesFor } from './sample-analysis';
import { filteredTokensOverTrimmedSpan } from '../lib/wpm';
import {
  BATTERY_DIR,
  BATTERY_VIDEOS,
  batteryModels,
  loadClipRef,
  runInference,
  startServer,
  type BatteryModel,
  type ChunkConfig,
  type RunnerClip,
} from './stt-battery-lib';
import { closeServer, parsedFromChunks, rateErrorPct } from './stt-battery-analysis';

interface SegRecord {
  kind: 'seg';
  ts: string;
  videoId: string;
  category: string;
  model: BatteryModel;
  chunkConfig: ChunkConfig;
  refWords: number;
  segs: number;
  hypSpanStartSec: number | null;
  hypSpanEndSec: number | null;
  S: number;
  D: number;
  I: number;
  wer: number;
  countBias: number;
  refSpanStartSec: number;
  refSpanEndSec: number;
  hypSegsInSpan: number;
  SAligned: number;
  DAligned: number;
  IAligned: number;
  werAligned: number;
  countBiasAligned: number;
  refUnifiedRate: number | null;
  hypUnifiedRate: number | null;
  rateErrorUnifiedPct: number | null;
  tsMonotonic: boolean | null;
  tsWithinDuration: boolean | null;
  tsLastEndSec: number | null;
  rtf: number | null;
  loadError: string | null;
  clipError: string | null;
}

// G5 per-clip pass: unified rate error within +-10% AND aligned count-bias in
// [-2%,+8%] (the count-bias bounds apply to the text decomposition, which is
// independent of the timestamp mode).
function segGatePass(r: SegRecord): boolean {
  return (
    r.rateErrorUnifiedPct !== null &&
    Math.abs(r.rateErrorUnifiedPct) <= 10 &&
    r.countBiasAligned >= -0.02 &&
    r.countBiasAligned <= 0.08
  );
}

export async function segmentStep(): Promise<void> {
  const server = await startServer();
  try {
    const clips = BATTERY_VIDEOS.map((v) => v.id);
    const records: SegRecord[] = [];
    const chunkConfig: ChunkConfig = {
      chunkLengthS: 29,
      strideLengthS: 5,
      forceFull: false,
      tsMode: 'true',
    };
    const models = batteryModels();
    for (const model of models) {
      console.log(`\n[segment] ${model} (tsMode=true, chunk_length_s=29, stride_length_s=5)`);
      const result = await runInference(model, clips, chunkConfig);
      if (result.state !== 'done' || !result.clips) {
        console.error(`[segment] ${model}: harness/runner failure: ${result.error ?? result.state}`);
        process.exitCode = 1;
        continue;
      }
      for (const c of result.clips) {
        const record = analyzeSegClip(c, model, chunkConfig, result.loadError ?? null);
        records.push(record);
        const ok = segGatePass(record);
        console.log(
          `  ${c.id.padEnd(12)} segs=${record.segs} wer=${(record.wer * 100).toFixed(1)}%/${(record.werAligned * 100).toFixed(1)}% ` +
            `bias=${(record.countBias * 100).toFixed(1)}%/${(record.countBiasAligned * 100).toFixed(1)}% ` +
            `rateErr(u)=${(record.rateErrorUnifiedPct ?? NaN).toFixed(1)}% ` +
            `mono=${String(record.tsMonotonic)} ${ok ? 'PASS' : 'FAIL'} ${record.clipError ?? ''}`,
        );
      }
      const passed = records.filter((r) => r.model === model && segGatePass(r)).length;
      console.log(`[segment] ${model} G5: ${passed}/5 clips pass (+-10% unified rate error, count-bias [-2%,+8%])`);
    }
    await appendFile(join(BATTERY_DIR, 'results-seg.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`[segment] ${records.length} records -> results-seg.jsonl`);
  } finally {
    await closeServer(server);
  }
}

// One V5 record: full-window + ref-aligned WER/count-bias on the segment
// transcript, the unified rate over the segment-timed span (filteredTokens-
// OverTrimmedSpan; ratesFor's speech-duration leg would return null on
// segment spacing, whose inter-start gaps always exceed the 1 s cap).
function analyzeSegClip(
  c: RunnerClip,
  model: BatteryModel,
  chunkConfig: ChunkConfig,
  loadError: string | null,
): SegRecord {
  const ref = loadClipRef(c.id);
  const refText = ref.words.map((w) => w.text).join(' ');
  const dec = werDecomposed(refText, c.words ?? '');
  const refSpanStart = ref.words[0]?.startSec ?? 0;
  const refSpanEnd = ref.words.at(-1)?.startSec ?? 0;
  const inSpan = c.chunks.filter((ch) => ch.start >= refSpanStart && ch.start <= refSpanEnd);
  const decAligned = werDecomposed(refText, inSpan.map((ch) => ch.text).join(' '));
  const refRates = ratesFor({ cues: ref.cues, words: ref.words });
  const hypUnifiedRate = filteredTokensOverTrimmedSpan(parsedFromChunks(c.chunks).cues);
  const sanity = timestampSanity(c.chunks, c.durationSec ?? 60);
  return {
    kind: 'seg',
    ts: new Date().toISOString(),
    videoId: c.id,
    category: ref.category,
    model,
    chunkConfig,
    refWords: ref.words.length,
    segs: c.chunks.length,
    hypSpanStartSec: c.chunks[0]?.start ?? null,
    hypSpanEndSec: c.chunks.at(-1)?.start ?? null,
    S: dec.S,
    D: dec.D,
    I: dec.I,
    wer: dec.wer,
    countBias: dec.countBias,
    refSpanStartSec: refSpanStart,
    refSpanEndSec: refSpanEnd,
    hypSegsInSpan: inSpan.length,
    SAligned: decAligned.S,
    DAligned: decAligned.D,
    IAligned: decAligned.I,
    werAligned: decAligned.wer,
    countBiasAligned: decAligned.countBias,
    refUnifiedRate: refRates?.unifiedRate ?? null,
    hypUnifiedRate,
    rateErrorUnifiedPct: rateErrorPct(hypUnifiedRate, refRates?.unifiedRate ?? null),
    tsMonotonic: c.chunks.length > 1 ? sanity.monotonic : null,
    tsWithinDuration: c.chunks.length ? sanity.withinDuration : null,
    tsLastEndSec: sanity.lastEndSec,
    rtf: c.rtf,
    loadError,
    clipError: c.clipError,
  };
}
