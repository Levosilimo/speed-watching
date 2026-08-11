// One-off local measurement harness for the Phase 0 caption-WPM spike.
// NOT part of the vitest suite: it drives a real browser against real
// YouTube videos. Run: bun run scripts/sample-captions.ts [--headed] [--limit N]
// Re-analyze an existing results file without network: --analyze
// Re-capture only the fixture videos: --refixture
//
// Method (documented in docs/phase0-caption-wpm.md):
// 1. Load the watch page, read ytInitialPlayerResponse for track metadata.
// 2. POST youtubei/v1/player with the ANDROID client to obtain caption
//    track URLs (the WEB-client timedtext endpoint returns empty 200s from
//    this datacenter IP; the player's own WEB fetch fails the same way).
// 3. Fetch the chosen track's baseUrl as fmt=json3 inside the page context.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { parseYouTubeJson3 } from '../lib/captions';
import type { PlayerResponse } from '../lib/youtube';
import {
  analyze,
  analyzeExisting,
  FIXTURE_SLOTS,
  printReport,
  saveFixtures,
  type SampleRecord,
} from './sample-analysis';

interface SampleVideo {
  videoId: string;
  category: string;
}

const VIDEOS: SampleVideo[] = [
  { videoId: 'iG9CE55wbtY', category: 'talk' },
  { videoId: 'qp0HIF3SfI4', category: 'talk' },
  { videoId: 'Ks-_Mh1QhMc', category: 'talk' },
  { videoId: 'arj7oStGLkU', category: 'talk' },
  { videoId: 'HtSuA80QTyo', category: 'lecture' },
  { videoId: 'jGwO_UgTS7I', category: 'lecture' },
  { videoId: '8mAITcNt710', category: 'lecture' },
  { videoId: 'ycPr5-27vSI', category: 'podcast' },
  { videoId: 'fpbOEoRrHyU', category: 'news-comedy' },
  { videoId: 'WUvTyaaNkzM', category: 'explainer' },
  { videoId: 'aircAruvnKk', category: 'explainer' },
  { videoId: 'h6fcK_fRYaI', category: 'explainer' },
  { videoId: '7Pq-S557XQU', category: 'explainer' },
  { videoId: 'w-I6XTVZXww', category: 'explainer' },
  { videoId: 'XRr1kaXKBsU', category: 'explainer' },
  { videoId: 'r6sGWTCMz2k', category: 'explainer' },
  { videoId: 'JTvcpdfGUtQ', category: 'explainer' },
  { videoId: 'X32dce7_D48', category: 'explainer' },
  { videoId: '60ItHLz5WEA', category: 'music' },
  { videoId: 'dQw4w9WgXcQ', category: 'music' },
  { videoId: 'ZbZSe6N_BXs', category: 'music' },
  { videoId: 'kJQP7kiw5Fk', category: 'music' },
  { videoId: 'nfWlot6h_JM', category: 'music' },
  { videoId: '4NRXx6U8ABQ', category: 'music' },
];

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const RESULTS_DIR = join(ROOT, 'data');
const RESULTS_FILE = join(RESULTS_DIR, 'sample-results.jsonl');
const FIXTURES_DIR = join(ROOT, '..', 'tests', 'fixtures', 'real');

const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.31',
  androidSdkVersion: 30,
  hl: 'en',
  gl: 'US',
};

interface ExtractResult {
  json: unknown;
  kind: string;
  lang: string;
  trackCount: number;
}

async function extractCaptionsInPage(input: {
  videoId: string;
  client: Record<string, unknown>;
}): Promise<ExtractResult | { error: string }> {
  const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: input.client },
      videoId: input.videoId,
    }),
  });
  if (!playerRes.ok) {
    return { error: `android-player-http-${playerRes.status}` };
  }
  const playerJson = (await playerRes.json()) as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{
          kind?: string;
          languageCode?: string;
          baseUrl: string;
        }>;
      };
    };
  };
  const tracks =
    playerJson.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const pick =
    tracks.find((t) => t.kind === 'asr' && t.languageCode === 'en') ??
    tracks.find((t) => t.kind !== 'asr' && t.languageCode === 'en') ??
    tracks.find((t) => t.kind === 'asr') ??
    tracks[0];
  if (!pick) return { error: 'no-caption-tracks' };
  const url = new URL(pick.baseUrl, location.href);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url);
  if (!response.ok) return { error: `caption-fetch-http-${response.status}` };
  const text = await response.text();
  if (text.length === 0) return { error: 'caption-fetch-empty' };
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { error: 'caption-fetch-not-json' };
  }
  return {
    json,
    kind: pick.kind ?? 'manual',
    lang: pick.languageCode ?? '?',
    trackCount: tracks.length,
  };
}

async function sampleVideo(
  context: BrowserContext,
  video: SampleVideo,
): Promise<{ record: SampleRecord; rawJson: unknown | null }> {
  const url = `https://www.youtube.com/watch?v=${video.videoId}`;
  const record: SampleRecord = {
    videoId: video.videoId,
    url,
    category: video.category,
    status: 'error',
    error: null,
    landedUrl: '',
    title: null,
    kind: null,
    lang: null,
    trackCount: null,
    webTrackCount: null,
    webAsrCount: null,
    webManualCount: null,
    nCues: null,
    nWordsTimed: null,
    textTokens: null,
    icuTokens: null,
    tokenDeltaPct: null,
    coveragePct: null,
    spanSec: null,
    speechEstSec: null,
    wordWpm: null,
    cueWpm: null,
    cueWpmCorrected: null,
    monotonicPct: null,
    nBracketMarkers: null,
    firstCue: null,
    lastCue: null,
  };
  const page = await context.newPage();
  let rawJson: unknown | null = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    record.landedUrl = page.url();
    await dismissConsentIfPresent(page);
    await page.waitForFunction(
      () => window.ytInitialPlayerResponse !== undefined,
      undefined,
      { timeout: 25_000 },
    );
    const web = await page.evaluate((): {
      title: string | null;
      trackCount: number;
      asrCount: number;
      manualCount: number;
    } => {
      const pr: PlayerResponse | undefined = window.ytInitialPlayerResponse;
      const tracks =
        pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      return {
        title: pr?.videoDetails?.title ?? null,
        trackCount: tracks.length,
        asrCount: tracks.filter((t) => t.kind === 'asr').length,
        manualCount: tracks.filter((t) => t.kind !== 'asr').length,
      };
    });
    record.title = web.title;
    record.webTrackCount = web.trackCount;
    record.webAsrCount = web.asrCount;
    record.webManualCount = web.manualCount;
    const extracted = await page.evaluate(extractCaptionsInPage, {
      videoId: video.videoId,
      client: ANDROID_CLIENT,
    });
    if ('error' in extracted) {
      record.error = extracted.error;
      return { record, rawJson: null };
    }
    rawJson = extracted.json;
    record.kind = extracted.kind;
    record.lang = extracted.lang;
    record.trackCount = extracted.trackCount;
    const parsed = parseYouTubeJson3(extracted.json);
    Object.assign(record, analyze(parsed));
    record.status = 'ok';
  } catch (err) {
    record.error = err instanceof Error && err.message ? err.message : String(err);
    const hint = await pageErrorHint(page);
    if (hint) record.error = `${record.error} (${hint})`;
  } finally {
    await page.close();
  }
  return { record, rawJson };
}

async function dismissConsentIfPresent(page: Page): Promise<void> {
  try {
    await page.waitForSelector('ytd-consent-bump-v2-lightbox', { timeout: 3000 });
    await page
      .locator('ytd-consent-bump-v2-lightbox button')
      .filter({ hasText: 'Accept all' })
      .click({ timeout: 5000 });
    await page.waitForSelector('ytd-consent-bump-v2-lightbox', {
      state: 'detached',
      timeout: 5000,
    });
  } catch {
    // dialog absent or already dismissed
  }
}

async function pageErrorHint(page: Page): Promise<string | null> {
  try {
    const bodyText = await page.evaluate(
      () => document.body?.innerText?.slice(0, 400) ?? '',
    );
    if (/not a bot|sign in to confirm/i.test(bodyText)) return 'bot-wall';
    if (page.url().includes('consent')) return 'consent-page';
  } catch {
    return null;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--analyze')) {
    analyzeExisting(RESULTS_FILE);
    return;
  }
  const headed = args.includes('--headed');
  const refixture = args.includes('--refixture');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : VIDEOS.length;
  const videos = refixture
    ? VIDEOS.filter((v) => FIXTURE_SLOTS.some((s) => s.preferred === v.videoId))
    : VIDEOS.slice(0, limit);

  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const chromeVersion = browser.version();
  const userAgent =
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromeVersion} Safari/537.36`;
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent,
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
      value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY',
      domain: '.youtube.com',
      path: '/',
    },
  ]);

  const payloads = new Map<string, unknown>();
  const results: SampleRecord[] = [];
  for (const video of videos) {
    process.stdout.write(`sampling ${video.videoId} [${video.category}] ... `);
    const { record, rawJson } = await sampleVideo(context, video);
    results.push(record);
    if (rawJson !== null) payloads.set(video.videoId, rawJson);
    const state =
      record.status === 'ok'
        ? `cue=${(record.cueWpm ?? 0).toFixed(1)} words=${record.nWordsTimed}`
        : `ERR ${record.error}`;
    console.log(state);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await browser.close();

  const lines: string[] = [];
  for (const r of results) lines.push(JSON.stringify(r));
  if (!refixture) {
    writeFileSync(RESULTS_FILE, lines.join('\n') + '\n', 'utf8');
    console.log(`\nresults -> ${RESULTS_FILE}`);
  }

  await saveFixtures(results, payloads, FIXTURES_DIR);
  if (!refixture) printReport(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
