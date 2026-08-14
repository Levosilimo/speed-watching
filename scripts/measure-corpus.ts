// Russian caption-rate corpus measurement (spec: .slim/deepwork/specs/ru-corpus.md).
// Orchestrates the capture pass (scripts/measure-capture.ts) over the
// manifest, computes per-language G1–G5 gates (scripts/measure-analysis.ts),
// and writes scripts/data/ru-corpus/ru-corpus.jsonl + a gate summary.
//
// Run: bun run scripts/measure-corpus.ts [--lang=ru|uk|pl|all] [--video=ID]
//      [--limit=N] [--headed] [--no-fixtures] [--fixture-anchor=ID]
//
// Re-runs merge by videoId, so a failed video can be re-measured alone
// (--video=ID); structural failures print the fallback-pool substitution
// list from the spec.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext } from 'playwright';
import { truncateForFixture } from './sample-analysis';
import {
  fillWithinBand,
  printLangSummary,
  printVerdict,
  summarizeLang,
  type CorpusRecord,
  type CorpusVideo,
  type GateSummary,
} from './measure-analysis';
import { measureVideo, setupBrowser } from './measure-capture';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST = join(ROOT, 'data', 'corpus-ru.json');
const OUT_DIR = join(ROOT, 'data', 'ru-corpus');
const RESULTS_FILE = join(OUT_DIR, 'ru-corpus.jsonl');
const SUMMARY_FILE = join(OUT_DIR, 'ru-corpus-summary.json');
const FIXTURES_DIR = join(ROOT, '..', 'tests', 'fixtures', 'real');
const PAGE_PACE_MS = 2500;

/** Spec fallback pools (same register, verified ru:asr), used only as
 * substitution suggestions on structural failures. */
const FALLBACKS: Record<string, string[]> = {
  lecture: ['EzETovF1wJY', 'Q655Siyo9h4', '7f2e5JmpJiM', 'foG2it4Rc6Q'],
  explainer: ['ecjRPDIA7Sk', 'cfyy1MS_3MM', 'KxFdjF2CtWM'],
  news: ['v1iE15hsi0g', 'D_zdrb5Cb8A', 'Kj8me2dVMD4', '5MuETqZfLCw'],
  podcast: ['Apc-4g-WBkA', '-DrcvHJ_MU8'],
  music: ['3KQGqWYd_-g', 'uiPM4QToPBA'],
};

function loadManifest(): CorpusVideo[] {
  const rows = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Array<{
    videoId: string;
    register: string;
    title?: string;
    language?: string;
  }>;
  return rows.map((row) => ({
    videoId: row.videoId,
    register: row.register,
    title: row.title ?? '',
    language: row.language ?? 'ru',
  }));
}

function recordLine(record: CorpusRecord): string {
  if (record.classification === 'web-ok') {
    const parity =
      record.wordsParity === null && record.cuesParity === null
        ? '-'
        : `${String(record.wordsParity)}/${String(record.cuesParity)}`;
    return (
      `web-ok words=${record.windowsWords} cues=${record.windowsCues} ` +
      `rate=${(record.unifiedRate ?? 0).toFixed(1)} lang=${record.asrLang ?? '-'} parity=${parity}`
    );
  }
  return `${record.classification}${record.error ? ` (${record.error})` : ''}`;
}

function printSubstitutions(records: CorpusRecord[]): void {
  const failed = records.filter((r) =>
    ['geo-block', 'pot-fail', 'no-track', 'manual-only', 'wrong-lang'].includes(
      r.classification,
    ),
  );
  if (failed.length === 0) return;
  console.log('\n=== SUBSTITUTION NEEDED (structural fail or missing ASR) ===');
  for (const r of failed) {
    const pool = FALLBACKS[r.register] ?? [];
    console.log(
      `  ${r.videoId} [${r.register}] ${r.classification} (${r.error ?? ''}) -> fallback: ${pool.join(', ') || 'none'}`,
    );
  }
}

/** The one committed ru transcript fixture: truncated to 20 events, plus a
 * provenance row (copyright stays with the creators). */
function emitParityAnchor(record: CorpusRecord, webJson: unknown): void {
  const file = `windows-asr-${record.videoId}-trunc.json`;
  const truncated = truncateForFixture(webJson);
  writeFileSync(join(FIXTURES_DIR, file), JSON.stringify(truncated, null, 1), 'utf8');
  const readmePath = join(FIXTURES_DIR, '..', 'README.md');
  const text = readFileSync(readmePath, 'utf8').replace(
    '(scripts/sample-captions.ts)',
    '(scripts/sample-captions.ts, scripts/measure-corpus.ts)',
  );
  const row =
    `| ${file} | ${record.videoId} | ${(record.title ?? '?').replace(/\|/g, '/')} | ${record.captureDate} | ` +
    `player-signed intercept (page.on('response'), CC toggled on) | ${record.webBytes ?? '-'} | ${JSON.stringify(truncated).length} | ` +
    `ru word timing parsing (words > 0 on a real ru WEB payload); windows==segs cue parity (ru-corpus G4 anchor) |`;
  writeFileSync(readmePath, `${text.trimEnd()}\n${row}\n`, 'utf8');
  console.log(`fixture anchor ${file} + provenance row -> ${readmePath}`);
}

function loadPriorRecords(): Map<string, CorpusRecord> {
  if (!existsSync(RESULTS_FILE)) return new Map();
  const records = readFileSync(RESULTS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRecord);
  return new Map(records.map((record) => [record.videoId, record]));
}

function writeResults(
  all: CorpusRecord[],
  summaries: GateSummary[],
  runRecords: CorpusRecord[],
): void {
  fillWithinBand(all);
  writeFileSync(RESULTS_FILE, all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`\nrecords -> ${RESULTS_FILE} (${all.length} total, ${runRecords.length} this run)`);
  writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 2), 'utf8');
}

async function runVideos(
  context: BrowserContext,
  videos: CorpusVideo[],
): Promise<{ records: CorpusRecord[]; webPayloads: Map<string, unknown> }> {
  const records: CorpusRecord[] = [];
  const webPayloads = new Map<string, unknown>();
  for (const video of videos) {
    process.stdout.write(`measure ${video.videoId} [${video.language}:${video.register}] ... `);
    const { record, webJson } = await measureVideo(context, video);
    if (webJson !== null) webPayloads.set(video.videoId, webJson);
    records.push(record);
    console.log(recordLine(record));
    await new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
  }
  return { records, webPayloads };
}

function emitAnchorIfRequested(
  all: CorpusRecord[],
  webPayloads: Map<string, unknown>,
  fixtureAnchor: string | undefined,
  noFixtures: boolean,
): void {
  const anchorId =
    fixtureAnchor ??
    all.find((r) => r.language === 'ru' && r.classification === 'web-ok')?.videoId;
  if (noFixtures || anchorId === undefined) return;
  const anchor = all.find((r) => r.videoId === anchorId);
  const payload = webPayloads.get(anchorId);
  if (anchor !== undefined && anchor.classification === 'web-ok' && payload !== undefined) {
    emitParityAnchor(anchor, payload);
  } else if (fixtureAnchor !== undefined) {
    console.warn(`fixture anchor ${anchorId} not web-ok in this run; skipping`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const noFixtures = args.includes('--no-fixtures');
  const fixtureAnchor = args
    .find((a) => a.startsWith('--fixture-anchor='))
    ?.slice('--fixture-anchor='.length);
  const langArg = args.find((a) => a.startsWith('--lang='))?.slice('--lang='.length) ?? 'all';
  const videoArg = args.find((a) => a.startsWith('--video='))?.slice('--video='.length);
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && !Number.isFinite(limit)) {
    console.error('--limit must be a number');
    process.exit(2);
  }
  const langs = langArg === 'all' ? ['ru', 'uk', 'pl'] : langArg.split(',');

  let videos = loadManifest().filter((v) => langs.includes(v.language));
  if (videoArg !== undefined) videos = videos.filter((v) => v.videoId === videoArg);
  if (limit !== undefined) videos = videos.slice(0, limit);
  if (videos.length === 0) {
    console.error('no videos to measure');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
  console.log(`measure-corpus: ${videos.length} video(s), langs=${langs.join(',')}, headed=${headed}`);

  const { browser, context } = await setupBrowser(headed);
  let runRecords: CorpusRecord[] = [];
  let webPayloads = new Map<string, unknown>();
  try {
    ({ records: runRecords, webPayloads } = await runVideos(context, videos));
  } finally {
    await browser.close();
  }

  const prior = loadPriorRecords();
  for (const record of runRecords) prior.set(record.videoId, record);
  const all = [...prior.values()];
  const summaries = langs.map((l) => summarizeLang(all, l));
  writeResults(all, summaries, runRecords);
  for (const summary of summaries) printLangSummary(summary);
  printVerdict(summaries);
  printSubstitutions(runRecords);
  emitAnchorIfRequested(all, webPayloads, fixtureAnchor, noFixtures);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
