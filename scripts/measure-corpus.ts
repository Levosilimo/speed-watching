// Russian caption-rate corpus measurement (spec: .slim/deepwork/specs/ru-corpus.md).
// Orchestrates the capture pass (scripts/measure-capture.ts) over the
// manifest, computes per-language G1–G5 gates (scripts/measure-analysis.ts),
// and writes scripts/data/ru-corpus/ru-corpus.jsonl + a gate summary.
//
// Run: bun run scripts/measure-corpus.ts [--lang=ru|uk|pl|cs|sr|hi|ar|id|vi|all]
//      [--video=ID] [--limit=N] [--headed] [--no-fixtures]
//      [--fixture-anchor=ID] [--manifest=corpus-b.json]
//
// Re-runs merge by videoId, so a failed video can be re-measured alone
// (--video=ID); structural failures print the fallback-pool substitution
// list from the manifest's per-language pools.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext } from 'playwright';
import { parseYouTubeJson3 } from '../lib/captions';
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
const DEFAULT_MANIFEST = 'corpus-ru.json';
const OUT_DIR = join(ROOT, 'data', 'ru-corpus');
const RESULTS_FILE = join(OUT_DIR, 'ru-corpus.jsonl');
const SUMMARY_FILE = join(OUT_DIR, 'ru-corpus-summary.json');
const FIXTURES_DIR = join(ROOT, '..', 'tests', 'fixtures', 'real');
const GAP_FULL_DIR = join(ROOT, 'data', 'gap-full');
const GAP_FULL_README = join(GAP_FULL_DIR, 'README.md');
const PAGE_PACE_MS = 2500;

/** Legacy ru fallback pools (same register, verified ru:asr), used only as
 * substitution suggestions on structural failures for manifests without
 * their own pools. */
const FALLBACKS: Record<string, string[]> = {
  lecture: ['EzETovF1wJY', 'Q655Siyo9h4', '7f2e5JmpJiM', 'foG2it4Rc6Q'],
  explainer: ['ecjRPDIA7Sk', 'cfyy1MS_3MM', 'KxFdjF2CtWM'],
  news: ['v1iE15hsi0g', 'D_zdrb5Cb8A', 'Kj8me2dVMD4', '5MuETqZfLCw'],
  podcast: ['Apc-4g-WBkA', '-DrcvHJ_MU8'],
  music: ['3KQGqWYd_-g', 'uiPM4QToPBA'],
};

/** Manifest shape: a bare array of video rows (ru-corpus.json), or
 * { videos, fallbacks } where fallbacks maps 'lang:register' → candidate
 * pools for structural-failure substitution (corpus-b.json). */
function loadManifest(manifestPath: string): {
  videos: CorpusVideo[];
  fallbacks: Map<string, string[]>;
} {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as
    | Array<{ videoId: string; register: string; title?: string; language?: string; provenance?: string }>
    | {
        videos: Array<{ videoId: string; register: string; title?: string; language?: string; provenance?: string }>;
        fallbacks?: Record<string, string[]>;
      };
  const rows = Array.isArray(raw) ? raw : raw.videos;
  const fallbacks = new Map<string, string[]>();
  if (!Array.isArray(raw) && raw.fallbacks !== undefined) {
    for (const [key, ids] of Object.entries(raw.fallbacks)) fallbacks.set(key, ids);
  }
  return {
    videos: rows.map((row) => ({
      videoId: row.videoId,
      register: row.register,
      title: row.title ?? '',
      language: row.language ?? 'ru',
      provenance: row.provenance,
    })),
    fallbacks,
  };
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

function printSubstitutions(records: CorpusRecord[], fallbacks: Map<string, string[]>): void {
  const failed = records.filter((r) =>
    ['geo-block', 'pot-fail', 'no-track', 'manual-only', 'wrong-lang'].includes(
      r.classification,
    ),
  );
  if (failed.length === 0) return;
  console.log('\n=== SUBSTITUTION NEEDED (structural fail or missing ASR) ===');
  for (const r of failed) {
    const pool =
      fallbacks.get(`${r.language}:${r.register}`) ?? FALLBACKS[r.register] ?? [];
    console.log(
      `  ${r.videoId} [${r.language}:${r.register}] ${r.classification} (${r.error ?? ''}) -> fallback: ${pool.join(', ') || 'none'}`,
    );
  }
}

/** Full-timeline sidecars (--gap-full): the production parseYouTubeJson3
 * output for every web-ok record — words + cues over the WHOLE video, the
 * gap-yield re-measurement's analysis input. The raw payloads (up to ~3.8
 * MB) are not committed; only the parsed timeline + metadata. The README
 * regenerates from the sidecar set so re-runs stay consistent. */
function emitFullTimelines(
  records: CorpusRecord[],
  webPayloads: Map<string, unknown>,
): void {
  const webOk = records.filter((r) => r.classification === 'web-ok');
  if (webOk.length === 0) return;
  mkdirSync(GAP_FULL_DIR, { recursive: true });
  for (const record of webOk) {
    const payload = webPayloads.get(record.videoId);
    if (payload === undefined) continue;
    const parsed = parseYouTubeJson3(payload);
    const file = `${record.videoId}.json`;
    writeFileSync(
      join(GAP_FULL_DIR, file),
      JSON.stringify({
        videoId: record.videoId,
        title: record.title,
        language: record.language,
        register: record.register,
        captureDate: record.captureDate,
        durationSec: record.durationSec,
        webBytes: record.webBytes,
        words: parsed.words,
        cues: parsed.cues,
      }),
      'utf8',
    );
    record.fullTimeline = `gap-full/${file}`;
    console.log(
      `full timeline -> ${join(GAP_FULL_DIR, file)} (${parsed.words.length} words, ${parsed.cues.length} cues)`,
    );
  }
  const sidecars = readdirSync(GAP_FULL_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (sidecars.length === 0) return;
  const header = [
    '# Full caption timelines — provenance (gap-yield re-measurement)',
    '',
    'Captured 2026-08-14 from a residential IP via the POT-aware harness',
    '(scripts/measure-corpus.ts --gap-full): the player’s signed',
    '/api/timedtext response with CC toggled on and the lang ASR track',
    're-picked (largest word-timed capture across re-picks). Each file holds',
    'the production parseYouTubeJson3 output (words + cues) for the whole',
    'video — the raw payloads (up to ~3.8 MB) are not committed, and these',
    'are not the truncated heads the fixtures use. The captions are the',
    'work of their creators; copyright remains with them.',
    '',
    '| file | videoId | title | capture date | words | cues | durationSec | webBytes |',
    '|---|---|---|---|---|---|---|---|',
  ].join('\n');
  const rows = sidecars.map((f) => {
    const s = JSON.parse(readFileSync(join(GAP_FULL_DIR, f), 'utf8')) as {
      videoId: string;
      title: string | null;
      captureDate: string;
      durationSec: number | null;
      webBytes: number | null;
      words: unknown[];
      cues: unknown[];
    };
    return (
      `| ${f} | ${s.videoId} | ${(s.title ?? '?').replace(/\|/g, '/')} | ${s.captureDate} | ` +
      `${s.words.length} | ${s.cues.length} | ${s.durationSec ?? '?'} | ${s.webBytes ?? '-'} |`
    );
  });
  writeFileSync(GAP_FULL_README, `${header}\n${rows.join('\n')}\n`, 'utf8');
  console.log(`provenance README -> ${GAP_FULL_README} (${sidecars.length} sidecars)`);
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
  const gapFull = args.includes('--gap-full');
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
  const manifestArg = args.find((a) => a.startsWith('--manifest='))?.slice('--manifest='.length);
  const manifestPath = join(ROOT, 'data', manifestArg ?? DEFAULT_MANIFEST);
  const langs = langArg === 'all' ? ['ru', 'uk', 'pl', 'cs', 'sr', 'hi', 'ar', 'id', 'vi', 'ja', 'th', 'ko'] : langArg.split(',');

  const { videos: manifestVideos, fallbacks } = loadManifest(manifestPath);
  let videos = manifestVideos.filter((v) => langs.includes(v.language));
  if (videoArg !== undefined) videos = videos.filter((v) => v.videoId === videoArg);
  if (limit !== undefined) videos = videos.slice(0, limit);
  if (videos.length === 0) {
    console.error('no videos to measure');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
  console.log(`measure-corpus: ${videos.length} video(s), langs=${langs.join(',')}, manifest=${manifestPath}, headed=${headed}`);

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
  if (gapFull) emitFullTimelines(runRecords, webPayloads);
  const summaries = langs.map((l) => summarizeLang(all, l));
  writeResults(all, summaries, runRecords);
  for (const summary of summaries) printLangSummary(summary);
  printVerdict(summaries);
  printSubstitutions(runRecords, fallbacks);
  emitAnchorIfRequested(all, webPayloads, fixtureAnchor, noFixtures);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
