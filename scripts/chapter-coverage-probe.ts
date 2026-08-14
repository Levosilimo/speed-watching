// Chapter-coverage probe — the GATE for the per-chapter-rate feature
// (spec: .slim/deepwork/speed-watching-extension.md "CHAPTER DATA IS
// PAGE-CONTEXT-READABLE"). The fixture server fabricates its
// playerResponse, so only a live page probe can answer how often real
// watch pages expose chapter markers in the live playerResponse, and
// whether the exact nested shape the feature would read still holds
// (extraction in chapter-coverage-lib.ts, with per-step drift reporting
// so a renamed or moved field shows up as evidence instead of a silent
// miss).
//
// Each watch URL from the web-rerun corpus (24 verified videos) is
// loaded; results append live to
// scripts/data/chapter-coverage/results.jsonl and merge on rerun.
// Classification: chapters-present / no-markers / no-player-response /
// geo-block / error. Coverage ratio = chapters-present ÷ reachable
// (reachable = response read successfully). Chapters are duration-gated
// upstream (YouTube auto-chapters need roughly >=8 min), so the summary
// breaks coverage down by duration bracket and by corpus register.
//
// Run: bun run scripts/chapter-coverage-probe.ts [--headed] [--limit=N] [--video=ID]
// Exit codes: 0 = run completed (failures are data), 1 = harness crash.
//
// Chromium on this box intermittently freezes under sustained page churn;
// a fresh browser per video caps a freeze's blast radius to the one video
// it happened on, and the watchdog exits instead of hanging (records are
// appended live, so a truncated run keeps its data).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { dismissConsentIfPresent } from './web-capture';
import { withTimeout } from './vk-probe-network';
import { readPageData, extractChapters, type PageExtract } from './chapter-coverage-lib';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_FILE = join(ROOT, 'data', 'web-rerun', 'rerun-results.jsonl');
const OUT_DIR = join(ROOT, 'data', 'chapter-coverage');
const RESULTS_FILE = join(OUT_DIR, 'results.jsonl');
const PAGE_PACE_MS = 2500;
const LAUNCH_TIMEOUT_MS = 120_000;
const RUN_DEADLINE_MS = 25 * 60_000;
const WATCHDOG_IDLE_MS = 8 * 60_000;
const VIDEO_DEADLINE_MS = 3 * 60_000;

type Classification = 'chapters-present' | 'no-markers' | 'no-player-response' | 'geo-block' | 'error';

interface CorpusVideo {
  videoId: string;
  url: string;
  category: string;
}

interface ChapterRecord {
  videoId: string;
  url: string;
  category: string;
  title: string | null;
  durationSec: number | null;
  classification: Classification;
  reason: string | null;
  chapterCount: number | null;
  chapterTitles: string[] | null;
  /** timeRangeStartMillis per chapter; null when the renderer lacked the field. */
  chapterStarts: (number | null)[] | null;
  /** Exact spec path resolved end to end. */
  shapeValid: boolean;
  /** Where the path broke (deepest key + keys present there), or which
   * marker keys carried no chapters. */
  shapeDrift: string | null;
  /** Index in markersMap whose value.chapters was used; 0 = spec position. */
  markersIndex: number | null;
  /** Which data root carried the chapters (playerResponse = spec root). */
  sourceRoot: 'playerResponse' | 'initialData' | 'initialData-panel' | null;
  playability: string | null;
  capturedAt: string;
}

function initRecord(video: CorpusVideo): ChapterRecord {
  return {
    videoId: video.videoId,
    url: video.url,
    category: video.category,
    title: null,
    durationSec: null,
    classification: 'error',
    reason: null,
    chapterCount: null,
    chapterTitles: null,
    chapterStarts: null,
    shapeValid: false,
    shapeDrift: null,
    markersIndex: null,
    sourceRoot: null,
    playability: null,
    capturedAt: new Date().toISOString(),
  };
}

function applyExtract(record: ChapterRecord, extract: PageExtract | undefined): void {
  if (extract === undefined) {
    record.classification = 'no-player-response';
    record.reason = 'ytInitialPlayerResponse and ytInitialData absent after 10s';
    return;
  }
  record.title = extract.title;
  record.durationSec = extract.durationSec;
  record.playability = extract.playability;
  record.shapeValid = extract.shapeValid;
  record.shapeDrift = extract.shapeDrift;
  record.markersIndex = extract.markersIndex;
  record.sourceRoot = extract.sourceRoot;
  record.chapterCount = extract.chapters.length;
  record.chapterTitles = extract.chapters.map((c) => c.title);
  record.chapterStarts = extract.chapters.map((c) => c.startMillis);
  if (extract.playability !== null && extract.playability !== 'OK') {
    record.classification = 'geo-block';
    record.reason = `playability ${extract.playability}`;
    return;
  }
  if (extract.chapters.length > 0) {
    record.classification = 'chapters-present';
    return;
  }
  record.classification = 'no-markers';
  record.reason = extract.shapeDrift ?? 'no chapter markers in markersMap';
}

async function setupBrowser(headed: boolean): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
    timeout: LAUNCH_TIMEOUT_MS,
  });
  const chromeVersion = browser.version();
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent:
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${chromeVersion} Safari/537.36`,
    viewport: { width: 1280, height: 800 },
  });
  await context.addCookies([
    {
      name: 'CONSENT',
      value: 'YES+cb.20220301-01-p0.en+FX+000',
      domain: '.youtube.com',
      path: '/',
    },
    {
      name: 'SOCS',
      value:
        'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY',
      domain: '.youtube.com',
      path: '/',
    },
  ]);
  return { browser, context };
}

async function sampleVideo(context: BrowserContext, video: CorpusVideo): Promise<ChapterRecord> {
  const record = initRecord(video);
  const page = await context.newPage();
  try {
    await page.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissConsentIfPresent(page);
    const data = await page.evaluate(readPageData);
    applyExtract(
      record,
      data.playerResponse === undefined && data.initialData === undefined
        ? undefined
        : extractChapters(data),
    );
  } catch (err) {
    record.classification = 'error';
    record.reason = err instanceof Error && err.message ? err.message : String(err);
  } finally {
    await page.close().catch(() => undefined);
  }
  return record;
}

async function sampleWithFreshBrowser(
  headed: boolean,
  video: CorpusVideo,
): Promise<ChapterRecord> {
  const fresh = await setupBrowser(headed);
  try {
    const record = await withTimeout(
      sampleVideo(fresh.context, video).catch((err) => {
        const failed = initRecord(video);
        failed.classification = 'error';
        failed.reason = err instanceof Error && err.message ? err.message : String(err);
        return failed;
      }),
      VIDEO_DEADLINE_MS,
      null,
    );
    if (record !== null) return record;
    const failed = initRecord(video);
    failed.classification = 'error';
    failed.reason = 'video-deadline-exceeded';
    return failed;
  } finally {
    await withTimeout(fresh.browser.close(), 10_000, undefined).catch(() => undefined);
  }
}

function loadCorpus(): CorpusVideo[] {
  return readFileSync(CORPUS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { videoId?: string; url?: string; category?: string };
      return { videoId: row.videoId ?? '?', url: row.url ?? '', category: row.category ?? 'unknown' };
    });
}

function loadPrior(): Map<string, ChapterRecord> {
  try {
    return new Map(
      readFileSync(RESULTS_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const record = JSON.parse(line) as ChapterRecord;
          return [record.videoId, record];
        }),
    );
  } catch {
    return new Map();
  }
}

function recordLine(record: ChapterRecord): string {
  const base = `${record.classification}${record.reason ? ` (${record.reason})` : ''}`;
  if (record.classification !== 'chapters-present' && record.classification !== 'no-markers') {
    return base;
  }
  return (
    `${base} chapters=${record.chapterCount ?? '?'} dur=${record.durationSec ?? '?'}s` +
    (record.sourceRoot ? ` root=${record.sourceRoot}` : '') +
    (record.shapeDrift ? ` drift="${record.shapeDrift}"` : '')
  );
}

function bracketOf(durationSec: number | null): string {
  if (durationSec === null) return 'unknown';
  if (durationSec < 300) return '<5m';
  if (durationSec < 600) return '5-10m';
  if (durationSec < 1800) return '10-30m';
  if (durationSec < 3600) return '30-60m';
  return '>=60m';
}

function coveragePct(present: number, reachable: number): string {
  return reachable === 0 ? 'n/a' : `${Math.round((100 * present) / reachable)}%`;
}

function printBreakdown(label: string, rows: { name: string; n: number; present: number; reachable: number }[]): void {
  console.log(`\n${label}`);
  console.log(`  ${'bucket'.padEnd(10)} ${'n'.padStart(3)} ${'chapters'.padStart(8)} ${'reachable'.padStart(9)} coverage`);
  for (const row of rows) {
    if (row.n === 0) continue;
    console.log(
      `  ${row.name.padEnd(10)} ${String(row.n).padStart(3)} ${String(row.present).padStart(8)} ` +
        `${String(row.reachable).padStart(9)} ${coveragePct(row.present, row.reachable)}`,
    );
  }
}

function summarize(records: ChapterRecord[]): void {
  const byClass = new Map<Classification, number>();
  for (const r of records) {
    byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);
  }
  const classes = [...byClass.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`\nclassification: ${classes}`);

  const reachable = records.filter(
    (r) => r.classification === 'chapters-present' || r.classification === 'no-markers',
  );
  const present = reachable.filter((r) => r.classification === 'chapters-present').length;
  console.log(
    `coverage (chapters-present / reachable): ${present}/${reachable.length} = ${coveragePct(present, reachable.length)}`,
  );

  const brackets = ['<5m', '5-10m', '10-30m', '30-60m', '>=60m', 'unknown'];
  printBreakdown(
    'by duration bracket',
    brackets.map((name) => {
      const rs = reachable.filter((r) => bracketOf(r.durationSec) === name);
      return {
        name,
        n: records.filter((r) => bracketOf(r.durationSec) === name).length,
        present: rs.filter((r) => r.classification === 'chapters-present').length,
        reachable: rs.length,
      };
    }),
  );

  const categories = [...new Set(records.map((r) => r.category))].sort();
  printBreakdown(
    'by register',
    categories.map((category) => {
      const rs = reachable.filter((r) => r.category === category);
      return {
        name: category,
        n: records.filter((r) => r.category === category).length,
        present: rs.filter((r) => r.classification === 'chapters-present').length,
        reachable: rs.length,
      };
    }),
  );

  const drifters = records.filter((r) => r.shapeDrift !== null);
  console.log(
    `\nshape: ${records.length - drifters.length}/${records.length} exact-path` +
      ` (${drifters.length} with drift/notes)`,
  );
  for (const d of drifters) {
    console.log(`  ${d.videoId}: ${d.shapeDrift}`);
  }

  const long = reachable.filter((r) => r.durationSec !== null && r.durationSec >= 600);
  const longPresent = long.filter((r) => r.classification === 'chapters-present').length;
  const longRatio = long.length === 0 ? 0 : longPresent / long.length;
  const go = long.length >= 5 && longRatio >= 0.7;
  console.log(
    `\nverdict (>=10min videos): ${longPresent}/${long.length} = ${(100 * longRatio).toFixed(1)}%` +
      ` — ${go ? 'GO: build per-chapter rates' : 'NO-GO: coverage below the 70% gate'}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const videoArg = args.find((a) => a.startsWith('--video='))?.slice('--video='.length);
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && !Number.isFinite(limit)) {
    console.error('--limit must be a number');
    process.exit(2);
  }
  const videos = loadCorpus().filter(
    (v) => videoArg === undefined || v.videoId === videoArg,
  );
  if (limit !== undefined) videos.length = Math.min(videos.length, limit);
  if (videos.length === 0) {
    console.error('no videos to probe');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const prior = loadPrior();
  console.log(
    `chapter-coverage-probe: ${videos.length} video(s) from ${CORPUS_FILE}, headed=${headed}`,
  );

  const records: ChapterRecord[] = [];
  const runDeadline = Date.now() + RUN_DEADLINE_MS;
  let lastAppendAt = Date.now();
  const appendRecord = (record: ChapterRecord): void => {
    records.push(record);
    writeFileSync(RESULTS_FILE, JSON.stringify(record) + '\n', { flag: 'a' });
    lastAppendAt = Date.now();
  };
  // A frozen chromium can stall a CDP call past every per-video deadline;
  // the watchdog exits instead of hanging — records append live, so a
  // truncated run still has its data.
  const watchdog = setInterval(() => {
    const idleMs = Date.now() - lastAppendAt;
    if (idleMs > WATCHDOG_IDLE_MS) {
      console.error(`watchdog: no record for ${Math.round(idleMs / 1000)}s — exiting`);
      process.exit(0);
    }
  }, 30_000);
  try {
    for (const video of videos) {
      if (Date.now() > runDeadline) {
        console.error('run deadline reached — stopping');
        break;
      }
      process.stdout.write(`chapter-probe ${video.videoId} [${video.category}] ... `);
      const record = await sampleWithFreshBrowser(headed, video);
      appendRecord(record);
      console.log(recordLine(record));
      await new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
    }
  } finally {
    clearInterval(watchdog);
  }
  for (const record of records) prior.set(record.videoId, record);
  const merged = [...prior.values()];
  writeFileSync(RESULTS_FILE, merged.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`\nresults -> ${RESULTS_FILE} (${merged.length} records)`);
  summarize(merged);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
