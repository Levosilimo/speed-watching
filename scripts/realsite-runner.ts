// Real-site extension runner — drives the BUILT e2e extension against real
// youtube.com videos (docs/realsite-run.md). Box-gated manual tier: not CI.
// Run: bun run scripts/realsite-runner.ts [--headless] [--limit=N] [--video=ID]
//      [--kind=speech|music|live] [--threshold=N] [--speech-threshold=N]
//      [--profile=PATH] [--login] [--ignore-repeats]
// Results: scripts/data/realsite-run/results.jsonl (live-appended, run-marked).
// Exit codes (the verdict, scripts/realsite-verdict.ts): 0 pass · 1 overall
// ratio below --threshold · 2 usage · 3 speech-class floor · 4 repeat
// failure · 5 signed-out --profile lane.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  recordLine,
  sampleVideo,
  summarize,
  type RealsiteRecord,
  type VideoKind,
  type VideoSpec,
} from './realsite-runner-lib';
import { evaluateVerdict, previousRuns, VERDICT_EXIT } from './realsite-verdict';
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
/** Profile sessions older than this are warned about, never blocked. */
const PROFILE_COOKIE_TTL_DAYS = 14;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** The repeat-failure lookback (release-gate.md §4: same classification
 * twice in a row — within the last 2 runs — forces a fix). */
const REPEAT_LOOKBACK_RUNS = 2;

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

/** The profile's session-cookie file (Linux layout); null when absent. */
function profileCookieFile(profilePath: string): string | null {
  const candidates = [
    join(profilePath, 'Default', 'Network', 'Cookies'),
    join(profilePath, 'Default', 'Cookies'),
  ];
  return candidates.find(existsSync) ?? null;
}

/** Warn (never block) when the profile's cookies predate the TTL — the
 * session may have expired; re-run --login headed once. The ensureE2eBuild
 * mtime pattern applied to the session file. */
function warnStaleProfile(profilePath: string): void {
  const cookieFile = profileCookieFile(profilePath);
  if (cookieFile === null) {
    console.warn(`realsite-runner: no session cookie file under ${profilePath} — the profile is not logged in`);
    return;
  }
  const mtime = statSync(cookieFile).mtime;
  const ageDays = (Date.now() - mtime.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > PROFILE_COOKIE_TTL_DAYS) {
    console.warn(
      `realsite-runner: profile cookies last written ${fmtDate(mtime)} ` +
        `(${ageDays.toFixed(0)}d > ${PROFILE_COOKIE_TTL_DAYS}d TTL) — the session may have expired; re-run --login once`,
    );
  }
}

/** One-time headed login: opens youtube.com in the profile and waits for
 * the SID session cookie, then exits 0 (session saved) or 1 (timeout). */async function runLogin(profilePath: string, headed: boolean): Promise<number> {
  const probe = await chromium.launch({ headless: true, timeout: 120_000 });
  const version = probe.version();
  await probe.close();
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: !headed,
    timeout: 120_000,
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('realsite-runner: complete the sign-in in the opened window; waiting for the session cookie');
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const cookies = await context.cookies('https://www.youtube.com').catch(() => []);
      if (cookies.some((c) => c.name === 'SID')) {
        console.log('realsite-runner: SID present — session saved in the profile');
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    console.error('realsite-runner: no SID within 5 minutes — login not completed');
    return 1;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** --profile run setup: warn on a missing dir (a fresh profile would be
 * created, not logged in) and on stale cookies — never blocks. */
function prepareProfile(profilePath: string): void {
  if (!existsSync(profilePath)) {
    console.warn(`realsite-runner: profile ${profilePath} does not exist — a fresh profile will be created (not logged in)`);
    return;
  }
  warnStaleProfile(profilePath);
}

/** The videos to sample: the --video pick from the default corpus, or the
 * custom single-video spec; capped by --limit. */
function selectVideos(
  videoArg: string | undefined,
  kindArg: VideoKind | undefined,
  limit: number | undefined,
): VideoSpec[] {
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
  return videos;
}

interface RunOptions {
  headed: boolean;
  videoArg: string | undefined;
  kindArg: VideoKind | undefined;
  limit: number | undefined;
  threshold: number;
  speechThreshold: number;
  profileArg: string | undefined;
  noRebuild: boolean;
  login: boolean;
  ignoreRepeats: boolean;
}

/** CLI parsing + validation; usage errors exit 2 (the usage code). */
function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  const videoArg = args.find((a) => a.startsWith('--video='))?.slice('--video='.length);
  const kindArg = args.find((a) => a.startsWith('--kind='))?.slice('--kind='.length) as VideoKind | undefined;
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const thresholdArg = args.find((a) => a.startsWith('--threshold='))?.slice('--threshold='.length);
  const speechThresholdArg = args.find((a) => a.startsWith('--speech-threshold='))?.slice('--speech-threshold='.length);
  const profileArg = args.find((a) => a.startsWith('--profile='))?.slice('--profile='.length);
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  const threshold = thresholdArg === undefined ? 0.8 : Number(thresholdArg);
  // --threshold sets BOTH the overall bar and the speech-class floor;
  // --speech-threshold moves only the floor.
  const speechThreshold = speechThresholdArg === undefined ? threshold : Number(speechThresholdArg);
  if (limit !== undefined && !Number.isFinite(limit)) {
    console.error('--limit must be a number');
    process.exit(2);
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error('--threshold must be a number in (0, 1]');
    process.exit(2);
  }
  if (!Number.isFinite(speechThreshold) || speechThreshold <= 0 || speechThreshold > 1) {
    console.error('--speech-threshold must be a number in (0, 1]');
    process.exit(2);
  }
  if (kindArg !== undefined && kindArg !== 'speech' && kindArg !== 'music' && kindArg !== 'live') {
    console.error('--kind must be speech|music|live');
    process.exit(2);
  }
  return {
    headed: !args.includes('--headless'),
    videoArg,
    kindArg,
    limit,
    threshold,
    speechThreshold,
    profileArg,
    noRebuild: args.includes('--no-rebuild'),
    login: args.includes('--login'),
    ignoreRepeats: args.includes('--ignore-repeats'),
  };
}

async function main(): Promise<void> {
  const {
    headed,
    videoArg,
    kindArg,
    limit,
    threshold,
    speechThreshold,
    profileArg,
    noRebuild,
    login,
    ignoreRepeats,
  } = parseArgs();
  if (login) {
    if (profileArg === undefined) {
      console.error('--login requires --profile=<path>');
      process.exit(2);
    }
    process.exit(await runLogin(profileArg, headed));
  }
  if (profileArg !== undefined) prepareProfile(profileArg);
  ensureE2eBuild(noRebuild);

  const videos = selectVideos(videoArg, kindArg, limit);
  mkdirSync(OUT_DIR, { recursive: true });
  // Run marker: groups the history into runs for the repeat check — the
  // next run reads it back from results.jsonl (release-gate.md §4).
  writeFileSync(RESULTS_FILE, JSON.stringify({ runStart: new Date().toISOString() }) + '\n', { flag: 'a' });
  console.log(
    `realsite-runner: ${videos.length} video(s), headed=${headed}, threshold=${threshold}, ` +
      `speech-threshold=${speechThreshold}`,
  );

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
      const record = await sampleVideo(headed, video, EXTENSION_DIR, OUT_DIR, profileArg);
      record.rateDiff = classifyRateFieldDiff(record, registryRows);
      appendRecord(record);
      console.log(recordLine(record));
      await new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
    }
  } finally {
    clearInterval(watchdog);
  }

  summarize(records);
  console.log(`\nresults -> ${RESULTS_FILE} (${records.length} records)`);
  const traces = records.filter((r) => r.tracePath !== null).length;
  console.log(`traces -> ${traces}/${records.length} (${OUT_DIR}/trace-<videoId>.zip)`);
  const verdict = evaluateVerdict(records, previousRuns(readFileSync(RESULTS_FILE, 'utf8')), {
    threshold,
    speechThreshold,
    signedInLane: profileArg !== undefined,
    ignoreRepeats,
    repeatLookbackRuns: REPEAT_LOOKBACK_RUNS,
  });
  const prefix = verdict.code === VERDICT_EXIT.PASS ? 'PASS — ' : 'FAIL — ';
  console.log(`VERDICT: ${prefix}${verdict.line}`);
  process.exit(verdict.code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
