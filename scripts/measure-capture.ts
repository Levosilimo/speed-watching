// Browser capture mechanics for the caption-rate corpus measurement
// (scripts/measure-corpus.ts): POT-aware WEB capture with the lang-aware ASR
// track pick, the ANDROID innertube control, and the spec's classification
// and fresh-session-retry rules.

import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { parseYouTubeJson3 } from '../lib/captions';
import { normalizeLanguageCode } from '../lib/languages';
import type { SampleStatus } from './sample-analysis';
import {
  applyStats,
  type CorpusRecord,
  type CorpusVideo,
} from './measure-analysis';
import { androidControl } from './captions-android';
import {
  dismissConsentIfPresent,
  enableCaptions,
  hookTimedtext,
  pageErrorHint,
  pickAsrTrackFromMenu,
  readPlayerInfo,
  waitForTimedtext,
  type TimedtextCapture,
} from './web-capture';

const STATUS_BY_CLASS: Record<CorpusRecord['classification'], SampleStatus> = {
  'web-ok': 'web-captured',
  'pot-fail': 'web-empty',
  'parse-fail': 'parse-failed',
  'no-track': 'no-track',
  'manual-only': 'manual-only',
  'wrong-lang': 'manual-only',
  'geo-block': 'error',
};

function setClass(record: CorpusRecord, classification: CorpusRecord['classification'], error: string | null): void {
  record.classification = classification;
  record.status = STATUS_BY_CLASS[classification];
  record.error = error;
}

export function initRecord(video: CorpusVideo): CorpusRecord {
  return {
    videoId: video.videoId,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    language: video.language,
    register: video.register,
    title: null,
    classification: 'pot-fail',
    error: null,
    asrLang: null,
    trackCount: 0,
    asrCount: 0,
    status: 'web-empty',
    webAsrCount: null,
    androidKind: null,
    androidLang: null,
    androidTrackCount: null,
    webBytes: null,
    windowsWords: null,
    windowsCues: null,
    segsWords: null,
    segsCues: null,
    wordsParity: null,
    cuesParity: null,
    unifiedRate: null,
    wordAccurateRate: null,
    pauseBiasPct: null,
    rateSource: null,
    coveragePct: null,
    regexCount: null,
    icuCount: null,
    countDeltaPct: null,
    hangulDeltaPct: null,
    bandMin: null,
    bandMax: null,
    bandMid: null,
    inBand: null,
    withinBandPct: null,
    detectExpected: video.register,
    detectActual: 'unknown',
    durationSec: null,
    provenance: video.provenance ?? null,
    captureDate: new Date().toISOString().slice(0, 10),
  };
}

/** Word-timing structure presence in a payload: top-level windows or
 * per-seg tOffsetMs — distinguishes a parser bug from a no-timing payload. */
function hasWordTiming(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.windows) && record.windows.length > 0) return true;
  const events = Array.isArray(record.events) ? record.events : [];
  return events.some((event) => {
    if (typeof event !== 'object' || event === null) return false;
    const segs = (event as { segs?: unknown }).segs;
    if (!Array.isArray(segs)) return false;
    return segs.some((seg) => {
      if (typeof seg !== 'object' || seg === null) return false;
      return 'tOffsetMs' in seg && typeof seg.tOffsetMs === 'number';
    });
  });
}

function bodyHasTiming(body: string): boolean {
  try {
    return hasWordTiming(JSON.parse(body) as unknown);
  } catch {
    return false;
  }
}

/** After a track re-pick the first fresh response is often a small preview
 * payload (a few KB of the opening); the full transcript lands on a
 * follow-up request. Return the largest word-timed capture of the window,
 * early when a clearly-full (multi-hundred-KB) payload has landed. */
async function waitForWordTimed(
  page: Page,
  captures: TimedtextCapture[],
  baseline: number,
  timeoutMs: number,
): Promise<TimedtextCapture | null> {
  const deadline = Date.now() + timeoutMs;
  const nudgeAt = Date.now() + Math.min(timeoutMs / 3, 5000);
  let nudged = false;
  let best: TimedtextCapture | null = null;
  while (Date.now() < deadline) {
    for (const c of captures.slice(baseline)) {
      if (c.body !== '' && bodyHasTiming(c.body) && (best === null || c.bytes > best.bytes)) {
        best = c;
      }
    }
    if (best !== null && best.bytes > 50_000) return best;
    if (!nudged && Date.now() >= nudgeAt) {
      await page.keyboard.press('k').catch(() => undefined);
      nudged = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return best;
}

/** WEB capture: toggle captions, wait for the signed timedtext request,
 * re-pick the lang ASR track, classify the payload. Returns the parsed
 * json3 payload on web-ok, else null. */
async function captureTimedtext(
  page: Page,
  record: CorpusRecord,
  captures: TimedtextCapture[],
): Promise<unknown | null> {
  await enableCaptions(page);
  let timedtext = await waitForTimedtext(captures, 5000);
  if (timedtext === null) {
    // a play toggle forces the player to (re)issue its caption request
    await page.keyboard.press('k').catch(() => undefined);
    timedtext = await waitForTimedtext(captures, 3000);
  }
  const baseline = captures.length;
  let menuPicked = await pickAsrTrackFromMenu(page, record.language);
  if (!menuPicked) {
    // the settings menu is racy right after load; one retry before giving up
    await page.waitForTimeout(800);
    menuPicked = await pickAsrTrackFromMenu(page, record.language);
  }
  if (menuPicked) {
    let best = await waitForWordTimed(page, captures, baseline, 15_000);
    if (best !== null && best.bytes < 50_000) {
      // preview-sized: the player often serves the full transcript only on a
      // second re-pick; keep the larger of the two windows
      await page.waitForTimeout(1500);
      await pickAsrTrackFromMenu(page, record.language).catch(() => undefined);
      const retry = await waitForWordTimed(page, captures, baseline, 12_000);
      if (retry !== null && retry.bytes > best.bytes) best = retry;
    }
    if (best !== null) timedtext = best;
  }
  if (timedtext === null) {
    setClass(record, 'pot-fail', 'no-timedtext-request');
    return null;
  }
  if (timedtext.body.length === 0) {
    setClass(record, 'pot-fail', `timedtext-empty (http ${timedtext.httpStatus})`);
    return null;
  }
  if (timedtext.format !== 'json3') {
    setClass(record, 'pot-fail', `timedtext-${timedtext.format}-only (${timedtext.bytes} bytes)`);
    return null;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(timedtext.body) as unknown;
  } catch {
    json = null;
  }
  if (json === null) {
    setClass(record, 'pot-fail', 'response-not-json');
    return null;
  }
  record.webBytes = timedtext.bytes;
  const parsed = parseYouTubeJson3(json);
  record.windowsWords = parsed.words.length;
  record.windowsCues = parsed.cues.length;
  if (parsed.words.length === 0) {
    const timing = hasWordTiming(json);
    setClass(record, timing ? 'parse-fail' : 'pot-fail', timing ? 'windows-parse-zero-words' : 'no-word-timing-in-payload');
    return null;
  }
  if (parsed.cues.length === 0) {
    setClass(record, 'parse-fail', 'cues-parse-zero');
    return null;
  }
  setClass(record, 'web-ok', null);
  return json;
}

/** One capture pass: load, classify, WEB capture, ANDROID control, stats.
 * Never throws; classification carries the outcome. */
async function attemptVideo(
  context: BrowserContext,
  video: CorpusVideo,
): Promise<{ record: CorpusRecord; webJson: unknown | null }> {
  const record = initRecord(video);
  const page = await context.newPage();
  const captures: TimedtextCapture[] = [];
  hookTimedtext(page, captures);
  let webJson: unknown | null = null;
  let androidJson: unknown | null = null;
  try {
    await page.goto(record.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissConsentIfPresent(page);
    await page.waitForFunction(
      () => window.ytInitialPlayerResponse !== undefined,
      undefined,
      { timeout: 25_000 },
    );
    const info = await readPlayerInfo(page);
    record.title = info.title;
    record.trackCount = info.trackCount;
    record.asrCount = info.asrCount;
    record.webAsrCount = info.asrCount;
    record.asrLang = info.asrLang;
    if (info.playabilityStatus !== null && info.playabilityStatus !== 'OK') {
      setClass(record, 'geo-block', `playability ${info.playabilityStatus}`);
      return { record, webJson };
    }
    const hint = await pageErrorHint(page);
    if (hint !== null) {
      setClass(record, 'geo-block', hint);
      return { record, webJson };
    }
    if (info.trackCount === 0) {
      setClass(record, 'no-track', 'no-caption-tracks');
      await androidControl(page, record, video.videoId, (json) => {
        androidJson = json;
      }, video.language);
      return { record, webJson };
    }
    const hasLangAsr = info.asrLangs.some(
      (code) => normalizeLanguageCode(code) === video.language,
    );
    if (info.asrCount === 0 || !hasLangAsr) {
      setClass(
        record,
        info.asrCount === 0 ? 'manual-only' : 'wrong-lang',
        info.asrCount === 0 ? 'no-asr-track' : `asr-lang=${info.asrLang ?? '?'}`,
      );
      await androidControl(page, record, video.videoId, (json) => {
        androidJson = json;
      }, video.language);
      return { record, webJson };
    }
    webJson = await captureTimedtext(page, record, captures);
    await androidControl(page, record, video.videoId, (json) => {
      androidJson = json;
    }, video.language);
    applyStats(record, webJson, androidJson, video);
  } catch (err) {
    setClass(record, 'pot-fail', err instanceof Error && err.message ? err.message : String(err));
    const hint = await pageErrorHint(page);
    if (hint) record.error = `${record.error} (${hint})`;
  } finally {
    await page.close();
  }
  return { record, webJson };
}

/** pot-fail / geo-block get one fresh-session retry, then the failure is
 * structural (spec honest-failure rules). */
export async function measureVideo(
  context: BrowserContext,
  video: CorpusVideo,
): Promise<{ record: CorpusRecord; webJson: unknown | null }> {
  const first = await attemptVideo(context, video);
  const retryable =
    first.record.classification === 'pot-fail' ||
    first.record.classification === 'geo-block';
  if (!retryable) return first;
  await new Promise((r) => setTimeout(r, 2000));
  const second = await attemptVideo(context, video);
  if (second.record.classification !== 'pot-fail' && second.record.classification !== 'geo-block') {
    return second;
  }
  second.record.error = `first: ${first.record.error ?? '?'}; retried: ${second.record.error ?? '?'}`;
  return second;
}

export async function setupBrowser(headed: boolean): Promise<{
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
