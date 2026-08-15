// Drift-triage runner: re-captures the golden-master registry's real
// videoIds through the player-signed timedtext intercept (the POT-aware WEB
// capture, same machinery as scripts/sample-captions.ts), truncates
// identically (20 events / 12 windows), and classifies the diff vs the
// committed registry rows (tests/fixtures/real/.snapshots/) into benign vs
// breaking. Box-gated like the realsite runner: NOT CI — it needs a real
// browser against real YouTube from an IP the POT gate serves.
//
// Run: bun run scripts/drift-triage.ts [--headed] [--limit=N] [--video=ID]
//      [--out-dir=DIR]
// Results: scratch JSON per video under <out-dir> (default .slim/drift-triage/,
// gitignored); exit 0 only when every reachable fixture is identical or
// benign, exit 1 with the per-fixture diff summary when anything breaks.
//
// Classification (registry README: pins.tolerance):
//   identical    — parse output byte-identical to the row
//   benign       — same layout fingerprint and tier, counts within
//                  countsRel, every non-null rate within ratesRel
//                  (retiming / whitespace / comment edits)
//   breaking     — any of:
//                  * parse shape change: word timing or the cue layer
//                    appears/disappears
//                  * per-seg tOffsetMs gone (segOffsets 0 where pinned > 0)
//                  * the top-level windows layout appears/disappears
//                  * word/cue counts shift beyond countsRel
//                  * the tier regresses
//                  * a non-null rate drifts beyond ratesRel
//   unreachable  — no signed timedtext landed (bot-wall/geo/POT on this
//                  IP): reported, does not fail the run (box infra, like
//                  the realsite runner's infra class)

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parseYouTubeJson3 } from '../lib/captions';
import { truncateForFixture } from './sample-analysis';
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
import {
  computeLayout,
  computePins,
  loadRegistry,
  type RegistryLayout,
  type RegistryPins,
  type RegistryRow,
} from '../tests/fixtures/registry';
import { countInTolerance, rateInTolerance, type DriftVerdict } from './drift-classify';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_OUT_DIR = join(ROOT, '..', '.slim', 'drift-triage');

export interface FixtureDiff {
  fixture: string;
  videoId: string | null;
  verdict: DriftVerdict;
  reasons: string[];
  /** Re-captured pins, for the printed summary. */
  pins: RegistryPins | null;
  /** Re-captured layout fingerprint. */
  layout: RegistryLayout | null;
}

export function classifyFixture(row: RegistryRow, truncated: unknown, kind: string | null): FixtureDiff {
  const parsed = parseYouTubeJson3(truncated);
  const pins = computePins(parsed, kind);
  const layout = computeLayout(truncated);
  const { tolerance } = row.pins;
  const reasons: string[] = [];

  if (
    JSON.stringify(parsed) === JSON.stringify(row.parse) &&
    pins.tier === row.pins.tier &&
    layout.events === row.layout.events &&
    layout.windows === row.layout.windows &&
    layout.segOffsets === row.layout.segOffsets &&
    layout.windowTexts === row.layout.windowTexts
  ) {
    return { fixture: row.fixture, videoId: row.provenance.videoId, verdict: 'identical', reasons: [], pins, layout };
  }

  const wordTiming = pins.wordCount > 0;
  const pinnedWordTiming = row.pins.wordCount > 0;
  const cueLayer = pins.cueCount > 0;
  const pinnedCueLayer = row.pins.cueCount > 0;
  if (wordTiming !== pinnedWordTiming) {
    reasons.push(`word timing ${pinnedWordTiming ? 'lost' : 'appeared'} (${row.pins.wordCount} -> ${pins.wordCount} words)`);
  }
  if (cueLayer !== pinnedCueLayer) {
    reasons.push(`cue layer ${pinnedCueLayer ? 'lost' : 'appeared'} (${row.pins.cueCount} -> ${pins.cueCount} cues)`);
  }
  if (row.layout.segOffsets > 0 && layout.segOffsets === 0 && layout.windows === 0 && layout.windowTexts === 0) {
    reasons.push('per-seg tOffsetMs gone (word timing no longer in the payload)');
  }
  if ((row.layout.windows > 0) !== (layout.windows > 0)) {
    reasons.push(`windows layout ${row.layout.windows > 0 ? 'disappeared' : 'appeared'} (${row.layout.windows} -> ${layout.windows} windows)`);
  }
  if (!countInTolerance(row.pins.wordCount, pins.wordCount, tolerance.countsRel)) {
    reasons.push(`word count shift beyond tolerance (${row.pins.wordCount} -> ${pins.wordCount})`);
  }
  if (!countInTolerance(row.pins.cueCount, pins.cueCount, tolerance.countsRel)) {
    reasons.push(`cue count shift beyond tolerance (${row.pins.cueCount} -> ${pins.cueCount})`);
  }
  if (pins.tier !== row.pins.tier) {
    reasons.push(`tier regressed (${row.pins.tier} -> ${pins.tier})`);
  }
  const rateReasons: string[] = [];
  for (const key of Object.keys(row.pins.rates) as (keyof typeof row.pins.rates)[]) {
    const pinned = row.pins.rates[key];
    const current = pins.rates[key];
    if (!rateInTolerance(pinned, current, tolerance.ratesRel)) {
      rateReasons.push(`${key} ${fmt(pinned)} -> ${fmt(current)}`);
    }
  }
  if (rateReasons.length > 0) {
    reasons.push(`rate drift beyond band (${rateReasons.join(', ')})`);
  }

  if (reasons.length === 0) {
    return { fixture: row.fixture, videoId: row.provenance.videoId, verdict: 'benign', reasons: [], pins, layout };
  }
  return { fixture: row.fixture, videoId: row.provenance.videoId, verdict: 'breaking', reasons, pins, layout };
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(1);
}

/** The POT-aware WEB capture for one video: captions on, wait for the
 * player's signed timedtext, re-pick the ASR-preferred track and take the
 * fresh payload. Mirrors sample-captions.ts's captureWebPayload. */
async function capturePayload(page: Page, captures: TimedtextCapture[]): Promise<unknown | null> {
  await enableCaptions(page);
  let timedtext = await waitForTimedtext(captures, 5000);
  if (timedtext === null) {
    await page.keyboard.press('k').catch(() => undefined);
    timedtext = await waitForTimedtext(captures, 3000);
  }
  const baseline = captures.length;
  if (await pickAsrTrackFromMenu(page)) {
    const fresh = await waitForFreshTimedtext(captures, baseline, 4000);
    if (fresh !== null) timedtext = fresh;
  }
  if (timedtext === null || timedtext.body.length === 0 || timedtext.format !== 'json3') {
    return null;
  }
  try {
    return JSON.parse(timedtext.body) as unknown;
  } catch {
    return null;
  }
}

async function setupBrowser(headed: boolean): Promise<{ browser: Browser; context: BrowserContext }> {
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
    { name: 'CONSENT', value: 'YES+cb.20220301-01-p0.en+FX+000', domain: '.youtube.com', path: '/' },
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

async function captureVideo(
  context: BrowserContext,
  videoId: string,
): Promise<{ payload: unknown | null; reason: string | null; kind: string | null }> {
  const page = await context.newPage();
  const captures: TimedtextCapture[] = [];
  hookTimedtext(page, captures);
  try {
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await dismissConsentIfPresent(page);
    await page.waitForFunction(
      () => window.ytInitialPlayerResponse !== undefined,
      undefined,
      { timeout: 25_000 },
    );
    const web = await readPlayerInfo(page);
    if (web.trackCount === 0) return { payload: null, reason: 'no caption tracks', kind: null };
    const payload = await capturePayload(page, captures);
    if (payload === null) {
      return { payload: null, reason: 'no signed timedtext landed (bot-wall/geo/POT on this IP)', kind: null };
    }
    return { payload, reason: null, kind: web.asrCount > 0 ? 'asr' : null };
  } catch (err) {
    const hint = await pageErrorHint(page);
    const message = err instanceof Error ? err.message : String(err);
    return { payload: null, reason: `${message}${hint ? ` (${hint})` : ''}`, kind: null };
  } finally {
    await page.close();
  }
}

function printReport(diffs: FixtureDiff[]): void {
  const counts: Record<DriftVerdict, number> = { identical: 0, benign: 0, breaking: 0, unreachable: 0 };
  for (const diff of diffs) counts[diff.verdict] += 1;
  console.log(`\n=== DRIFT-TRIAGE SUMMARY (n=${diffs.length}) ===`);
  console.log(
    `identical=${counts.identical} benign=${counts.benign} breaking=${counts.breaking} unreachable=${counts.unreachable}`,
  );
  for (const diff of diffs) {
    const state =
      diff.verdict === 'identical'
        ? 'identical'
        : diff.verdict === 'benign'
          ? 'benign'
          : diff.verdict === 'unreachable'
            ? 'unreachable'
            : 'BREAKING';
    const detail =
      diff.verdict === 'breaking' && diff.reasons.length > 0
        ? ` (${diff.reasons.join('; ')})`
        : diff.verdict === 'benign'
          ? ' (retiming/whitespace/comment edits, rates within band)'
          : '';
    console.log(`  ${(diff.videoId ?? '?').padEnd(14)} ${state.padEnd(12)} ${diff.fixture}${detail}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : Number.POSITIVE_INFINITY;
  const videoArg = args.find((a) => a.startsWith('--video='));
  const outDirArg = args.find((a) => a.startsWith('--out-dir='));
  const outDir = outDirArg
    ? isAbsolute(outDirArg.slice(10))
      ? outDirArg.slice(10)
      : join(ROOT, outDirArg.slice(10))
    : DEFAULT_OUT_DIR;

  const rows = loadRegistry().filter((row) => row.provenance.source === 'real' && row.provenance.videoId !== null);
  const targets = videoArg
    ? rows.filter((row) => row.provenance.videoId === videoArg.slice(8))
    : rows.slice(0, limit);
  if (targets.length === 0) {
    console.error(`drift-triage: no registry rows for ${videoArg ?? 'the default set'}`);
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });
  const { browser, context } = await setupBrowser(headed);
  const diffs: FixtureDiff[] = [];
  for (const row of targets) {
    const videoId = row.provenance.videoId!;
    process.stdout.write(`recapturing ${videoId} ... `);
    const { payload, reason, kind } = await captureVideo(context, videoId);
    if (payload === null) {
      console.log(`unreachable (${reason})`);
      diffs.push({
        fixture: row.fixture,
        videoId,
        verdict: 'unreachable',
        reasons: reason === null ? [] : [reason],
        pins: null,
        layout: null,
      });
      continue;
    }
    const truncated = truncateForFixture(payload);
    writeFileSync(join(outDir, `${videoId}.json3-trunc.json`), `${JSON.stringify(truncated, null, 1)}\n`, 'utf8');
    const diff = classifyFixture(row, truncated, kind);
    console.log(diff.verdict);
    diffs.push(diff);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await browser.close();
  printReport(diffs);
  const breaking = diffs.filter((diff) => diff.verdict === 'breaking');
  console.log(`\nscratch payloads -> ${outDir}`);
  if (breaking.length > 0) {
    console.error(`drift-triage: ${breaking.length} breaking fixture(s) — inspect the diff summary above`);
    process.exit(1);
  }
  console.log('drift-triage: all reachable fixtures identical or benign');
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
