// Whole-video gap-index yield for the skip-silence gate: the re-measurement
// that closes the head-window caveat of scripts/gap-index-yield.ts. Consumes
// the full caption timelines committed by measure-corpus.ts --gap-full
// (scripts/data/gap-full/*.json — the production parseYouTubeJson3 output)
// and computes WHOLE-VIDEO savings: skimmableSec = Σ(gap ≥ 1.5 s minus 0.5 s
// each) over the full duration, savings % = skimmableSec ÷ video duration
// (the player's lengthSeconds). The 1 s gap convention is speechDurationSec's
// (lib/wpm.ts) and the 1.5/0.5 skimmable rule is gap-index-yield.ts's —
// shared, not forked. Verdict: GO when the median ≥ 12%, the same threshold
// as the head-window gate.
//
// Run: bun run scripts/gap-index-yield-full.ts
// Writes: scripts/data/gap-yield/full-results.jsonl

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYouTubeJson3, type Segment } from '../lib/captions';
import { medianOf } from './measure-count-gate';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GAP_FULL_DIR = join(ROOT, 'scripts', 'data', 'gap-full');
const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures', 'real');
const OUT_DIR = join(ROOT, 'scripts', 'data', 'gap-yield');
const OUT_FILE = join(OUT_DIR, 'full-results.jsonl');

/** speechDurationSec's pause convention (lib/wpm.ts): inter-start spans
 * ≥ 1 s are non-speech. Shared with gap-index-yield.ts, not forked. */
const GAP_FLOOR_SEC = 1;
/** Only gaps long enough to survive a real detector count toward skimmable
 * seconds; each contributes gap − 0.5 (edge slop + jump-cut recovery). Same
 * rule as gap-index-yield.ts. */
const SKIM_FLOOR_SEC = 1.5;
const SKIM_DISCOUNT_SEC = 0.5;
const VERDICT_THRESHOLD_PCT = 12;
/** Head-window tail margin (gap-index-yield.ts): the detector stops at the
 * last caption, so the residual tail is not skippable. */
const TAIL_MARGIN_SEC = 10;

/** A committed full-timeline sidecar (measure-corpus.ts --gap-full). */
interface FullTimeline {
  videoId: string;
  title: string | null;
  language: string;
  register: string;
  captureDate: string;
  durationSec: number | null;
  webBytes: number | null;
  words: Segment[];
  cues: Segment[];
}

interface FullYieldRow {
  videoId: string;
  language: string;
  languageGroup: 'ru' | 'slavic' | 'en' | 'captionless';
  register: string;
  series: 'words' | 'cues';
  durationSec: number;
  gapCount: number;
  skimmableSec: number;
  savingsPct: number;
  cuesSeriesSavingsPct: number | null;
}

function languageGroup(language: string): FullYieldRow['languageGroup'] {
  if (language === 'ru' || language === 'en') return language;
  if (['uk', 'pl', 'cs', 'sr'].includes(language)) return 'slavic';
  return 'captionless';
}

/** Gap index over consecutive starts: count of spans ≥ 1 s and the
 * skimmable residual (spans ≥ 1.5 s minus the per-gap discount). Same
 * definition as gap-index-yield.ts. */
function gapIndex(starts: number[]): { gapCount: number; skimmableSec: number } {
  let gapCount = 0;
  let skimmableSec = 0;
  for (let i = 0; i < starts.length - 1; i++) {
    const gap = starts[i + 1]! - starts[i]!;
    if (gap >= GAP_FLOOR_SEC) gapCount++;
    if (gap >= SKIM_FLOOR_SEC) skimmableSec += gap - SKIM_DISCOUNT_SEC;
  }
  return { gapCount, skimmableSec };
}

/** Whole-video measure over a committed full timeline. */
function measureFull(t: FullTimeline): {
  series: 'words' | 'cues';
  gapCount: number;
  skimmableSec: number;
  savingsPct: number;
  cuesSavingsPct: number | null;
} | null {
  if (t.durationSec === null || t.durationSec <= 0) return null;
  const primary = t.words.length >= 2 ? t.words : t.cues;
  if (primary.length < 2) return null;
  const idx = gapIndex(primary.map((s) => s.startSec));
  const cuesIdx = t.cues.length >= 2 ? gapIndex(t.cues.map((s) => s.startSec)) : null;
  return {
    series: t.words.length >= 2 ? 'words' : 'cues',
    gapCount: idx.gapCount,
    skimmableSec: idx.skimmableSec,
    savingsPct: (idx.skimmableSec / t.durationSec) * 100,
    cuesSavingsPct: cuesIdx === null ? null : (cuesIdx.skimmableSec / t.durationSec) * 100,
  };
}

/** Head-window measure for the same-video caveat check: the old
 * window-relative definition (last cue end + tail margin) over a committed
 * truncated fixture. */
function measureHead(payload: unknown): number | null {
  const { words, cues } = parseYouTubeJson3(payload);
  const primary = words.length >= 2 ? words : cues;
  if (primary.length < 2) return null;
  const last = primary.at(-1)!;
  const windowSec = last.startSec + (last.durSec ?? 0) + TAIL_MARGIN_SEC;
  if (windowSec <= 0) return null;
  const idx = gapIndex(primary.map((s) => s.startSec));
  return (idx.skimmableSec / windowSec) * 100;
}

/** Nearest-rank percentile on a sorted array. */
function percentileOf(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index]!;
}

function summarize(
  label: string,
  rows: FullYieldRow[],
  series: 'words' | 'cues' = 'words',
): void {
  const vals = rows
    .map((r) => (series === 'words' ? r.savingsPct : r.cuesSeriesSavingsPct))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const median = medianOf(vals);
  const p90 = percentileOf(vals, 90);
  console.log(
    `${label}: n=${vals.length} median=${median?.toFixed(2) ?? '—'}% p90=${p90?.toFixed(2) ?? '—'}%`,
  );
}

function main(): void {
  const files = readdirSync(GAP_FULL_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.error(`no full timelines in ${GAP_FULL_DIR} (run measure-corpus.ts --gap-full first)`);
    process.exit(2);
  }
  const timelines = files
    .map((f) => JSON.parse(readFileSync(join(GAP_FULL_DIR, f), 'utf8')) as FullTimeline)
    .sort((a, b) => a.videoId.localeCompare(b.videoId));

  const rows: FullYieldRow[] = [];
  for (const t of timelines) {
    const m = measureFull(t);
    if (m === null) {
      console.warn(
        `skip ${t.videoId}: ${t.durationSec === null ? 'no durationSec' : 'fewer than 2 starts'}`,
      );
      continue;
    }
    rows.push({
      videoId: t.videoId,
      language: t.language,
      languageGroup: languageGroup(t.language),
      register: t.register,
      series: m.series,
      durationSec: t.durationSec!,
      gapCount: m.gapCount,
      skimmableSec: Math.round(m.skimmableSec * 100) / 100,
      savingsPct: Math.round(m.savingsPct * 100) / 100,
      cuesSeriesSavingsPct:
        m.cuesSavingsPct === null ? null : Math.round(m.cuesSavingsPct * 100) / 100,
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  console.log('Whole-video gap yield (words series = speech-only, markers excluded):');
  for (const r of rows) {
    console.log(
      `  ${r.videoId} ${r.language}:${r.register} dur=${r.durationSec.toFixed(0)}s ` +
        `skimmable=${r.skimmableSec}s = ${r.savingsPct.toFixed(2)}% (cues ${r.cuesSeriesSavingsPct?.toFixed(2) ?? '—'}%)`,
    );
  }

  summarize('Overall', rows);
  for (const register of [...new Set(rows.map((r) => r.register))].sort()) {
    summarize(`  register=${register}`, rows.filter((r) => r.register === register));
  }
  for (const group of ['ru', 'slavic', 'en', 'captionless'] as const) {
    const grp = rows.filter((r) => r.languageGroup === group);
    if (grp.length > 0) summarize(`  languageGroup=${group}`, grp);
  }
  summarize('Cues series (marker-led music gaps included)', rows, 'cues');

  const fixturePath = join(FIXTURES_DIR, 'windows-asr--rg9mV6DBl4-trunc.json');
  const headPct = measureHead(JSON.parse(readFileSync(fixturePath, 'utf8')));
  const fullRow = rows.find((r) => r.videoId === '-rg9mV6DBl4');
  if (headPct !== null && fullRow !== undefined) {
    console.log(
      `Same-video head-vs-full (-rg9mV6DBl4): head window ${headPct.toFixed(2)}% vs ` +
        `whole video ${fullRow.savingsPct.toFixed(2)}%`,
    );
  }

  const median = medianOf(rows.map((r) => r.savingsPct as number).sort((a, b) => a - b));
  console.log(
    `Verdict: ${median !== null && median >= VERDICT_THRESHOLD_PCT ? 'GO' : 'NO-GO'} ` +
      `(median ${median?.toFixed(2) ?? '—'}% vs ${VERDICT_THRESHOLD_PCT}% threshold)`,
  );
  console.log(`Wrote ${OUT_FILE} (${rows.length} rows)`);
}

main();
