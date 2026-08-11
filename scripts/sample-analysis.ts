// Analysis and reporting for the caption-WPM sample run. Shared by
// scripts/sample-captions.ts (live run) and the --analyze re-run mode.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedCaptions } from '../lib/captions';
import {
  correctedCueLevelWpm,
  countWords,
  cueLevelWpm,
  cueSpanSec,
  estimateSpeechDurationSec,
  totalWords,
  wordLevelWpm,
} from '../lib/wpm';

export interface AnalyzedStats {
  nCues: number | null;
  nWordsTimed: number | null;
  textTokens: number | null;
  icuTokens: number | null;
  tokenDeltaPct: number | null;
  coveragePct: number | null;
  spanSec: number | null;
  speechEstSec: number | null;
  wordWpm: number | null;
  cueWpm: number | null;
  cueWpmCorrected: number | null;
  monotonicPct: number | null;
  nBracketMarkers: number | null;
  firstCue: string | null;
  lastCue: string | null;
}

export interface SampleRecord extends AnalyzedStats {
  videoId: string;
  url: string;
  category: string;
  status: 'ok' | 'error';
  error: string | null;
  landedUrl: string;
  title: string | null;
  kind: string | null;
  lang: string | null;
  trackCount: number | null;
  webTrackCount: number | null;
  webAsrCount: number | null;
  webManualCount: number | null;
}

export interface FixtureSlot {
  file: string;
  preferred?: string;
  needsWords?: boolean;
  needsMusic?: boolean;
}

export const FIXTURE_SLOTS: FixtureSlot[] = [
  { file: 'asr-word.json', needsWords: true, preferred: 'iG9CE55wbtY' },
  { file: 'manual-cue.json', needsWords: false, preferred: 'qp0HIF3SfI4' },
  { file: 'music.json', needsMusic: true, preferred: '60ItHLz5WEA' },
];

const segmenter: Intl.Segmenter | null =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'word' })
    : null;

function icuWordCount(text: string): number | null {
  if (!segmenter) return null;
  let n = 0;
  for (const seg of segmenter.segment(text)) {
    if (seg.isWordLike) n += 1;
  }
  return n;
}

function monotonicPct(cues: { startSec: number }[]): number | null {
  if (cues.length < 2) return null;
  let inRange = 0;
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1];
    const cur = cues[i];
    if (prev !== undefined && cur !== undefined) {
      const delta = cur.startSec - prev.startSec;
      if (delta >= -1 && delta <= 30) inRange += 1;
    }
  }
  return (inRange / (cues.length - 1)) * 100;
}

function fullText(parsed: ParsedCaptions): string {
  if (parsed.cues.length > 0) {
    return parsed.cues.map((c) => c.text).join(' ');
  }
  return parsed.words.map((w) => w.text).join(' ');
}

export function analyze(parsed: ParsedCaptions): AnalyzedStats {
  const text = fullText(parsed);
  const textTokens = countWords(text);
  const icuTokens = icuWordCount(text);
  const nWordsTimed = totalWords(parsed.words);
  const first = parsed.cues[0];
  const last = parsed.cues.at(-1);
  return {
    nCues: parsed.cues.length,
    nWordsTimed,
    textTokens,
    icuTokens,
    tokenDeltaPct:
      icuTokens !== null && icuTokens > 0
        ? ((textTokens - icuTokens) / icuTokens) * 100
        : null,
    coveragePct: textTokens > 0 ? (nWordsTimed / textTokens) * 100 : null,
    spanSec: cueSpanSec(parsed.cues),
    speechEstSec: estimateSpeechDurationSec(parsed.cues),
    wordWpm: wordLevelWpm(parsed.words),
    cueWpm: cueLevelWpm(parsed.cues),
    cueWpmCorrected: correctedCueLevelWpm(parsed.cues),
    monotonicPct: monotonicPct(parsed.cues),
    nBracketMarkers: (text.match(/\[[^\]]+\]/g) ?? []).length,
    firstCue: first ? first.text.slice(0, 120) : null,
    lastCue: last ? last.text.slice(0, 120) : null,
  };
}

export function parseFromJsonl(line: string): SampleRecord {
  return JSON.parse(line) as SampleRecord;
}

export function analyzeExisting(resultsFile: string): void {
  const lines = readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean);
  printReport(lines.map(parseFromJsonl));
}

export function saveFixtures(
  results: SampleRecord[],
  payloads: Map<string, unknown>,
  fixturesDir: string,
): void {
  const slots = FIXTURE_SLOTS.map((slot) => ({ ...slot }));
  for (const video of results) {
    if (video.status !== 'ok') continue;
    if (slots.length === 0) break;
    const fits = (s: FixtureSlot): boolean =>
      (s.needsWords === undefined || (s.needsWords === true) === ((video.nWordsTimed ?? 0) > 0)) &&
      (s.needsMusic === undefined || s.needsMusic === (video.category === 'music'));
    const preferred = slots.find((s) => s.preferred === video.videoId && fits(s));
    const fallback = slots.find((s) => fits(s));
    const chosen = preferred ?? fallback;
    if (!chosen) continue;
    slots.splice(slots.indexOf(chosen), 1);
    const raw = payloads.get(video.videoId);
    if (raw === undefined) continue;
    writeFileSync(
      join(fixturesDir, chosen.file),
      JSON.stringify(truncateForFixture(raw), null, 1),
      'utf8',
    );
    console.log(`fixture ${chosen.file} <- ${video.videoId} (${video.kind})`);
  }
  if (slots.length > 0) {
    console.warn(`WARNING: ${slots.length} fixture slots unfilled`);
  }
}

function truncateForFixture(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return json;
  const record = json as Record<string, unknown>;
  return {
    ...record,
    events: Array.isArray(record.events) ? record.events.slice(0, 20) : [],
    windows: Array.isArray(record.windows) ? record.windows.slice(0, 12) : [],
  };
}

export function printReport(results: SampleRecord[]): void {
  const ok = results.filter((r) => r.status === 'ok');
  const withWords = ok.filter((r) => (r.nWordsTimed ?? 0) > 0);
  const withCues = ok.filter((r) => (r.nCues ?? 0) > 0);
  const errors = results.filter((r) => r.status === 'error');

  console.log(`\n=== SUMMARY (n=${results.length}) ===`);
  console.log(
    `ok=${ok.length} word-level=${withWords.length} cue-level=${withCues.length} errors=${errors.length}`,
  );
  console.log(
    `word-level availability: ${withWords.length}/${ok.length} = ${
      ok.length > 0 ? ((withWords.length / ok.length) * 100).toFixed(1) : 'n/a'
    }% of loaded videos (GATE >=90%: ${withWords.length / ok.length >= 0.9 ? 'PASS' : 'FAIL'})`,
  );
  console.log(
    `cue-level availability: ${withCues.length}/${ok.length} = ${
      ok.length > 0 ? ((withCues.length / ok.length) * 100).toFixed(1) : 'n/a'
    }%`,
  );

  console.log(`\n=== PER-VIDEO (cue-level wpm) ===`);
  console.log('videoId       category     cueWpm   corrected  spanSec  nCues  nWords');
  for (const r of ok) {
    console.log(
      `${r.videoId.padEnd(14)} ${r.category.padEnd(12)} ${(r.cueWpm ?? 0).toFixed(1).padStart(7)} ${(r.cueWpmCorrected ?? 0).toFixed(1).padStart(9)} ${(r.spanSec ?? 0).toFixed(0).padStart(7)} ${String(r.nCues).padStart(6)} ${String(r.textTokens).padStart(6)}`,
    );
  }

  const spread = ok.filter((r) => r.cueWpm !== null && r.cueWpmCorrected !== null);
  if (spread.length > 0) {
    const naiveAvg = spread.reduce((s, r) => s + (r.cueWpm ?? 0), 0) / spread.length;
    const correctedAvg =
      spread.reduce((s, r) => s + (r.cueWpmCorrected ?? 0), 0) / spread.length;
    console.log(
      `\nmean naive cue wpm=${naiveAvg.toFixed(1)} mean corrected=${correctedAvg.toFixed(1)} ` +
        `silence-bias=${(((correctedAvg - naiveAvg) / naiveAvg) * 100).toFixed(1)}%`,
    );
  }

  const both = ok.filter((r) => r.wordWpm !== null && r.cueWpm !== null);
  console.log(`\n=== WORD vs CUE SPREAD (n=${both.length}) ===`);
  console.log('videoId       category     wordWpm  cueWpm   d%');
  for (const r of both) {
    if (r.wordWpm === null || r.cueWpm === null) continue;
    const d = ((r.cueWpm - r.wordWpm) / r.wordWpm) * 100;
    console.log(
      `${r.videoId.padEnd(14)} ${r.category.padEnd(12)} ${r.wordWpm.toFixed(1).padStart(7)} ${r.cueWpm.toFixed(1).padStart(7)} ${d.toFixed(1).padStart(6)}`,
    );
  }

  const accurate = ok.filter((r) => r.icuTokens !== null && r.icuTokens > 0);
  console.log(`\n=== COUNT ACCURACY (regex vs ICU, n=${accurate.length}) ===`);
  console.log('videoId       category     regex  icu   delta%');
  for (const r of accurate.slice(0, 10)) {
    console.log(
      `${r.videoId.padEnd(14)} ${r.category.padEnd(12)} ${String(r.textTokens).padStart(5)} ${String(r.icuTokens).padStart(5)} ${(r.tokenDeltaPct ?? 0).toFixed(2).padStart(7)}`,
    );
  }

  console.log(`\n=== ERRORS ===`);
  for (const r of errors) {
    console.log(`${r.videoId} [${r.category}] ${r.error}`);
  }

  console.log(`\n=== WORD-LEVEL SCAN ===`);
  for (const r of ok) {
    console.log(
      `${r.videoId} [${r.category}] nWordsTimed=${r.nWordsTimed} coverage=${(r.coveragePct ?? 0).toFixed(1)}% monotonic=${(r.monotonicPct ?? 0).toFixed(1)}%`,
    );
  }
}
