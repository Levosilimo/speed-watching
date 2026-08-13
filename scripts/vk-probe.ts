// Tier 2b platform probe — VK Video / Rutube / Дзен caption reality
// (verdict: docs/vk-probe.md). Per popular public video it records whether
// a player mounts, whether captions exist at three layers — the textTracks
// API, the player's subtitle button, and the network (HLS EXT-X-MEDIA
// TYPE=SUBTITLES, SRT/VTT/JSON subtitle responses) — and at what timing
// granularity the delivered payloads run. No login, no bypass; walls are
// recorded with the class vocabulary: no-captions / login-wall / geo-block
// / no-video / parse-unknown. Measurement layer: scripts/vk-probe-measure.ts.
//
// Video URLs come from each platform's own trending page (first N links),
// so the sample is the platform's current popular public content.
//
// Run: bun run scripts/vk-probe.ts [--headless] [--per-platform=N] [--platform=NAME]
// Results: scripts/data/vk-probe/results.jsonl
// Exit codes: 0 = run completed (failures are data), 1 = harness crash.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import {
  detectWall,
  GOTO_TIMEOUT_MS,
  initRecord,
  sampleVideo,
  type PlatformName,
  type PlatformSpec,
  type ProbeStatus,
  type VkProbeRecord,
  type Wall,
} from './vk-probe-measure';
import { withTimeout } from './vk-probe-network';
const PLATFORMS: PlatformSpec[] = [
  {
    name: 'vk',
    label: 'VK Video',
    discoverUrls: ['https://vkvideo.ru/', 'https://vk.com/video'],
    videoPattern: /\/video-?\d+_\d+/,
  },
  {
    name: 'rutube',
    label: 'Rutube',
    discoverUrls: ['https://rutube.ru/feeds/top/'],
    videoPattern: /https:\/\/rutube\.ru\/video\/[0-9a-f]{32}/,
  },
  {
    name: 'dzen',
    label: 'Дзен',
    discoverUrls: ['https://dzen.ru/video'],
    videoPattern: /\/video\/watch\/[0-9a-f-]{20,40}/,
  },
];

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = join(ROOT, 'data', 'vk-probe');
const RESULTS_FILE = join(OUT_DIR, 'results.jsonl');
const PAGE_PACE_MS = 2500;
const LAUNCH_TIMEOUT_MS = 120_000;

// Trending-page links are the curated sample: the platform's own popular
// public videos, picked at run time. Normalizes VK ids to the vkvideo.ru
// web app host (vk.com video pages gate guests harder). Returns the wall
// that stopped discovery (login-wall / geo-block) when the page never
// reached its feed.
async function discoverVideos(
  context: BrowserContext,
  spec: PlatformSpec,
  perPlatform: number,
): Promise<{ urls: string[]; wall: Wall | null }> {
  const page = await withTimeout(context.newPage(), 10_000, null);
  if (page === null) return { urls: [], wall: null };
  const links = new Set<string>();
  let wall: Wall = { class: null, reason: '' };
  const deadline = Date.now() + 25_000;
  try {
    for (const discoverUrl of spec.discoverUrls) {
      try {
        await page.goto(discoverUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch {
        continue;
      }
      wall = await detectWall(page);
      if (wall.class !== null) break;
      while (Date.now() < deadline) {
        for (const frame of page.frames()) {
          try {
            const patternSource = spec.videoPattern.source;
            const hrefs = await withTimeout(
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
            for (const href of hrefs) links.add(href);
          } catch {
            // frame navigated away or evaluate timed out
          }
        }
        if (links.size >= perPlatform) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (links.size >= perPlatform) break;
    }
  } finally {
    await withTimeout(page.close(), 10_000, undefined).catch(() => undefined);
  }
  const normalized = [...links].map((href) => {
    const clean = href.split('#')[0]?.split('?')[0] ?? href;
    if (spec.name === 'vk') {
      const match = clean.match(/\/video-?\d+_\d+/);
      return match === null ? clean : `https://vkvideo.ru${match[0]}`;
    }
    return clean;
  });
  return { urls: [...new Set(normalized)].slice(0, perPlatform), wall };
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

function recordLine(record: VkProbeRecord): string {
  const base = `${record.platform} ${record.status}${record.reason ? ` (${record.reason})` : ''}`;
  if (record.status !== 'ok') return base;
  return `${base} timing=${record.timing} tracks=${record.player.textTracks} payloads=${record.network.payloads.length}`;
}

function summarize(records: VkProbeRecord[]): void {
  for (const spec of PLATFORMS) {
    const rs = records.filter((r) => r.platform === spec.name);
    if (rs.length === 0) continue;
    const ok = rs.filter((r) => r.status === 'ok');
    const words = ok.filter((r) => r.timing === 'word').length;
    const cues = ok.filter((r) => r.timing === 'cue').length;
    const byStatus = new Map<ProbeStatus, number>();
    for (const r of rs) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const classes = [...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(
      `\n${spec.label}: ${rs.length} record(s) — ok=${ok.length} (word=${words}, cue=${cues}) | ${classes}`,
    );
  }
  const header = ['platform', 'status', 'timing', 'reason'];
  const rows = records.map((r) => [
    r.platform,
    r.status,
    r.timing,
    (r.reason ?? '').slice(0, 70),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const printRow = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  console.log('\n' + printRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(printRow(row));
}

// Chromium on this box intermittently freezes under sustained page churn;
// recycling the browser per video caps the blast radius of a freeze to the
// one video it happened on (launch cost ~3 s). The harness-level race is a
// second, independent ceiling on top of sampleVideo's own deadline: if
// either timer fires, the video becomes an honest error record.
async function sampleWithFreshBrowser(headed: boolean, url: string, platform: PlatformName): Promise<VkProbeRecord> {
  const fresh = await setupBrowser(headed);
  try {
    const record = await withTimeout(
      sampleVideo(fresh.context, url, platform).catch((err) => {
        const failed = initRecord(platform, url);
        failed.status = 'error';
        failed.reason = err instanceof Error && err.message ? err.message : String(err);
        return failed;
      }),
      3 * 60_000,
      null,
    );
    if (record !== null) return record;
    const failed = initRecord(platform, url);
    failed.status = 'error';
    failed.reason = 'video-deadline-exceeded';
    return failed;
  } finally {
    await withTimeout(fresh.browser.close(), 10_000, undefined).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = !args.includes('--headless');
  const platformArg = args.find((a) => a.startsWith('--platform='))?.slice('--platform='.length);
  const videoArg = args.find((a) => a.startsWith('--video='))?.slice('--video='.length);
  const perPlatformArg = args.find((a) => a.startsWith('--per-platform='))?.slice('--per-platform='.length);
  const perPlatform = perPlatformArg === undefined ? 6 : Number(perPlatformArg);
  if (!Number.isFinite(perPlatform) || perPlatform < 1) {
    console.error('--per-platform must be a positive number');
    process.exit(2);
  }
  const platforms = PLATFORMS.filter((p) => platformArg === undefined || p.name === platformArg);
  if (platforms.length === 0) {
    console.error(`unknown platform: ${platformArg ?? ''}`);
    process.exit(2);
  }
  if (videoArg !== undefined && platforms.length !== 1) {
    console.error('--video requires --platform');
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`vk-probe: platforms=${platforms.map((p) => p.name).join(',')} per-platform=${perPlatform} headed=${headed}`);

  const { browser, context } = await setupBrowser(headed);
  const records: VkProbeRecord[] = [];
  const runDeadline = Date.now() + 25 * 60_000;
  let runBudgetExhausted = false;
  const appendRecord = (record: VkProbeRecord): void => {
    records.push(record);
    // Append per record so a mid-run kill never loses completed samples.
    writeFileSync(RESULTS_FILE, JSON.stringify(record) + '\n', { flag: 'a' });
    lastAppendAt = Date.now();
  };
  // The per-video deadline guards every await, but a frozen chromium can
  // stall a CDP call past all of them. A watchdog exits instead of hanging:
  // every record is appended live, so a truncated run still has its data.
  let lastAppendAt = Date.now();
  const watchdog = setInterval(() => {
    const idleMs = Date.now() - lastAppendAt;
    if (idleMs > 8 * 60_000) {
      console.error(`watchdog: no record for ${Math.round(idleMs / 1000)}s — exiting`);
      process.exit(0);
    }
  }, 30_000);
  try {
    for (const spec of platforms) {
      if (videoArg !== undefined) {
        process.stdout.write(`vk-probe ${spec.name} ${videoArg} ... `);
        const record = await sampleWithFreshBrowser(headed, videoArg, spec.name);
        appendRecord(record);
        console.log(recordLine(record));
        continue;
      }
      const { urls, wall } = await discoverVideos(context, spec, perPlatform);
      if (urls.length === 0) {
        const record = initRecord(spec.name, spec.discoverUrls[0] ?? '');
        const wallClass = wall?.class ?? null;
        record.status = wallClass ?? 'error';
        record.reason =
          wallClass !== null && wall !== null ? wall.reason : `discovery failed on ${spec.discoverUrls.join(', ')}`;
        appendRecord(record);
        console.log(`${spec.label}: no video links found on ${spec.discoverUrls.join(', ')}`);
        continue;
      }
      console.log(`${spec.label}: discovered ${urls.length} video(s) from trending`);
      for (const url of urls) {
        if (Date.now() > runDeadline) {
          runBudgetExhausted = true;
          break;
        }
        process.stdout.write(`vk-probe ${spec.name} ${url} ... `);
        const record = await sampleWithFreshBrowser(headed, url, spec.name);
        appendRecord(record);
        console.log(recordLine(record));
        await new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
      }
      if (runBudgetExhausted) break;
    }
  } finally {
    clearInterval(watchdog);
    await browser.close().catch(() => undefined);
  }
  console.log(`\nresults -> ${RESULTS_FILE} (${records.length} records)`);
  summarize(records);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
