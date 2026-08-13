// Gate 1 residential timedtext re-run (docs/manual-gates-runbook.md gate 1).
// Runs the phase-0 WEB corpus from a residential IP and classifies each video
// by how the player's own signed /api/timedtext request behaves — the request
// entrypoints/content.ts relies on, which a fresh baseUrl fetch cannot
// reproduce (the player's URL carries a pot token bound to the video).
//
// Classification (runbook vocabulary):
//   web-ok     words > 0 AND cues > 0 parsed from the intercepted payload
//   pot-fail   no/empty timedtext or a payload without word-timing structures
//              — POT/IP access; fresh-session re-run, then the escalation
//   parse-fail timing structures present but words === 0 — PARSER BUG, hard fail
//   no-track   no captionTracks or manual-only tracks — structural, excluded
//              from the ASR denominator
//
// Reuses the capture mechanics proven in scripts/sample-captions.ts via
// scripts/web-capture.ts and the production parser (lib/captions.ts).
// Run: bun run scripts/gate1-residential.ts [--limit N] [--video=ID] [--headless]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import {
  parseYouTubeJson3,
  type ParsedCaptions,
  type Segment,
} from '../lib/captions';
import type { PlayerResponse } from '../lib/youtube';
import {
  dismissConsentIfPresent,
  enableCaptions,
  hookTimedtext,
  pageErrorHint,
  pickAsrTrackFromMenu,
  readPlayerInfo,
  waitForFreshTimedtext,
  waitForTimedtext,
  type TimedtextCapture,
} from './web-capture';
type GateClass = 'web-ok' | 'pot-fail' | 'parse-fail' | 'no-track';
interface SampleVideo {
  videoId: string;
  category: string;
}
interface GateRecord {
  videoId: string;
  url: string;
  category: string;
  classification: GateClass;
  reason: string | null;
  title: string | null;
  asrBearing: boolean;
  trackCount: number;
  asrCount: number;
  languageCode: string | null;
  words: number;
  cues: number;
  wordsParity: boolean | null;
  transcriptSample: string | null;
  timedtextUrl: string | null;
  timedtextHttpStatus: number | null;
  asrRepick: boolean;
}
// Fallback corpus when scripts/data/web-rerun/rerun-results.jsonl is absent (same list as sample-captions.ts).
const FALLBACK_VIDEOS: SampleVideo[] = [
  { videoId: 'iG9CE55wbtY', category: 'talk' }, { videoId: 'qp0HIF3SfI4', category: 'talk' },
  { videoId: 'Ks-_Mh1QhMc', category: 'talk' }, { videoId: 'arj7oStGLkU', category: 'talk' },
  { videoId: 'HtSuA80QTyo', category: 'lecture' }, { videoId: 'jGwO_UgTS7I', category: 'lecture' },
  { videoId: '8mAITcNt710', category: 'lecture' }, { videoId: 'ycPr5-27vSI', category: 'podcast' },
  { videoId: 'fpbOEoRrHyU', category: 'news-comedy' }, { videoId: 'WUvTyaaNkzM', category: 'explainer' },
  { videoId: 'aircAruvnKk', category: 'explainer' }, { videoId: 'h6fcK_fRYaI', category: 'explainer' },
  { videoId: '7Pq-S557XQU', category: 'explainer' }, { videoId: 'w-I6XTVZXww', category: 'explainer' },
  { videoId: 'XRr1kaXKBsU', category: 'explainer' }, { videoId: 'r6sGWTCMz2k', category: 'explainer' },
  { videoId: 'JTvcpdfGUtQ', category: 'explainer' }, { videoId: 'X32dce7_D48', category: 'explainer' },
  { videoId: '60ItHLz5WEA', category: 'music' }, { videoId: 'dQw4w9WgXcQ', category: 'music' },
  { videoId: 'ZbZSe6N_BXs', category: 'music' }, { videoId: 'kJQP7kiw5Fk', category: 'music' },
  { videoId: 'nfWlot6h_JM', category: 'music' }, { videoId: '4NRXx6U8ABQ', category: 'music' },
];
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = join(ROOT, 'data', 'gate1-residential');
const RESULTS_FILE = join(OUT_DIR, 'results.jsonl');
const CORPUS_FILE = join(ROOT, 'data', 'web-rerun', 'rerun-results.jsonl');
const PROFILE_DIR = join(homedir(), '.speedwatcher-gate1');
const PAGE_PACE_MS = 2500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

function fail(record: GateRecord, classification: GateClass, reason: string): GateRecord {
  record.classification = classification;
  record.reason = reason;
  return record;
}

function firstLast<T>(items: T[]): [T, T] | null {
  const first = items[0];
  const last = items[items.length - 1];
  return first === undefined || last === undefined ? null : [first, last];
}

/** Words from one layout only — mirrors the two wordTokens loops in
 * lib/captions.ts so the windows==segs parity compares like for like. */
function wordsFromLayout(payload: Record<string, unknown>, layout: 'windows' | 'segs'): Segment[] {
  const tokens: Segment[] = [];
  const push = (seg: unknown, baseMs: number): void => {
    if (!isRecord(seg)) return;
    const text = asString(seg.utf8);
    const offset = asNumber(seg.tOffsetMs);
    if (text === null || offset === null || text.trim() === '') return;
    tokens.push({ text, startSec: (baseMs + offset) / 1000 });
  };
  if (layout === 'windows') {
    for (const window of asArray(payload.windows)) {
      if (!isRecord(window)) continue;
      const base = (asNumber(window.wpWinStartMs) ?? 0) + (asNumber(window.wWinOffsetMs) ?? 0);
      for (const seg of asArray(window.segs)) push(seg, base);
    }
  } else {
    for (const event of asArray(payload.events)) {
      if (!isRecord(event)) continue;
      const start = asNumber(event.tStartMs);
      if (start === null) continue;
      for (const seg of asArray(event.segs)) push(seg, start);
    }
  }
  tokens.sort((a, b) => a.startSec - b.startSec);
  return tokens;
}
/** True when the payload carries any word-timing structure (top-level windows or per-seg tOffsetMs). */
function hasWordTimingStructures(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (asArray(payload.windows).length > 0) return true;
  return asArray(payload.events).some(
    (e) => isRecord(e) && asArray(e.segs).some((s) => isRecord(s) && asNumber(s.tOffsetMs) !== null),
  );
}
/** Runbook parity: when a payload carries BOTH layouts, both parses must
 * agree (same first/last word, overlapping coverage). Null when a layout is
 * absent — most real WEB payloads carry events[].segs only. */
function windowsSegsParity(payload: unknown): boolean | null {
  if (!isRecord(payload)) return null;
  const windowsWords = wordsFromLayout(payload, 'windows');
  const segsWords = wordsFromLayout(payload, 'segs');
  const windows = firstLast(windowsWords);
  const segs = firstLast(segsWords);
  if (windows === null || segs === null) return null;
  const [firstWindows, lastWindows] = windows;
  const [firstSegs, lastSegs] = segs;
  const firstSame = firstWindows.text === firstSegs.text;
  const lastSame = lastWindows.text === lastSegs.text;
  const coverage = Math.min(windowsWords.length, segsWords.length) / Math.max(windowsWords.length, segsWords.length);
  return firstSame && lastSame && coverage >= 0.9;
}

function transcriptSample(parsed: ParsedCaptions): string | null {
  const cues = parsed.cues.length > 0 ? parsed.cues : parsed.words;
  if (cues.length === 0) return null;
  return cues
    .slice(0, 5)
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function initRecord(video: SampleVideo): GateRecord {
  return {
    videoId: video.videoId,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    category: video.category,
    classification: 'pot-fail',
    reason: null,
    title: null,
    asrBearing: false,
    trackCount: 0,
    asrCount: 0,
    languageCode: null,
    words: 0, cues: 0, wordsParity: null,
    transcriptSample: null, timedtextUrl: null,
    timedtextHttpStatus: null, asrRepick: false,
  };
}

async function loadWatchPage(page: Page, record: GateRecord): Promise<{ trackCount: number; asrCount: number }> {
  await page.goto(record.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissConsentIfPresent(page);
  await page.waitForFunction(() => window.ytInitialPlayerResponse !== undefined, undefined, {
    timeout: 25_000,
  });
  const info = await readPlayerInfo(page);
  record.title = info.title;
  record.trackCount = info.trackCount;
  record.asrCount = info.asrCount;
  record.languageCode = await page.evaluate((): string | null => {
    const pr: PlayerResponse | undefined = window.ytInitialPlayerResponse;
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    return (tracks.find((t) => t.kind === 'asr') ?? tracks[0])?.languageCode ?? null;
  });
  return info;
}

/** Toggle captions on, wait for the player's signed timedtext request, then
 * re-pick the ASR track from the CC menu — the default track is often a
 * manual transcript without word timing. */
async function captureTimedtext(page: Page, record: GateRecord, captures: TimedtextCapture[]): Promise<void> {
  await enableCaptions(page);
  let timedtext = await waitForTimedtext(captures, 5000);
  if (timedtext === null) {
    // a play toggle forces the player to (re)issue its caption request
    await page.keyboard.press('k').catch(() => undefined);
    timedtext = await waitForTimedtext(captures, 3000);
  }
  const baseline = captures.length;
  const menuPicked = await pickAsrTrackFromMenu(page);
  if (menuPicked) {
    const fresh = await waitForFreshTimedtext(captures, baseline, 4000);
    if (fresh !== null) {
      timedtext = fresh;
      record.asrRepick = true;
    }
  }
  record.timedtextUrl = timedtext?.url ?? null;
  record.timedtextHttpStatus = timedtext?.httpStatus ?? null;
  if (timedtext === null) {
    fail(record, 'pot-fail', 'no-timedtext-request');
    return;
  }
  if (timedtext.body.length === 0) {
    fail(record, 'pot-fail', `timedtext-empty (http ${timedtext.httpStatus})`);
    return;
  }
  if (timedtext.format !== 'json3') {
    fail(record, 'pot-fail', `timedtext-${timedtext.format}-only (${timedtext.bytes} bytes)`);
    return;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(timedtext.body) as unknown;
  } catch {
    json = null;
  }
  if (json === null) {
    fail(record, 'pot-fail', 'response-not-json');
    return;
  }
  const parsed = parseYouTubeJson3(json);
  record.words = parsed.words.length;
  record.cues = parsed.cues.length;
  record.wordsParity = windowsSegsParity(json);
  record.transcriptSample = transcriptSample(parsed);
  if (record.words === 0) {
    const timing = hasWordTimingStructures(json);
    record.classification = timing ? 'parse-fail' : 'pot-fail';
    record.reason = timing ? 'windows-parse-zero-words' : 'no-word-timing-in-payload';
    return;
  }
  if (record.cues === 0) {
    fail(record, 'parse-fail', 'cues-parse-zero');
    return;
  }
  record.classification = 'web-ok';
  record.reason = null;
}

async function sampleVideo(context: BrowserContext, video: SampleVideo): Promise<GateRecord> {
  const record = initRecord(video);
  const page = await context.newPage();
  const captures: TimedtextCapture[] = [];
  hookTimedtext(page, captures);
  try {
    const info = await loadWatchPage(page, record);
    if (info.trackCount === 0) return fail(record, 'no-track', 'no-caption-tracks');
    if (info.asrCount === 0) return fail(record, 'no-track', 'manual-only');
    record.asrBearing = true;
    await captureTimedtext(page, record, captures);
  } catch (err) {
    fail(record, 'pot-fail', err instanceof Error && err.message ? err.message : String(err));
    const hint = await pageErrorHint(page);
    if (hint) record.reason = `${record.reason} (${hint})`;
  } finally {
    await page.close();
  }
  return record;
}

async function setupBrowser(headed: boolean, profileDir: string): Promise<BrowserContext> {
  // probe for the CfT version so the UA matches the real Chrome build
  const probe = await chromium.launch({ headless: true });
  const version = probe.version();
  await probe.close();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
    locale: 'en-US',
    userAgent:
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${version} Safari/537.36`,
    viewport: { width: 1280, height: 800 },
  });
  // consent cookies: without them the default CC track is the manual transcript, not ASR
  await context.addCookies([
    { name: 'CONSENT', value: 'YES+cb.20220301-01-p0.en+FX+000', domain: '.youtube.com', path: '/' },
    { name: 'SOCS', value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY', domain: '.youtube.com', path: '/' },
  ]);
  return context;
}

function loadVideos(videoArg: string | undefined, limit: number | undefined): SampleVideo[] {
  let videos: SampleVideo[] = FALLBACK_VIDEOS;
  if (existsSync(CORPUS_FILE)) {
    try {
      const rows: unknown[] = readFileSync(CORPUS_FILE, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      if (rows.length > 0 && rows.every((r) => isRecord(r) && typeof r.videoId === 'string')) {
        videos = rows.map((r) => ({
          videoId: (r as { videoId: string }).videoId,
          category: typeof (r as { category?: unknown }).category === 'string' ? (r as { category: string }).category : 'unknown',
        }));
      }
    } catch {
      // corrupt corpus file — fall back to the embedded list
    }
  }
  if (videoArg !== undefined) videos = videos.filter((v) => v.videoId === videoArg);
  return limit === undefined ? videos : videos.slice(0, limit);
}

function parityStr(parity: boolean | null): string {
  return parity === null ? '-' : String(parity);
}
function recordLine(record: GateRecord): string {
  if (record.classification === 'web-ok') {
    return `web-ok words=${record.words} cues=${record.cues} lang=${record.languageCode ?? '-'} parity=${parityStr(record.wordsParity)}`;
  }
  return `${record.classification}${record.reason ? ` (${record.reason})` : ''}`;
}

function summarize(records: GateRecord[]): number {
  const byClass = new Map<GateClass, number>();
  for (const record of records) {
    byClass.set(record.classification, (byClass.get(record.classification) ?? 0) + 1);
  }
  const asrBearing = records.filter((r) => r.asrBearing);
  const passed = asrBearing.filter((r) => r.classification === 'web-ok');
  const parserFails = byClass.get('parse-fail') ?? 0;
  const rate = asrBearing.length === 0 ? 0 : passed.length / asrBearing.length;

  const header = ['videoId', 'class', 'words', 'cues', 'lang', 'parity', 'reason'];
  const rows = records.map((r) => [
    r.videoId,
    r.classification,
    String(r.words),
    String(r.cues),
    r.languageCode ?? '-',
    parityStr(r.wordsParity),
    (r.reason ?? '').slice(0, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const printRow = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  console.log('\n' + printRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(printRow(row));

  console.log(`\nby class: ${[...byClass.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(
    `pass fraction: ${passed.length}/${asrBearing.length} ASR-bearing videos ` +
      `yielded word timing (${(rate * 100).toFixed(1)}%)`,
  );
  console.log(
    `stratified: structural=${byClass.get('no-track') ?? 0} ` +
      `pot-access=${byClass.get('pot-fail') ?? 0} parser=${parserFails}`,
  );
  if (parserFails > 0) {
    console.log('VERDICT: HARD FAIL — parser bug on real payloads (words===0)');
    return 1;
  }
  if (rate < 0.9) {
    console.log(
      'VERDICT: FAIL — pass fraction below 90%; pot-access failures need a ' +
        'fresh-session re-run, then the runbook escalation',
    );
    return 1;
  }
  console.log('VERDICT: PASS — gate 1 residential re-run green');
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = !args.includes('--headless');
  const videoArg = args.find((a) => a.startsWith('--video='))?.slice(7);
  const limitArg = args.find((a) => a.startsWith('--limit=')) ?? (args.includes('--limit') ? args[args.indexOf('--limit') + 1] : undefined);
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && !Number.isFinite(limit)) {
    console.error('--limit must be a number');
    process.exit(2);
  }

  const videos = loadVideos(videoArg, limit);
  if (videos.length === 0) {
    console.error('no videos to sample');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`gate1-residential: ${videos.length} video(s), headed=${headed}, profile=${PROFILE_DIR}`);

  const context = await setupBrowser(headed, PROFILE_DIR);
  const records: GateRecord[] = [];
  try {
    for (const video of videos) {
      process.stdout.write(`gate1 ${video.videoId} [${video.category}] ... `);
      const record = await sampleVideo(context, video);
      records.push(record);
      console.log(recordLine(record));
      await new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
    }
  } finally {
    await context.close();
  }
  writeFileSync(RESULTS_FILE, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`\nresults -> ${RESULTS_FILE}`);
  const exitCode = summarize(records);
  console.log(`exit code: ${exitCode}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
