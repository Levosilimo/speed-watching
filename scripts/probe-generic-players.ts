// Phase 0 Lane C probe: feasibility of the Phase-3 generic <video> matcher on
// non-YouTube players. For each site it records how many video elements exist
// and in which frames (same-origin vs cross-origin iframe), whether a
// playbackRate assignment sticks over time and across seek/pause, whether
// caption tracks are exposed through the standard textTracks API, which
// player libraries are detectable on window, and the page's CSP.
//
// NOT part of the vitest suite: drives a real browser against real sites, no
// login, no bypass. Run: bun run scripts/probe-generic-players.ts
// Flags: --headed, --limit=N (first N sites), --site=NAME (one site).
// Results: scripts/data/generic-player-results.jsonl
// Method and findings: docs/phase0-generic-probe.md
//
// Exit codes: 0 = run completed, 1 = the run failed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Frame, type Page } from 'playwright';
import {
  captionsProbe,
  detectPlayers,
  emptyCaptionsProbe,
  emptyVideoProbe,
  initRateProbe,
  liveChannelUrlInPage,
  measureFrameStructure,
  pausePlayProbe,
  sampleRate,
  seekProbe,
  videoCountInFrame,
  type CaptionsProbe,
  type FrameInfo,
  type VideoProbe,
} from './probe-measure';

interface ProbeSite {
  name: string;
  category: string;
  url: string;
}

const SITES: ProbeSite[] = [
  { name: 'vimeo-page', category: 'vimeo', url: 'https://vimeo.com/1084537' },
  {
    name: 'vimeo-embed',
    category: 'vimeo',
    url: 'https://player.vimeo.com/video/1084537',
  },
  {
    name: 'coursera',
    category: 'mooc',
    url: 'https://www.coursera.org/learn/learning-how-to-learn',
  },
  {
    name: 'twitch-live',
    category: 'twitch',
    url: 'https://www.twitch.tv/directory/gaming',
  },
  {
    name: 'embed-host-fixture',
    category: 'embed-host',
    url: new URL('data/embed-host-fixture.html', import.meta.url).href,
  },
  {
    name: 'youtube-embed-direct',
    category: 'embed-host',
    url: 'https://www.youtube-nocookie.com/embed/iG9CE55wbtY',
  },
  {
    name: 'native-baseline',
    category: 'native',
    url: 'https://www.w3schools.com/html/html5_video.asp',
  },
  { name: 'drm-landing', category: 'drm', url: 'https://www.disneyplus.com/' },
];

interface ProbeRecord {
  site: string;
  category: string;
  url: string;
  status: 'ok' | 'blocked' | 'error';
  error: string | null;
  landedUrl: string;
  channelUrl: string | null;
  note: string | null;
  frames: FrameInfo[];
  frameCount: number;
  crossOriginFrameCount: number;
  iframeCount: number;
  totalVideoCount: number;
  target: { frameUrl: string; sameOrigin: boolean; videoIndex: number } | null;
  video: VideoProbe;
  captions: CaptionsProbe;
  player: string[];
  csp: string | null;
  consoleErrors: string[];
}

const RESULTS_DIR = fileURLToPath(new URL('data/', import.meta.url));
const RESULTS_FILE = fileURLToPath(new URL('data/generic-player-results.jsonl', import.meta.url));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function emptyRecord(site: ProbeSite): ProbeRecord {
  return {
    site: site.name,
    category: site.category,
    url: site.url,
    status: 'ok',
    error: null,
    landedUrl: '',
    channelUrl: null,
    note: null,
    frames: [],
    frameCount: 0,
    crossOriginFrameCount: 0,
    iframeCount: 0,
    totalVideoCount: 0,
    target: null,
    video: emptyVideoProbe(),
    captions: emptyCaptionsProbe(),
    player: [],
    csp: null,
    consoleErrors: [],
  };
}

async function waitForVideoAnywhere(page: Page, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const n = await f.evaluate(videoCountInFrame).catch(() => 0);
      if (n > 0) return;
    }
    await sleep(500);
  }
}

async function measureFrames(page: Page): Promise<{
  frameInfos: FrameInfo[];
  targetVideos: FrameInfo[];
  mainIframeCount: number;
}> {
  const main = page.mainFrame();
  const mainOrigin = new URL(main.url()).origin;
  const frameInfos: FrameInfo[] = [];
  const targetVideos: FrameInfo[] = [];
  let mainIframeCount = 0;
  for (const f of page.frames()) {
    if (!/^https?:/.test(f.url())) continue;
    const structure = await f.evaluate(measureFrameStructure).catch(() => ({
      videoCount: 0,
      iframeCount: 0,
      crossOriginIframes: 0,
    }));
    const sameOrigin = f === main ? true : new URL(f.url()).origin === mainOrigin;
    const info: FrameInfo = { url: f.url(), sameOrigin, videoCount: structure.videoCount };
    frameInfos.push(info);
    if (f === main) mainIframeCount = structure.iframeCount;
    if (structure.videoCount > 0) targetVideos.push(info);
  }
  return { frameInfos, targetVideos, mainIframeCount };
}

async function applySample(
  out: VideoProbe,
  frame: Frame,
  field: 'after2s' | 'afterSeek' | 'afterPausePlay',
): Promise<void> {
  const s = await frame.evaluate(sampleRate);
  if (s) {
    out[field] = s.rate;
    out.ratechangeEvents = s.ratechange;
  }
}

async function probePlaybackRate(
  page: Page,
  frame: Frame,
  index: number,
): Promise<VideoProbe> {
  const out = emptyVideoProbe();
  const init = await frame.evaluate(initRateProbe, index);
  if (!init) return out;
  Object.assign(out, init);
  await sleep(2000);
  await applySample(out, frame, 'after2s');
  await frame.evaluate(seekProbe).catch(() => undefined);
  await sleep(800);
  await applySample(out, frame, 'afterSeek');
  await frame.evaluate(pausePlayProbe).catch(() => undefined);
  await sleep(800);
  await applySample(out, frame, 'afterPausePlay');
  return out;
}

async function probeCaptions(frame: Frame, index: number): Promise<CaptionsProbe> {
  const found = await frame.evaluate(captionsProbe, index);
  return found ?? emptyCaptionsProbe();
}

async function probeTargetFrame(
  page: Page,
  target: FrameInfo,
): Promise<{ video: VideoProbe; captions: CaptionsProbe; player: string[] }> {
  const frame = page.frames().find((f) => f.url() === target.url) ?? page.mainFrame();
  const video = await probePlaybackRate(page, frame, 0);
  const captions = await probeCaptions(frame, 0);
  const player = await frame.evaluate(detectPlayers).catch(() => [] as string[]);
  return { video, captions, player };
}

async function findLiveChannelUrl(page: Page): Promise<string | null> {
  try {
    await page.waitForSelector('[data-a-target="card-link"]', { timeout: 15_000 });
  } catch {
    return null;
  }
  return page.evaluate(liveChannelUrlInPage);
}

async function navigate(page: Page, url: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function probeSite(context: BrowserContext, site: ProbeSite): Promise<ProbeRecord> {
  const record = emptyRecord(site);
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' && record.consoleErrors.length < 5) {
      record.consoleErrors.push(msg.text().slice(0, 200));
    }
  });
  page.on('response', (res) => {
    if (
      res.request().isNavigationRequest() &&
      res.request().frame() === page.mainFrame()
    ) {
      const policy = res.headers()['content-security-policy'];
      record.csp = policy ? policy.slice(0, 160) : null;
    }
  });
  try {
    await navigate(page, site.url);
    record.landedUrl = page.url();

    if (site.name === 'twitch-live') {
      let channelUrl = await findLiveChannelUrl(page);
      if (!channelUrl) {
        // second attempt: the homepage lists live channels too
        await navigate(page, 'https://www.twitch.tv/');
        channelUrl = await findLiveChannelUrl(page);
      }
      if (!channelUrl) {
        record.status = 'blocked';
        record.error = 'no live channel link found (429 from this IP)';
        return record;
      }
      record.channelUrl = channelUrl;
      await navigate(page, channelUrl);
      record.landedUrl = page.url();
    }

    await waitForVideoAnywhere(page);
    await sleep(2000);

    const { frameInfos, targetVideos, mainIframeCount } = await measureFrames(page);
    record.frames = frameInfos.slice(0, 12);
    record.frameCount = frameInfos.length;
    record.crossOriginFrameCount = frameInfos.filter((f) => !f.sameOrigin).length;
    record.iframeCount = mainIframeCount;
    record.totalVideoCount = frameInfos.reduce((sum, f) => sum + f.videoCount, 0);

    const target = targetVideos[0] ?? null;
    if (target) {
      record.target = { frameUrl: target.url, sameOrigin: target.sameOrigin, videoIndex: 0 };
      const measured = await probeTargetFrame(page, target);
      record.video = measured.video;
      record.captions = measured.captions;
      record.player = measured.player;
    }

    if (site.name === 'coursera' && record.totalVideoCount === 0) {
      // second attempt: the lecture path confirms whether content is behind login
      await navigate(
        page,
        'https://www.coursera.org/learn/learning-how-to-learn/home/welcome',
      ).catch(() => undefined);
      record.note = `welcome page landed on ${page.url()}`;
    }
  } catch (err) {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
  } finally {
    await page.close();
  }
  return record;
}

function summarize(record: ProbeRecord): string {
  if (record.status !== 'ok') {
    return `STATUS ${record.status} (${record.error ?? 'no detail'})`;
  }
  const parts = [`videos=${record.totalVideoCount}`];
  if (record.target) {
    const v = record.video;
    parts.push(
      `rate ${v.setRate} -> 2s:${v.after2s} seek:${v.afterSeek} pp:${v.afterPausePlay} (ratechange x${v.ratechangeEvents})`,
    );
    parts.push(`tracks=${record.captions.textTrackCount}`);
    parts.push(`player=${record.player.join(',') || 'native-or-unknown'}`);
    parts.push(record.target.sameOrigin ? 'same-origin' : 'CROSS-ORIGIN');
  } else {
    parts.push('no-video');
  }
  return parts.join(' | ');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const siteArg = args.find((a) => a.startsWith('--site='));
  const siteName = siteArg ? siteArg.slice('--site='.length) : null;
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : SITES.length;
  let sites = SITES;
  if (siteName) {
    sites = sites.filter((s) => s.name === siteName);
    if (sites.length === 0) {
      console.error(`unknown site: ${siteName}`);
      process.exit(1);
    }
  }
  sites = sites.slice(0, limit);

  mkdirSync(RESULTS_DIR, { recursive: true });

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

  const results: ProbeRecord[] = [];
  for (const site of sites) {
    process.stdout.write(`probing ${site.name} [${site.category}] ... `);
    const record = await probeSite(context, site);
    results.push(record);
    console.log(summarize(record));
  }
  await browser.close();

  const lines = results.map((r) => JSON.stringify(r));
  writeFileSync(RESULTS_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`\nresults -> ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
