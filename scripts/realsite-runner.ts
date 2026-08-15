// Real-site extension runner — drives the BUILT e2e extension against real
// youtube.com videos (docs/realsite-run.md). Box-gated manual tier: not CI.
// Run: bun run scripts/realsite-runner.ts [--headless] [--limit=N] [--video=ID]
//      [--kind=speech|music|live] [--threshold=N] [--no-rebuild]
// Results: scripts/data/realsite-run/results.jsonl (live-appended).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordLine,
  sampleVideo,
  summarize,
  type RealsiteRecord,
  type VideoKind,
  type VideoSpec,
} from './realsite-runner-lib';
import { loadRegistry } from '../tests/fixtures/registry';
import { classifyRateFieldDiff } from './rate-field-diff';

// Curated from scripts/data/web-rerun/rerun-results.jsonl (the 24-video
// web-rerun corpus): 7 caption-bearing videos across registers, one music
// control (Rick Astley), two live controls (Lofi Girl radio; JRE #1169 is a
// live re-broadcast — observed live on both smoke runs, swap via
// --video=ID --kind=live when it goes offline).
const DEFAULT_VIDEOS: VideoSpec[] = [
  { videoId: 'iG9CE55wbtY', category: 'talk', kind: 'speech' },
  { videoId: 'Ks-_Mh1QhMc', category: 'talk', kind: 'speech' },
  { videoId: 'HtSuA80QTyo', category: 'lecture', kind: 'speech' },
  { videoId: 'jGwO_UgTS7I', category: 'lecture', kind: 'speech' },
  { videoId: 'ycPr5-27vSI', category: 'podcast', kind: 'live' },
  { videoId: 'fpbOEoRrHyU', category: 'news-comedy', kind: 'speech' },
  { videoId: 'WUvTyaaNkzM', category: 'explainer', kind: 'speech' },
  { videoId: '7Pq-S557XQU', category: 'explainer', kind: 'speech' },
  { videoId: 'dQw4w9WgXcQ', category: 'music', kind: 'music' },
  { videoId: 'jfKfPfyJRdk', category: 'live', kind: 'live' },
];

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = join(ROOT, 'data', 'realsite-run');
const RESULTS_FILE = join(OUT_DIR, 'results.jsonl');
const EXTENSION_DIR = join(ROOT, '..', '.output', 'chrome-mv3-e2e');
const PAGE_PACE_MS = 2500;
const WATCHDOG_IDLE_MS = 8 * 60_000;

const CONTENT_JS = join(EXTENSION_DIR, 'content-scripts', 'content.js');

/** HEAD's commit date (commit date, not author date); null when git is unavailable. */
function headCommitDate(): Date | null {
  const out = spawnSync('git', ['log', '-1', '--format=%cI', 'HEAD'], { encoding: 'utf8' });
  const line = (out.stdout ?? '').trim();
  if (out.status !== 0 || line === '') return null;
  const date = new Date(line);
  return Number.isNaN(date.getTime()) ? null : date;
}

const fmtDate = (date: Date | null): string => (date === null ? 'unknown' : date.toISOString());

// A stale build (predating merged fixes) silently runs and produces false
// failures — the 2026-08-15 2/10 live-detection false positive. Rebuild when
// the bundle predates HEAD; a rebuild is ~1 min, over-building beats a false
// run. --no-rebuild opts out (docs/realsite-run.md).
function ensureE2eBuild(noRebuild: boolean): void {
  const built = existsSync(CONTENT_JS) ? statSync(CONTENT_JS).mtime : null;
  const head = headCommitDate();
  if (built === null) {
    console.log(`realsite-runner: e2e build missing at ${EXTENSION_DIR} (HEAD ${fmtDate(head)})`);
    if (noRebuild) {
      console.error('realsite-runner: --no-rebuild set but no e2e build on disk — nothing to run');
      process.exit(2);
    }
    console.log('realsite-runner: building');
  } else if (head === null || built < head) {
    if (noRebuild) {
      console.log(`realsite-runner: e2e build stale (built ${fmtDate(built)}, HEAD ${fmtDate(head)}) — --no-rebuild, running as-is`);
      return;
    }
    console.log(`realsite-runner: e2e build stale (built ${fmtDate(built)}, HEAD ${fmtDate(head)}) — rebuilding`);
  } else {
    return;
  }
  const spawned = spawnSync('bun', ['run', 'build:e2e'], { cwd: join(ROOT, '..'), stdio: 'inherit' });
  if (spawned.status !== 0) {
    console.error('realsite-runner: bun run build:e2e failed');
    process.exit(1);
  }
  console.log(`realsite-runner: e2e build fresh (built ${fmtDate(statSync(CONTENT_JS).mtime)}, HEAD ${fmtDate(head)})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = !args.includes('--headless');
  const videoArg = args.find((a) => a.startsWith('--video='))?.slice('--video='.length);
  const kindArg = args.find((a) => a.startsWith('--kind='))?.slice('--kind='.length) as VideoKind | undefined;
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const thresholdArg = args.find((a) => a.startsWith('--threshold='))?.slice('--threshold='.length);
  const noRebuild = args.includes('--no-rebuild');
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  const threshold = thresholdArg === undefined ? 0.8 : Number(thresholdArg);
  if (limit !== undefined && !Number.isFinite(limit)) {
    console.error('--limit must be a number');
    process.exit(2);
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error('--threshold must be a number in (0, 1]');
    process.exit(2);
  }
  if (kindArg !== undefined && kindArg !== 'speech' && kindArg !== 'music' && kindArg !== 'live') {
    console.error('--kind must be speech|music|live');
    process.exit(2);
  }
  ensureE2eBuild(noRebuild);

  let videos = videoArg === undefined
    ? DEFAULT_VIDEOS
    : DEFAULT_VIDEOS.filter((v) => v.videoId === videoArg);
  if (videoArg !== undefined && videos.length === 0) {
    videos = [{ videoId: videoArg, category: 'custom', kind: kindArg ?? 'speech' }];
  }
  videos = videos.slice(0, limit);
  if (videos.length === 0) {
    console.error(`no videos to sample${videoArg === undefined ? '' : ` (unknown id: ${videoArg})`}`);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`realsite-runner: ${videos.length} video(s), headed=${headed}, threshold=${threshold}`);

  const records: RealsiteRecord[] = [];
  const registryRows = loadRegistry();
  let lastAppendAt = Date.now();
  const appendRecord = (record: RealsiteRecord): void => {
    records.push(record);
    // Append per record so a mid-run kill never loses completed samples.
    writeFileSync(RESULTS_FILE, JSON.stringify(record) + '\n', { flag: 'a' });
    lastAppendAt = Date.now();
  };
  // The per-video deadline guards every await, but a frozen chromium can
  // stall a CDP call past all of them; the watchdog exits instead of hanging.
  const watchdog = setInterval(() => {
    const idleMs = Date.now() - lastAppendAt;
    if (idleMs > WATCHDOG_IDLE_MS) {
      console.error(`watchdog: no record for ${Math.round(idleMs / 1000)}s — exiting`);
      process.exit(0);
    }
  }, 30_000);
  try {
    for (const video of videos) {
      process.stdout.write(`realsite ${video.videoId} [${video.category}/${video.kind}] ... `);
      const record = await sampleVideo(headed, video, EXTENSION_DIR, OUT_DIR);
      record.rateDiff = classifyRateFieldDiff(record, registryRows);
      appendRecord(record);
      console.log(recordLine(record));
      await new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
    }
  } finally {
    clearInterval(watchdog);
  }

  const ratio = summarize(records);
  console.log(`\nresults -> ${RESULTS_FILE} (${records.length} records)`);
  const traces = records.filter((r) => r.tracePath !== null).length;
  console.log(`traces -> ${traces}/${records.length} (${OUT_DIR}/trace-<videoId>.zip)`);
  if (ratio < threshold) {
    console.log(`VERDICT: FAIL — pass ratio ${(ratio * 100).toFixed(1)}% below ${(threshold * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log(`VERDICT: PASS — pass ratio ${(ratio * 100).toFixed(1)}% ≥ ${(threshold * 100).toFixed(0)}%`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
