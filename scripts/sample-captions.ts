// POT-aware caption re-run harness (runbook gate 1). Drives a real browser
// against YouTube watch pages and captures the PLAYER'S OWN signed
// /api/timedtext response — the only WEB path that carries a valid POT token
// + signature bound to the video. The ANDROID innertube fetch stays as the
// fallback/control for the windows==segs parity assertion.
//
// Run: bun run scripts/sample-captions.ts [--headed] [--limit N]
//      [--out-dir=DIR] [--capture-web-only] [--refixture] [--analyze]
//
// Method:
// 1. Load the watch page, read ytInitialPlayerResponse for track metadata.
// 2. Toggle captions on (CC pill; menu track pick as fallback) and intercept
//    the player's /api/timedtext request via page.on('response')
//    (scripts/web-capture.ts).
// 3. Parse the intercepted WEB payload (windows layout) with lib/captions.ts.
// 4. Fetch the chosen track via the ANDROID innertube client (segs layout,
//    scripts/captions-android.ts) as the control for parity.

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { parseYouTubeJson3 } from '../lib/captions';
import {
  analyzeExisting,
  cuesParity,
  emitWebFixtures,
  FIXTURE_SLOTS,
  printReport,
  ratesFor,
  saveFixtures,
  truncateForFixture,
  wordsParity,
  type SampleRecord,
} from './sample-analysis';
import { androidControl } from './captions-android';
import {
  dismissConsentIfPresent,
  enableCaptions,
  hookTimedtext,
  pageErrorHint,
  readPlayerInfo,
  waitForTimedtext,
  type TimedtextCapture,
} from './web-capture';

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
const DEFAULT_OUT_DIR = join(ROOT, 'data', 'web-rerun');
const FIXTURES_DIR = join(ROOT, '..', 'tests', 'fixtures', 'real');

function initRecord(video: SampleVideo): SampleRecord {
  return {
    videoId: video.videoId,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    category: video.category,
    status: 'error',
    error: null,
    landedUrl: '',
    title: null,
    webTrackCount: null,
    webAsrCount: null,
    webManualCount: null,
    webPayloadSaved: false,
    webBytes: null,
    webFormat: null,
    windowsWords: null,
    windowsCues: null,
    androidKind: null,
    androidLang: null,
    androidTrackCount: null,
    segsCues: null,
    segsWords: null,
    wordsParity: null,
    cuesParity: null,
    unifiedRate: null,
    wordAccurateRate: null,
    pauseBiasPct: null,
    pauseBiasSource: null,
  };
}

async function loadWatchPage(
  page: Page,
  record: SampleRecord,
  url: string,
): Promise<{ title: string | null; trackCount: number; asrCount: number }> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  record.landedUrl = page.url();
  await dismissConsentIfPresent(page);
  await page.waitForFunction(
    () => window.ytInitialPlayerResponse !== undefined,
    undefined,
    { timeout: 25_000 },
  );
  const web = await readPlayerInfo(page);
  record.title = web.title;
  record.webTrackCount = web.trackCount;
  record.webAsrCount = web.asrCount;
  record.webManualCount = web.manualCount;
  return web;
}

/**
 * Toggle captions on, wait for the player's signed timedtext request, and
 * classify the outcome into the record. Returns the parsed WEB payload, or
 * null when the request never landed, was empty, or was not json3.
 */
async function captureWebPayload(
  page: Page,
  record: SampleRecord,
  captures: TimedtextCapture[],
  asrBearing: boolean,
): Promise<unknown | null> {
  await enableCaptions(page);
  let timedtext = await waitForTimedtext(captures, 5000);
  if (timedtext === null) {
    // a play toggle forces the player to (re)issue its caption request
    await page.keyboard.press('k').catch(() => undefined);
    timedtext = await waitForTimedtext(captures, 3000);
  }
  if (timedtext === null) {
    if (asrBearing) {
      record.status = 'web-empty';
      record.error = 'no-timedtext-request';
    }
    return null;
  }
  record.webBytes = timedtext.bytes;
  record.webFormat = timedtext.format;
  if (timedtext.body.length === 0) {
    if (asrBearing) record.status = 'web-empty';
    record.error = `timedtext-empty (http ${timedtext.httpStatus})`;
    return null;
  }
  if (timedtext.format !== 'json3') {
    if (asrBearing) record.status = 'web-empty';
    record.error = `timedtext-${timedtext.format}-only (${timedtext.bytes} bytes)`;
    return null;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(timedtext.body) as unknown;
  } catch {
    json = null;
  }
  if (json === null) {
    if (asrBearing) record.status = 'web-empty';
    record.error = 'web-captured-not-json';
    return null;
  }
  const parsed = parseYouTubeJson3(json);
  record.windowsWords = parsed.words.length;
  record.windowsCues = parsed.cues.length;
  if (asrBearing) {
    record.status = parsed.words.length > 0 ? 'web-captured' : 'parse-failed';
    if (record.status === 'parse-failed') {
      record.error = 'windows-parse-zero-words';
    }
  }
  return json;
}

function applyRatesAndParity(
  record: SampleRecord,
  webJson: unknown | null,
  androidJson: unknown | null,
  asrBearing: boolean,
): void {
  if (webJson !== null && androidJson !== null && asrBearing) {
    const webParsed = parseYouTubeJson3(webJson);
    const androidParsed = parseYouTubeJson3(androidJson);
    record.cuesParity = cuesParity(webParsed, androidParsed);
    record.wordsParity = wordsParity(webParsed, androidParsed);
  }
  // rates + pause bias: WEB payload preferred, ANDROID control fallback
  const webRates = webJson !== null ? ratesFor(parseYouTubeJson3(webJson)) : null;
  if (webRates !== null) {
    record.unifiedRate = webRates.unifiedRate;
    record.wordAccurateRate = webRates.wordAccurateRate;
    record.pauseBiasPct = webRates.pauseBiasPct;
    record.pauseBiasSource = 'web';
  } else if (androidJson !== null) {
    const androidRates = ratesFor(parseYouTubeJson3(androidJson));
    if (androidRates !== null) {
      record.unifiedRate = androidRates.unifiedRate;
      record.wordAccurateRate = androidRates.wordAccurateRate;
      record.pauseBiasPct = androidRates.pauseBiasPct;
      record.pauseBiasSource = 'android';
    }
  }
}

async function sampleVideo(
  context: BrowserContext,
  video: SampleVideo,
  captureWebOnly: boolean,
): Promise<{ record: SampleRecord; webJson: unknown | null; androidJson: unknown | null }> {
  const record = initRecord(video);
  const page = await context.newPage();
  const captures: TimedtextCapture[] = [];
  hookTimedtext(page, captures);
  let webJson: unknown | null = null;
  let androidJson: unknown | null = null;
  try {
    const web = await loadWatchPage(page, record, record.url);
    if (web.trackCount === 0) {
      record.status = 'no-track';
      if (!captureWebOnly) {
        await androidControl(page, record, video.videoId, (json) => {
          androidJson = json;
        });
      }
      return { record, webJson, androidJson };
    }
    const asrBearing = web.asrCount > 0;
    if (!asrBearing) record.status = 'manual-only';
    webJson = await captureWebPayload(page, record, captures, asrBearing);
    if (!captureWebOnly) {
      await androidControl(page, record, video.videoId, (json) => {
        androidJson = json;
      });
    }
    applyRatesAndParity(record, webJson, androidJson, asrBearing);
  } catch (err) {
    record.status = 'error';
    record.error =
      err instanceof Error && err.message ? err.message : String(err);
    const hint = await pageErrorHint(page);
    if (hint) record.error = `${record.error} (${hint})`;
  } finally {
    await page.close();
  }
  return { record, webJson, androidJson };
}

async function setupBrowser(headed: boolean): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
  });
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
      value:
        'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY',
      domain: '.youtube.com',
      path: '/',
    },
  ]);
  return { browser, context };
}

function finalizeRun(input: {
  results: SampleRecord[];
  webPayloads: Map<string, unknown>;
  androidPayloads: Map<string, unknown>;
  originalBytes: Map<string, number>;
  resultsFile: string;
  refixture: boolean;
  captureWebOnly: boolean;
}): void {
  const { results, webPayloads, androidPayloads, originalBytes, resultsFile, refixture, captureWebOnly } =
    input;
  if (!refixture) {
    writeFileSync(
      resultsFile,
      results.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    console.log(`\nresults -> ${resultsFile}`);
  }
  if (!captureWebOnly) {
    saveFixtures(results, androidPayloads, FIXTURES_DIR);
  }
  emitWebFixtures({
    records: results,
    webPayloads,
    originalBytes,
    fixturesDir: FIXTURES_DIR,
    captureDate: new Date().toISOString().slice(0, 10),
  });
  if (!refixture) printReport(results);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--analyze')) {
    analyzeExisting(join(DEFAULT_OUT_DIR, 'rerun-results.jsonl'));
    return;
  }
  const headed = args.includes('--headed');
  const captureWebOnly = args.includes('--capture-web-only');
  const refixture = args.includes('--refixture');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : VIDEOS.length;
  const outDirArg = args.find((a) => a.startsWith('--out-dir='));
  const outDir = outDirArg
    ? isAbsolute(outDirArg.slice(9))
      ? outDirArg.slice(9)
      : join(ROOT, outDirArg.slice(9))
    : DEFAULT_OUT_DIR;
  const resultsFile = join(outDir, 'rerun-results.jsonl');
  const videos = refixture
    ? VIDEOS.filter((v) => FIXTURE_SLOTS.some((s) => s.preferred === v.videoId))
    : VIDEOS.slice(0, limit);

  mkdirSync(outDir, { recursive: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const { browser, context } = await setupBrowser(headed);
  const webPayloads = new Map<string, unknown>();
  const androidPayloads = new Map<string, unknown>();
  const originalBytes = new Map<string, number>();
  const results: SampleRecord[] = [];
  for (const video of videos) {
    process.stdout.write(`sampling ${video.videoId} [${video.category}] ... `);
    const { record, webJson, androidJson } = await sampleVideo(
      context,
      video,
      captureWebOnly,
    );
    if (webJson !== null) {
      writeFileSync(
        join(outDir, `web-${video.videoId}.json3`),
        JSON.stringify(truncateForFixture(webJson), null, 1),
        'utf8',
      );
      record.webPayloadSaved = true;
      webPayloads.set(video.videoId, webJson);
      originalBytes.set(video.videoId, record.webBytes ?? 0);
    }
    if (androidJson !== null) androidPayloads.set(video.videoId, androidJson);
    results.push(record);
    const state =
      record.status === 'web-captured'
        ? `web windows=${record.windowsWords} cues=${record.windowsCues}`
        : `${record.status}${record.error ? ` (${record.error})` : ''}`;
    console.log(state);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await browser.close();

  finalizeRun({
    results,
    webPayloads,
    androidPayloads,
    originalBytes,
    resultsFile,
    refixture,
    captureWebOnly,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
