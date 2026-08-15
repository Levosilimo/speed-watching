// Real-site extension runner — per-video sampling machinery
// (scripts/realsite-runner.ts drives it, docs/realsite-run.md is the runbook).
// Drives the BUILT e2e extension (.output/chrome-mv3-e2e — the __E2E__ hooks
// and console.info lines are live) against real youtube.com videos and
// records what the fixture suite cannot see: the rendered pill, the
// POT-gated caption path, live/music suppression, real session state.
// Split out so both files stay under the repo's 400-line cap; the registry
// field-diff lives in scripts/rate-field-diff.ts (same cap).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';import { chromium, type BrowserContext } from 'playwright';
import type { MeasureEventDetail } from '../lib/measure-hooks';
import type { PillState } from '../ui/pill';
import { dismissConsentIfPresent, pageErrorHint, readPlayerInfo } from './web-capture';
import { withTimeout } from './vk-probe-network';
import type { RateFieldDiff } from './rate-field-diff';

export type VideoKind = 'speech' | 'music' | 'live';

export interface VideoSpec {
  videoId: string;
  category: string;
  kind: VideoKind;
}

/** A serialized getBoundingClientRect. */
export interface RectRecord {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RealsiteRecord {
  videoId: string;
  url: string;
  category: string;
  kind: VideoKind;
  title: string | null;
  pillRendered: boolean;
  mode: PillState['mode'] | null;
  tier: string | null;
  rate: number | null;
  lang: string | null;
  source: 'web' | 'android' | 'capture' | 'none' | null;
  measure: MeasureEventDetail | null;
  pillRect: RectRecord | null;
  playerRect: RectRecord | null;
  pillInsidePlayer: boolean;
  clearsControls: boolean;
  occludedAtCenter: boolean;
  consoleLines: string[];
  /** Trace zip for the sampling run, or null when tracing could not start. */
  tracePath: string | null;
  /** Field-diff vs the golden-master registry: the measured rate vs the
   * row's recorded full-payload rate for the same metric class, within the
   * pinned ratesRel band. Null when no anchor exists (no registry row, no
   * recorded rate for the metric, or no measured rate). Report-only — the
   * pass gate (evaluatePass) does not read it. */
  rateDiff: RateFieldDiff | null;
  pass: boolean;
  reason: string | null;
}

declare global {
  interface Window {
    /** The runner's mirror of the userscript hook (scripts/build-userscript.ts). */
    __speedwatcherLastMeasure?: MeasureEventDetail;
  }
}

const VIDEO_DEADLINE_MS = 3 * 60_000;
const PILL_WAIT_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 120_000;

/** Best available measured rate — the pill math uses word-level for ASR and
 * cue-level for manual tracks, so prefer in that order. Shared with the
 * registry field-diff (scripts/rate-field-diff.ts). */
export function bestRate(stats: MeasureEventDetail['stats']): number | null {
  const candidates = [stats.word, stats.cue, stats.corrected];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

export function initRecord(spec: VideoSpec): RealsiteRecord {
  return {
    videoId: spec.videoId,
    url: `https://www.youtube.com/watch?v=${spec.videoId}`,
    category: spec.category,
    kind: spec.kind,
    title: null,
    pillRendered: false,
    mode: null,
    tier: null,
    rate: null,
    lang: null,
    source: null,
    measure: null,
    pillRect: null,
    playerRect: null,
    pillInsidePlayer: false,
    clearsControls: false,
    occludedAtCenter: false,
    consoleLines: [],
    tracePath: null,
    rateDiff: null,
    pass: false,
    reason: null,
  };
}

/** Launch a fresh persistent context with the built extension side-loaded.
 * One browser per video: chromium on this box intermittently freezes under
 * sustained page churn, so recycling caps a freeze to the video it hit. */
export async function setupBrowser(
  headed: boolean,
  extensionDir: string,
): Promise<{ context: BrowserContext; close(): Promise<void> }> {
  // probe for the CfT version so the UA matches the real Chrome build
  const probe = await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS });
  const version = probe.version();
  await probe.close();
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-realsite-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    timeout: LAUNCH_TIMEOUT_MS,
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  // consent cookies: without them the default CC track is the manual
  // transcript, not ASR (gate1-residential.ts parity)
  await context.addCookies([
    { name: 'CONSENT', value: 'YES+cb.20220301-01-p0.en+FX+000', domain: '.youtube.com', path: '/' },
    { name: 'SOCS', value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY', domain: '.youtube.com', path: '/' },
  ]);
  // the MV3 service worker must be up before navigation or the content
  // script is not injected (e2e.chromium pattern)
  if (context.serviceWorkers()[0] === undefined) {
    await context.waitForEvent('serviceworker', { timeout: 30_000 }).catch(() => undefined);
  }
  return { context, close: () => context.close() };
}

async function sampleOnce(
  context: BrowserContext,
  spec: VideoSpec,
  record: RealsiteRecord,
): Promise<RealsiteRecord> {
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('[speed-watcher]')) consoleLines.push(text);
  });
  // The extension dispatches speedwatcher:measure on window; the init script
  // mirrors the userscript hook so the runner can read the last payload
  // after the pill renders.
  await page.addInitScript(() => {
    window.addEventListener('speedwatcher:measure', (event: Event) => {
      window.__speedwatcherLastMeasure = (event as CustomEvent<MeasureEventDetail>).detail;
    });
  });
  try {
    await page.goto(record.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissConsentIfPresent(page);
    // The hook mounts with the content script; the state renders once
    // measureOnce finishes (measured or estimated) — live/music included.
    await page
      .waitForFunction(() => window.__speedwatcherPill?.state != null, undefined, { timeout: PILL_WAIT_MS })
      .catch(() => undefined);
    const info = await readPlayerInfo(page).catch(() => null);
    record.title = info?.title ?? null;
    const pill = await page
      .evaluate(() => window.__speedwatcherPill?.state ?? null)
      .catch(() => null);
    const measure = await page
      .evaluate(() => window.__speedwatcherLastMeasure ?? null)
      .catch(() => null);
    const source = await page
      .evaluate(() => window.__speedwatcherCaptionSource ?? null)
      .catch(() => null);
    record.pillRendered = pill !== null;
    record.mode = pill?.mode ?? null;
    record.tier = pill?.tierLabel ?? null;
    record.measure = measure;
    record.rate = measure === null ? null : bestRate(measure.stats);
    record.lang = measure?.lang ?? null;
    record.source = source;
    record.consoleLines = consoleLines;
    // Pill placement geometry: the pill's rect vs the player's, and whether
    // the pill is the hit target at its center (elementFromPoint reports
    // the host for shadow content — anything else means occlusion).
    const geometry = await page
      .evaluate(() => {
        const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
        const player = document.querySelector<HTMLElement>('#movie_player');
        const pill = host?.shadowRoot?.querySelector<HTMLElement>('.pill');
        if (host === null || player === null || pill === null || pill === undefined) return null;
        const pillRect = pill.getBoundingClientRect();
        const playerRect = player.getBoundingClientRect();
        const atCenter = document.elementFromPoint(
          pillRect.left + pillRect.width / 2,
          pillRect.top + pillRect.height / 2,
        );
        const rect = (r: DOMRect): RectRecord => ({
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
        });
        return {
          pill: rect(pillRect),
          player: rect(playerRect),
          atCenterIsHost: atCenter === host,
        };
      })
      .catch(() => null);
    if (geometry !== null) {
      record.pillRect = geometry.pill;
      record.playerRect = geometry.player;
      const { pill, player } = geometry;
      record.pillInsidePlayer =
        pill.left >= player.left &&
        pill.top >= player.top &&
        pill.right <= player.right &&
        pill.bottom <= player.bottom;
      // The pill must clear the right-cluster control buttons — the 2026
      // player's band spans 12–60px above the bottom (48px button + 12px
      // top margin), so the pill's bottom edge needs ≥ 60px clearance.
      record.clearsControls = player.bottom - pill.bottom >= 60;
      record.occludedAtCenter = !geometry.atCenterIsHost;
    }
    if (!record.pillRendered) {
      const hint = await pageErrorHint(page);
      record.reason = hint === null ? 'no-pill-render' : `no-pill-render (${hint})`;
    }
    evaluatePass(record);
  } catch (err) {
    record.pass = false;
    record.reason = err instanceof Error && err.message ? err.message : String(err);
  } finally {
    await page.close().catch(() => undefined);
  }
  return record;
}

/** Per-class pass rule: speech needs the pill + a caption source + a sane
 * measured rate; music and live need their designed suppression. */
export function evaluatePass(record: RealsiteRecord): void {
  const failures: string[] = [];
  if (!record.pillRendered || record.mode === null) {
    failures.push('no-pill-render');
  } else if (record.kind === 'live') {
    if (record.mode !== 'none') failures.push(`live suppression: mode=${record.mode}`);
  } else if (record.kind === 'music') {
    if (record.mode !== 'music') failures.push(`music suppression: mode=${record.mode}`);
  } else {
    if (record.mode === 'none') failures.push('pill suppressed');
    if (record.source === null || record.source === 'none') {
      failures.push(`caption source=${record.source ?? 'missing'}`);
    }
    if (record.rate === null || record.rate < 100 || record.rate > 600) {
      failures.push(`rate=${record.rate === null ? 'n/a' : record.rate.toFixed(1)} outside 100-600`);
    }
    // Placement gates: the pill must sit inside the player, clear the
    // controls bar, and be the hit target at its center.
    if (record.pillRect === null || record.playerRect === null) {
      failures.push('no-pill-geometry');
    } else {
      if (!record.pillInsidePlayer) failures.push('pill-outside-player');
      if (!record.clearsControls) failures.push('pill-not-above-controls');
      if (record.occludedAtCenter) failures.push('pill-occluded');
    }
  }
  record.pass = failures.length === 0;
  record.reason = failures.length === 0 ? null : failures.join('; ');
}

/** Sample one video in its own fresh browser; the deadline covers a frozen
 * chromium stalling a CDP call past every inner wait. Each sampling run is
 * wrapped in context tracing (screenshots + snapshots) so a failed video
 * leaves a replayable trace next to results.jsonl. */
export async function sampleVideo(
  headed: boolean,
  spec: VideoSpec,
  extensionDir: string,
  traceDir: string,
): Promise<RealsiteRecord> {
  const record = initRecord(spec);
  // A churned chromium can die at launch, not just mid-page; that is a
  // per-video error record, not a harness crash.
  let fresh: { context: BrowserContext; close(): Promise<void> };
  try {
    fresh = await setupBrowser(headed, extensionDir);
  } catch (err) {
    record.pass = false;
    record.reason = `browser-launch-failed: ${err instanceof Error && err.message ? err.message : String(err)}`;
    return record;
  }
  try {
    // A context that cannot trace must not fail the sample; the trace path
    // stays null then.
    await withTimeout(
      fresh.context.tracing.start({ screenshots: true, snapshots: true }),
      10_000,
      undefined,
    ).catch(() => undefined);
    const sampled = await withTimeout(
      sampleOnce(fresh.context, spec, record).catch((err) => {
        record.pass = false;
        record.reason = err instanceof Error && err.message ? err.message : String(err);
        return record;
      }),
      VIDEO_DEADLINE_MS,
      null,
    );
    if (sampled !== null) return sampled;
    record.pass = false;
    record.reason = 'video-deadline-exceeded';
    return record;
  } finally {
    const tracePath = join(traceDir, `trace-${spec.videoId}.zip`);
    // Stop before closing; a stop failure (no trace started, write error)
    // must not mask the record, so the path stays null then.
    record.tracePath = await withTimeout(
      fresh.context.tracing.stop({ path: tracePath }),
      15_000,
      null,
    )
      .then(() => tracePath)
      .catch(() => null);
    await withTimeout(fresh.close(), 10_000, undefined).catch(() => undefined);
  }
}

export function recordLine(record: RealsiteRecord): string {
  const rate = record.rate === null ? '-' : record.rate.toFixed(1);
  const lang = record.lang === null ? '' : ` lang=${record.lang}`;
  const pill = record.pillRect === null ? 'pill=-' : `pill=${record.pillInsidePlayer ? 'inside' : 'OUTSIDE'}`;
  const clears = record.playerRect === null ? 'clears=-' : `clears=${record.clearsControls ? 'yes' : 'no'}`;
  const occ = record.pillRect === null ? 'occ=-' : `occ=${record.occludedAtCenter ? 'OCCLUDED' : 'no'}`;
  const diff =
    record.rateDiff === null
      ? ''
      : ` diff=${record.rateDiff.verdict}(${record.rateDiff.relDeltaPct >= 0 ? '+' : ''}${record.rateDiff.relDeltaPct.toFixed(1)}%)`;
  return `${record.pass ? 'PASS' : 'FAIL'} mode=${record.mode ?? '-'} tier=${record.tier ?? '-'} ` +
    `rate=${rate}${lang} source=${record.source ?? '-'} ${pill} ${clears} ${occ}` +
    `${diff}` +
    `${record.reason ? ` (${record.reason})` : ''}`;
}

export function summarize(records: RealsiteRecord[]): number {
  const passed = records.filter((r) => r.pass).length;
  const ratio = records.length === 0 ? 0 : passed / records.length;
  const header = ['videoId', 'category', 'kind', 'mode', 'rate', 'source', 'pill', 'clears', 'occ', 'pass', 'reason'];
  const rows = records.map((r) => [
    r.videoId,
    r.category,
    r.kind,
    r.mode ?? '-',
    r.rate === null ? '-' : r.rate.toFixed(1),
    r.source ?? '-',
    r.pillRect === null ? '-' : r.pillInsidePlayer ? 'inside' : 'OUT',
    r.playerRect === null ? '-' : r.clearsControls ? 'yes' : 'no',
    r.pillRect === null ? '-' : r.occludedAtCenter ? 'yes' : 'no',
    r.pass ? 'PASS' : 'FAIL',
    (r.reason ?? '').slice(0, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const printRow = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  console.log('\n' + printRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(printRow(row));
  const byKind = new Map<VideoKind, { n: number; pass: number }>();
  for (const r of records) {
    const entry = byKind.get(r.kind) ?? { n: 0, pass: 0 };
    entry.n += 1;
    if (r.pass) entry.pass += 1;
    byKind.set(r.kind, entry);
  }
  const strata = [...byKind.entries()].map(([kind, e]) => `${kind}=${e.pass}/${e.n}`).join(', ');
  console.log(`\npass: ${passed}/${records.length} (${(ratio * 100).toFixed(1)}%) | ${strata}`);
  const diffs = records.flatMap((r) => (r.rateDiff === null ? [] : [r.rateDiff]));
  if (diffs.length > 0) {
    console.log("\nfield-diff (measured vs the registry's recorded full-payload rate, same metric):");
    for (const d of diffs) {
      const delta = `${d.relDeltaPct >= 0 ? '+' : ''}${d.relDeltaPct.toFixed(1)}%`;
      console.log(
        `  ${d.videoId.padEnd(14)} ${d.metric.padEnd(9)} pinned=${d.pinnedWpm.toFixed(1)} ` +
          `measured=${d.measuredWpm.toFixed(1)} ${delta.padEnd(8)} ${d.verdict.toUpperCase()}`,
      );
    }
    const benign = diffs.filter((d) => d.verdict === 'benign').length;
    const noPin = records.filter((r) => r.kind === 'speech' && r.rateDiff === null).length;
    console.log(`field-diff: benign=${benign} breaking=${diffs.length - benign} no-pin=${noPin}`);
  }
  return ratio;
}
