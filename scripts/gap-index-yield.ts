// Gap-index yield for the skip-silence gate: what fraction of a video's
// playing time is skippable by silence under the honest caption-gap
// definition — consecutive cue/word starts ≥ 1 s apart, skimmable = gaps
// ≥ 1.5 s minus 0.5 s each (the residual that survives detector edge slop
// and jump-cut recovery). Verdict: GO when the median engineered savings
// across measured timelines ≥ 12%.
//
// Offline analysis: reads the committed corpus records (ru-corpus.jsonl,
// web-rerun rerun-results.jsonl) and the committed caption payloads
// (scripts/data/web-rerun/web-*.json3, tests/fixtures/real/windows-asr-*
// -trunc.json). The committed payloads are truncated heads (20 events,
// ~30–60 s), so savings are window-relative: skimmable ÷ (last cue end +
// tail margin). Never touches the browser.
//
// Run: bun run scripts/gap-index-yield.ts
// Writes: scripts/data/gap-yield/results.jsonl

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYouTubeJson3, type Segment } from '../lib/captions';
import { medianOf } from './measure-count-gate';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RU_CORPUS = join(ROOT, 'scripts', 'data', 'ru-corpus', 'ru-corpus.jsonl');
const RERUN_RESULTS = join(ROOT, 'scripts', 'data', 'web-rerun', 'rerun-results.jsonl');
const RERUN_DIR = join(ROOT, 'scripts', 'data', 'web-rerun');
const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures', 'real');
const STT_META = join(ROOT, 'scripts', 'data', 'stt-battery', 'meta.jsonl');
const OUT_DIR = join(ROOT, 'scripts', 'data', 'gap-yield');
const OUT_FILE = join(OUT_DIR, 'results.jsonl');

/** Tail after the last cue end: the detector stops at the last caption, so
 * the residual tail is not skippable; the margin keeps the denominator from
 * pretending the video ends at the last cue. Conservative for the GO gate. */
const TAIL_MARGIN_SEC = 10;
/** speechDurationSec's pause convention (lib/wpm.ts): inter-start spans
 * ≥ 1 s are non-speech. Shared, not forked. */
const GAP_FLOOR_SEC = 1;
/** Only gaps long enough to survive a real detector count toward skimmable
 * seconds; each contributes gap − 0.5 (edge slop + jump-cut recovery). */
const SKIM_FLOOR_SEC = 1.5;
const SKIM_DISCOUNT_SEC = 0.5;
const VERDICT_THRESHOLD_PCT = 12;

type Classification = 'web-ok' | 'parse-available' | 'no-timeline';

interface YieldRow {
  videoId: string;
  corpus: 'ru-corpus' | 'web-rerun';
  language: string;
  languageGroup: 'ru' | 'slavic' | 'captionless' | 'en';
  register: string;
  classification: Classification;
  source: 'web-rerun-payload' | 'fixture' | null;
  series: 'words' | 'cues' | null;
  windowSec: number | null;
  fullDurationSec: number | null;
  gapCount: number | null;
  skimmableSec: number | null;
  savingsPct: number | null;
  cuesSeriesSavingsPct: number | null;
}

function languageGroup(language: string): YieldRow['languageGroup'] {
  if (language === 'ru' || language === 'en') return language;
  if (['uk', 'pl', 'cs', 'sr'].includes(language)) return 'slavic';
  return 'captionless';
}

/** Gap index over consecutive starts: count of spans ≥ 1 s and the
 * skimmable residual (spans ≥ 1.5 s minus the per-gap discount). */
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

function lastEndSec(series: Segment[]): number {
  const last = series.at(-1);
  if (!last) return 0;
  return last.startSec + (last.durSec ?? 0);
}

function measure(payload: unknown): {
  series: 'words' | 'cues';
  windowSec: number;
  gapCount: number;
  skimmableSec: number;
  savingsPct: number;
  cuesSavingsPct: number;
} | null {
  const { words, cues } = parseYouTubeJson3(payload);
  const primary = words.length >= 2 ? words : cues;
  if (primary.length < 2) return null;
  const primaryIdx = gapIndex(primary.map((s) => s.startSec));
  const windowSec = lastEndSec(primary) + TAIL_MARGIN_SEC;
  if (windowSec <= 0) return null;
  const cuesIdx = gapIndex(cues.map((s) => s.startSec));
  return {
    series: words.length >= 2 ? 'words' : 'cues',
    windowSec,
    gapCount: primaryIdx.gapCount,
    skimmableSec: primaryIdx.skimmableSec,
    savingsPct: (primaryIdx.skimmableSec / windowSec) * 100,
    cuesSavingsPct: (cuesIdx.skimmableSec / windowSec) * 100,
  };
}

function loadJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Nearest-rank percentile on a sorted array. */
function percentileOf(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index]!;
}

function summarize(label: string, rows: YieldRow[]): void {
  const vals = rows
    .map((r) => r.savingsPct as number)
    .sort((a, b) => a - b);
  const median = medianOf(vals);
  const p90 = percentileOf(vals, 90);
  console.log(
    `${label}: n=${vals.length} median=${median?.toFixed(2) ?? '—'}% p90=${p90?.toFixed(2) ?? '—'}%`,
  );
}

function main(): void {
  const ruRecords = loadJsonl(RU_CORPUS);
  const rerunRecords = loadJsonl(RERUN_RESULTS);
  const fullDurations = new Map(
    loadJsonl(STT_META).map((m) => [m.videoId as string, m.durationSec as number]),
  );

  const payloads = new Map<string, { payload: unknown; source: 'web-rerun-payload' | 'fixture' }>();
  for (const file of readdirSync(RERUN_DIR).filter((f) => f.endsWith('.json3'))) {
    const id = file.replace('web-', '').replace('.json3', '');
    payloads.set(id, {
      payload: JSON.parse(readFileSync(join(RERUN_DIR, file), 'utf8')),
      source: 'web-rerun-payload',
    });
  }
  for (const file of readdirSync(FIXTURES_DIR).filter((f) => f.startsWith('windows-asr-'))) {
    const id = file.replace('windows-asr-', '').replace('-trunc.json', '');
    if (payloads.has(id)) continue;
    payloads.set(id, {
      payload: JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')),
      source: 'fixture',
    });
  }

  const rows: YieldRow[] = [];
  const addRow = (
    record: Record<string, unknown>,
    corpus: 'ru-corpus' | 'web-rerun',
    register: string,
  ): void => {
    const videoId = record.videoId as string;
    const language = (record.language as string) ?? 'en';
    const found = payloads.get(videoId);
    const measured = found ? measure(found.payload) : null;
    const classification: Classification =
      found === undefined ? 'no-timeline' : measured === null ? 'no-timeline' : found.source === 'fixture' ? 'parse-available' : 'web-ok';
    rows.push({
      videoId,
      corpus,
      language,
      languageGroup: languageGroup(language),
      register,
      classification,
      source: found?.source ?? null,
      series: measured?.series ?? null,
      windowSec: measured?.windowSec ?? null,
      fullDurationSec: fullDurations.get(videoId) ?? (record.durationSec as number) ?? null,
      gapCount: measured?.gapCount ?? null,
      skimmableSec: measured ? Math.round(measured.skimmableSec * 100) / 100 : null,
      savingsPct: measured ? Math.round(measured.savingsPct * 100) / 100 : null,
      cuesSeriesSavingsPct: measured ? Math.round(measured.cuesSavingsPct * 100) / 100 : null,
    });
  };

  for (const record of ruRecords) addRow(record, 'ru-corpus', record.register as string);
  for (const record of rerunRecords) {
    addRow(record, 'web-rerun', record.category as string);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const measured = rows.filter((r) => r.savingsPct !== null);
  const countBy = (corpus: 'ru-corpus' | 'web-rerun', c: Classification): number =>
    rows.filter((r) => r.corpus === corpus && r.classification === c).length;

  console.log('Coverage:');
  console.log(`  ru-corpus: ${ruRecords.length} records, ${countBy('ru-corpus', 'no-timeline')} no-timeline, ${countBy('ru-corpus', 'parse-available')} parse-available (fixture), ${countBy('ru-corpus', 'web-ok')} web-ok`);
  console.log(`  web-rerun: ${rerunRecords.length} records, ${countBy('web-rerun', 'web-ok')} web-ok, ${countBy('web-rerun', 'no-timeline')} no-timeline`);
  console.log(`  measured timelines: ${measured.length} (${rows.filter((r) => r.classification === 'web-ok').length} web-ok + ${rows.filter((r) => r.classification === 'parse-available').length} parse-available)`);

  summarize('Overall (all registers)', measured);
  for (const register of [...new Set(measured.map((r) => r.register))].sort()) {
    summarize(`  register=${register}`, measured.filter((r) => r.register === register));
  }
  for (const group of ['ru', 'slavic', 'captionless', 'en'] as const) {
    summarize(`  languageGroup=${group}`, measured.filter((r) => r.languageGroup === group));
  }
  summarize('Speech registers (excl. music)', measured.filter((r) => r.register !== 'music'));

  const median = medianOf(measured.map((r) => r.savingsPct as number).sort((a, b) => a - b));
  console.log(
    `Verdict: ${median !== null && median >= VERDICT_THRESHOLD_PCT ? 'GO' : 'NO-GO'} ` +
      `(median ${median?.toFixed(2) ?? '—'}% vs ${VERDICT_THRESHOLD_PCT}% threshold)`,
  );
  console.log(`Wrote ${OUT_FILE} (${rows.length} rows)`);
}

main();
