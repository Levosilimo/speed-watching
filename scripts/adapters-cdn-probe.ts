// CDN fetch probe — Dzen/Rutube caption carriers from the page context
// (verdict: docs/adapters-cdn-probe.md). Closes the CORS inference in
// docs/adapters.md by issuing the EXACT production cors-mode fetch against
// real carriers: video > track[src] read as production reads it, then a
// page-context fetch classified cors-blocked / signed-expiry / http-error
// / parse-fail / fetch-ok, with fetch-ok bytes parsed in Node by the
// production parsers. No login, no bypass; walls recorded. No-cors element
// loads are never counted — only the explicit fetch outcome.
//
// Video URLs come from the probe-verified manifest seeds plus each
// platform's trending page (top-up), so the sample is current popular
// public content that previously delivered captions.
//
// Run: bun run scripts/adapters-cdn-probe.ts [--headless] [--limit=N]
// Results: scripts/data/adapters-cdn-probe/results.jsonl
// Exit codes: 0 = run completed (failures are data), 1 = harness crash.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  attemptPlay,
  clickSubtitleButton,
  detectWall,
  GOTO_TIMEOUT_MS,
  waitForVideo,
} from './vk-probe-measure';
import { withTimeout } from './vk-probe-network';
import {
  probeCarrier,
  readTrackSrcs,
  recordLine,
  summarize,
  videoVerdict,
  type CarrierRecord,
  type PlatformName,
  type ProbeRecord,
} from './adapters-cdn-probe-lib';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = join(ROOT, 'data', 'adapters-cdn-probe');
const RESULTS_FILE = join(OUT_DIR, 'results.jsonl');
const MANIFEST_FILE = join(OUT_DIR, 'manifest.json');
const PAGE_PACE_MS = 2500;
const LAUNCH_TIMEOUT_MS = 120_000;
const VIDEO_WAIT_MS = 20_000;
const CAPTURE_WINDOW_MS = 10_000;
const SAMPLE_DEADLINE_MS = 110_000;

interface DiscoverSpec {
  name: PlatformName;
  discoverUrls: string[];
  videoPattern: RegExp;
}

const DISCOVER: Record<PlatformName, DiscoverSpec> = {
  rutube: {
    name: 'rutube',
    discoverUrls: ['https://rutube.ru/feeds/top/'],
    videoPattern: /https:\/\/rutube\.ru\/video\/[0-9a-f]{32}/,
  },
  dzen: {
    name: 'dzen',
    discoverUrls: ['https://dzen.ru/video'],
    videoPattern: /\/video\/watch\/[0-9a-f-]{20,40}/,
  },
};

// Trending-page links are the curated top-up sample: the platform's own
// popular public videos, picked at run time. Same harvest as vk-probe's
// discovery (that function runs under vk-probe.ts's module-level main and
// is not importable).
async function collectHrefs(page: Page, patternSource: string): Promise<string[]> {
  const hrefs: string[] = [];
  for (const frame of page.frames()) {
    try {
      const found = await withTimeout(
        frame.evaluate(
          (source: string) => {
            const pattern = new RegExp(source);
            return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
              .map((a) => a.href)
              .filter((h) => pattern.test(h));
          },
          patternSource,
        ),
        3000,
        [],
      );
      hrefs.push(...found);
    } catch {
      // frame navigated away or evaluate timed out
    }
  }
  return hrefs;
}

async function discoverVideos(context: BrowserContext, spec: DiscoverSpec, want: number): Promise<string[]> {
  const page = await withTimeout(context.newPage(), 10_000, null);
  if (page === null) return [];
  const links = new Set<string>();
  const deadline = Date.now() + 25_000;
  try {
    for (const discoverUrl of spec.discoverUrls) {
      try {
        await page.goto(discoverUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch {
        continue;
      }
      while (Date.now() < deadline) {
        for (const href of await collectHrefs(page, spec.videoPattern.source)) links.add(href);
        if (links.size >= want) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (links.size >= want) break;
    }
  } finally {
    await withTimeout(page.close(), 10_000, undefined).catch(() => undefined);
  }
  return [...links].slice(0, want);
}

async function setupBrowser(headed: boolean): Promise<{ browser: Browser; context: BrowserContext }> {
  const probe = await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS });
  const version = probe.version();
  await probe.close();
  const browser = await chromium.launch({
    headless: !headed,
    timeout: LAUNCH_TIMEOUT_MS,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'ru-RU',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7' },
    viewport: { width: 1280, height: 800 },
  });
  return { browser, context };
}

// Per-video flow: goto → wall check → wait for player → play + CC toggle
// (Dzen/Rutube mount their <track> after the toggle) → capture window →
// track[src] read → per-carrier page-context fetch → Node parse → verdict.
async function sampleCarriers(context: BrowserContext, platform: PlatformName, url: string): Promise<ProbeRecord> {
  const record: ProbeRecord = { platform, url, title: null, status: 'error', reason: null, carriers: [], probeMs: 0 };
  const started = Date.now();
  const page = await withTimeout(context.newPage(), 10_000, null);
  if (page === null) {
    record.reason = 'browser-unresponsive (newPage timeout)';
    record.probeMs = Date.now() - started;
    return record;
  }
  const body = (async () => {
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch (err) {
        record.reason = err instanceof Error && err.message ? err.message : String(err);
        const wall = await detectWall(page);
        if (wall.class !== null) {
          record.status = wall.class;
          record.reason = `${record.reason} (${wall.reason})`;
        }
        record.probeMs = Date.now() - started;
        return;
      }
      record.title = await withTimeout(page.title(), 3000, null);
      const wall = await detectWall(page);
      if (wall.class !== null) {
        record.status = wall.class;
        record.reason = wall.reason;
        record.probeMs = Date.now() - started;
        return;
      }
      const videoMounted = await waitForVideo(page, VIDEO_WAIT_MS);
      if (!videoMounted) {
        record.status = 'no-video';
        record.reason = 'no video element mounted';
        record.probeMs = Date.now() - started;
        return;
      }
      await attemptPlay(page);
      await clickSubtitleButton(page);
      await page.waitForTimeout(CAPTURE_WINDOW_MS);
      const srcs = await readTrackSrcs(page);
      if (srcs.length === 0) {
        record.status = 'no-track';
        record.reason = 'no video > track[src] on page';
        record.probeMs = Date.now() - started;
        return;
      }
      const carriers: CarrierRecord[] = [];
      for (const src of srcs) carriers.push(await probeCarrier(page, src));
      record.carriers = carriers;
      const verdict = videoVerdict(carriers, srcs.length);
      record.status = verdict.status;
      record.reason = verdict.reason;
    } catch (err) {
      record.status = 'error';
      record.reason = err instanceof Error && err.message ? err.message : String(err);
    } finally {
      await withTimeout(page.close(), 5000, undefined).catch(() => undefined);
    }
  })();
  const finished = await withTimeout(body, SAMPLE_DEADLINE_MS, null);
  if (finished === null) {
    record.status = 'error';
    record.reason = 'sample-timeout';
    await withTimeout(page.close(), 5000, undefined).catch(() => undefined);
  }
  record.probeMs = Date.now() - started;
  return record;
}

// Chromium on this box intermittently freezes under sustained page churn;
// recycling the browser per video caps the blast radius (vk-probe pattern).
async function sampleWithFreshBrowser(
  headed: boolean,
  platform: PlatformName,
  url: string,
): Promise<ProbeRecord> {
  const fresh = await setupBrowser(headed);
  try {
    const record = await withTimeout(
      sampleCarriers(fresh.context, platform, url).catch((err) => {
        const failed: ProbeRecord = { platform, url, title: null, status: 'error', reason: null, carriers: [], probeMs: 0 };
        failed.reason = err instanceof Error && err.message ? err.message : String(err);
        return failed;
      }),
      3 * 60_000,
      null,
    );
    if (record !== null) return record;
    const failed: ProbeRecord = { platform, url, title: null, status: 'error', reason: null, carriers: [], probeMs: 0 };
    failed.reason = 'video-deadline-exceeded';
    return failed;
  } finally {
    await withTimeout(fresh.browser.close(), 10_000, undefined).catch(() => undefined);
  }
}

// Carrier-bearing target per platform: the verified seed count plus
// trending top-up until the Rutube author gate is beaten ~2× over.
const CARRIER_TARGET: Record<PlatformName, number> = { dzen: 4, rutube: 6 };
const EXTRA_CAP: Record<PlatformName, number> = { dzen: 4, rutube: 8 };

interface Seed {
  url: string;
  verified: boolean;
}

interface RunState {
  context: BrowserContext;
  headed: boolean;
  records: ProbeRecord[];
  sampled: Set<string>;
  carrierCount: Map<PlatformName, number>;
  runDeadline: number;
  limit: number;
  lastAppendAt: number;
}

function loadSeeds(): Map<PlatformName, Seed[]> {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as {
    seeds: { platform: PlatformName; url: string; verified?: boolean }[];
  };
  const seeds = new Map<PlatformName, Seed[]>();
  for (const seed of manifest.seeds) {
    const list = seeds.get(seed.platform) ?? [];
    list.push({ url: seed.url, verified: seed.verified ?? false });
    seeds.set(seed.platform, list);
  }
  return seeds;
}

function appendRecord(state: RunState, record: ProbeRecord): void {
  state.records.push(record);
  // Append per record so a mid-run kill never loses completed samples.
  writeFileSync(RESULTS_FILE, JSON.stringify(record) + '\n', { flag: 'a' });
  state.lastAppendAt = Date.now();
}

async function sampleOne(state: RunState, platform: PlatformName, url: string): Promise<void> {
  process.stdout.write(`adapters-cdn-probe ${platform} ${url} ... `);
  const record = await sampleWithFreshBrowser(state.headed, platform, url);
  appendRecord(state, record);
  console.log(recordLine(record));
  if (record.carriers.length > 0) {
    state.carrierCount.set(platform, (state.carrierCount.get(platform) ?? 0) + 1);
  }
  await new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
}

// Manifest seeds first, then trending top-up until the platform's
// carrier-bearing target is met (a dead seed yields an honest
// no-track/no-video record plus discovery top-up).
async function runPlatform(state: RunState, platform: PlatformName, seedList: Seed[]): Promise<void> {
  for (const seed of seedList) {
    if (Date.now() > state.runDeadline) return;
    await sampleOne(state, platform, seed.url);
  }
  let extra = 0;
  const spec = DISCOVER[platform];
  while (
    (state.carrierCount.get(platform) ?? 0) < CARRIER_TARGET[platform] &&
    extra < EXTRA_CAP[platform] &&
    Date.now() < state.runDeadline &&
    (state.carrierCount.get(platform) ?? 0) + extra < state.limit
  ) {
    const discovered = await discoverVideos(state.context, spec, 6);
    let toppedUp = false;
    for (const url of discovered) {
      if (state.sampled.has(url)) continue;
      state.sampled.add(url);
      extra += 1;
      await sampleOne(state, platform, url);
      toppedUp = true;
      if (
        (state.carrierCount.get(platform) ?? 0) >= CARRIER_TARGET[platform] ||
        extra >= EXTRA_CAP[platform] ||
        Date.now() > state.runDeadline
      ) {
        break;
      }
    }
    if (!toppedUp || discovered.length === 0) return;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = !args.includes('--headless');
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const limit = limitArg === undefined ? Infinity : Number(limitArg);
  if (limitArg !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    console.error('--limit must be a positive number');
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const seeds = loadSeeds();
  console.log(`adapters-cdn-probe: platforms=${[...seeds.keys()].join(',')} headed=${headed} limit=${Number.isFinite(limit) ? limit : '∞'}`);

  const { browser, context } = await setupBrowser(headed);
  const state: RunState = {
    context,
    headed,
    records: [],
    sampled: new Set(),
    carrierCount: new Map(),
    runDeadline: Date.now() + 25 * 60_000,
    limit,
    lastAppendAt: Date.now(),
  };
  for (const [platform, seedList] of seeds) {
    for (const seed of seedList) state.sampled.add(seed.url);
    state.carrierCount.set(platform, 0);
  }
  // A frozen chromium can stall a CDP call past every deadline; a watchdog
  // exits instead of hanging (records are live-appended, so the run keeps
  // its data). vk-probe pattern.
  const watchdog = setInterval(() => {
    const idleMs = Date.now() - state.lastAppendAt;
    if (idleMs > 8 * 60_000) {
      console.error(`watchdog: no record for ${Math.round(idleMs / 1000)}s — exiting`);
      process.exit(0);
    }
  }, 30_000);
  try {
    for (const [platform, seedList] of seeds) await runPlatform(state, platform, seedList);
  } finally {
    clearInterval(watchdog);
    await browser.close().catch(() => undefined);
  }
  console.log(`\nresults -> ${RESULTS_FILE} (${state.records.length} records)`);
  summarize(state.records);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
