// Analysis and reporting for the POT-aware caption re-run (gate 1 of
// docs/manual-gates-runbook.md). Shared by scripts/sample-captions.ts (live
// run) and the --analyze re-run mode.
//
// The re-run measures the WEB timedtext path the way the extension sees it:
// the player's own signed /api/timedtext response (POT + signature bound to
// the video), intercepted while captions are toggled on. The ANDROID
// innertube fetch stays as the fallback/control for the windows==segs parity
// assertion.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedCaptions, Segment } from '../lib/captions';
import { countWordTokens, isBracketMarker } from '../lib/tokenizer';
import { filteredTokensOverTrimmedSpan } from '../lib/wpm';

export type SampleStatus =
  | 'web-captured'
  | 'web-empty'
  | 'android-fallback'
  | 'no-track'
  | 'manual-only'
  | 'parse-failed'
  | 'error';

export interface RateStats {
  unifiedRate: number;
  wordAccurateRate: number;
  pauseBiasPct: number;
}

export interface SampleRecord {
  videoId: string;
  url: string;
  category: string;
  status: SampleStatus;
  error: string | null;
  landedUrl: string;
  title: string | null;
  // WEB player-response metadata
  webTrackCount: number | null;
  webAsrCount: number | null;
  webManualCount: number | null;
  // POT-aware WEB capture
  webPayloadSaved: boolean;
  webBytes: number | null;
  webFormat: 'json3' | 'vtt' | 'other' | null;
  windowsWords: number | null;
  windowsCues: number | null;
  // ANDROID innertube control
  androidKind: string | null;
  androidLang: string | null;
  androidTrackCount: number | null;
  segsCues: number | null;
  segsWords: number | null;
  // windows==segs parity; null when both payloads are not parseable
  wordsParity: boolean | null;
  cuesParity: boolean | null;
  // rates + pause bias; WEB payload preferred, ANDROID control fallback
  unifiedRate: number | null;
  wordAccurateRate: number | null;
  pauseBiasPct: number | null;
  pauseBiasSource: 'web' | 'android' | null;
}

export interface FixtureSlot {
  file: string;
  preferred?: string;
  needsWords?: boolean;
  needsMusic?: boolean;
}

// Legacy ANDROID-layout fixture slots (back tests/captions.test.ts).
export const FIXTURE_SLOTS: FixtureSlot[] = [
  { file: 'asr-word.json', needsWords: true, preferred: 'iG9CE55wbtY' },
  { file: 'manual-cue.json', needsWords: false, preferred: 'qp0HIF3SfI4' },
  { file: 'music.json', needsMusic: true, preferred: '60ItHLz5WEA' },
];

function normText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Speech duration from per-word inter-start spans: the sum of
 * (start[i+1] - start[i]) over consecutive timed words, excluding gaps
 * >= 1 s (cue-boundary pauses) and non-positive deltas (out-of-order).
 */
export function speechDurSec(words: readonly Segment[]): number | null {
  if (words.length < 2) return null;
  let dur = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const cur = words[i];
    const next = words[i + 1];
    if (!cur || !next) continue;
    const gap = next.startSec - cur.startSec;
    if (gap >= 1 || gap <= 0) continue;
    dur += gap;
  }
  return dur > 0 ? dur : null;
}

/**
 * Pause-bias inputs on one payload:
 * - unifiedRate: the extension's unified ASR rule
 *   (filteredTokensOverTrimmedSpan) applied to the captured cues.
 * - wordAccurateRate: the same filtered letter/digit tokens over the
 *   pause-excluded speech duration (per-word inter-start spans).
 * - pauseBiasPct: how much of the applied speed pauses eat:
 *   (unifiedRate - wordAccurateRate) / unifiedRate.
 */
export function ratesFor(parsed: ParsedCaptions): RateStats | null {
  const unifiedRate = filteredTokensOverTrimmedSpan(parsed.cues);
  const speechDur = speechDurSec(parsed.words);
  if (unifiedRate === null || speechDur === null) return null;
  const tokens = parsed.cues.reduce(
    (sum, cue) => (isBracketMarker(cue.text) ? sum : sum + countWordTokens(cue.text)),
    0,
  );
  const wordAccurateRate = (tokens / speechDur) * 60;
  return {
    unifiedRate,
    wordAccurateRate,
    pauseBiasPct: ((unifiedRate - wordAccurateRate) / unifiedRate) * 100,
  };
}

/**
 * windows==segs cue parity (runbook: first/last cue text and overlapping
 * coverage must agree between the WEB windows layout and the ANDROID segs
 * layout of the same video). Null when either side has no cues.
 */
export function cuesParity(web: ParsedCaptions, android: ParsedCaptions): boolean | null {
  const webFirst = web.cues[0];
  const webLast = web.cues[web.cues.length - 1];
  const andFirst = android.cues[0];
  const andLast = android.cues[android.cues.length - 1];
  if (!webFirst || !webLast || !andFirst || !andLast) return null;
  const firstAgree = normText(webFirst.text) === normText(andFirst.text);
  const lastAgree = normText(webLast.text) === normText(andLast.text);
  const webSpan = webLast.startSec - webFirst.startSec;
  const andSpan = andLast.startSec - andFirst.startSec;
  const overlap =
    Math.min(webLast.startSec, andLast.startSec) -
    Math.max(webFirst.startSec, andFirst.startSec);
  const minSpan = Math.min(webSpan, andSpan);
  const overlapRatio = minSpan > 0 ? overlap / minSpan : 0;
  return firstAgree && lastAgree && overlapRatio >= 0.5;
}

/** Both layouts yield word timing on the same video, and the first timed
 * word agrees. Null when either side has no timed words. */
export function wordsParity(web: ParsedCaptions, android: ParsedCaptions): boolean | null {
  const webFirst = web.words[0];
  const andFirst = android.words[0];
  if (!webFirst || !andFirst) return null;
  return normText(webFirst.text) === normText(andFirst.text);
}

export function parseFromJsonl(line: string): SampleRecord {
  return JSON.parse(line) as SampleRecord;
}

export function analyzeExisting(resultsFile: string): void {
  const lines = readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean);
  printReport(lines.map(parseFromJsonl));
}

export function truncateForFixture(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return json;
  const record = json as Record<string, unknown>;
  return {
    ...record,
    events: Array.isArray(record.events) ? record.events.slice(0, 20) : [],
    windows: Array.isArray(record.windows) ? record.windows.slice(0, 12) : [],
  };
}

/** Fill the legacy ANDROID-layout fixture slots from the control payloads. */
export function saveFixtures(
  results: SampleRecord[],
  payloads: Map<string, unknown>,
  fixturesDir: string,
): void {
  const slots = FIXTURE_SLOTS.map((slot) => ({ ...slot }));
  for (const video of results) {
    const raw = payloads.get(video.videoId);
    if (raw === undefined) continue;
    if (slots.length === 0) break;
    const fits = (s: FixtureSlot): boolean =>
      (s.needsWords === undefined || (s.needsWords === true) === ((video.segsWords ?? 0) > 0)) &&
      (s.needsMusic === undefined || s.needsMusic === (video.category === 'music'));
    const preferred = slots.find((s) => s.preferred === video.videoId && fits(s));
    const fallback = slots.find((s) => fits(s));
    const chosen = preferred ?? fallback;
    if (!chosen) continue;
    slots.splice(slots.indexOf(chosen), 1);
    writeFileSync(
      join(fixturesDir, chosen.file),
      JSON.stringify(truncateForFixture(raw), null, 1),
      'utf8',
    );
    console.log(`fixture ${chosen.file} <- ${video.videoId} (${video.androidKind})`);
  }
  if (slots.length > 0) {
    console.warn(`WARNING: ${slots.length} fixture slots unfilled`);
  }
}

/**
 * Fixture-commitment helper (runbook pass criterion 6): emits up to 3
 * truncated real WEB payloads (windows layout, ASR-preferred) to
 * tests/fixtures/real/ plus the provenance README. Runs only when real
 * web-captured payloads exist.
 */
export function emitWebFixtures(input: {
  records: SampleRecord[];
  webPayloads: Map<string, unknown>;
  originalBytes: Map<string, number>;
  fixturesDir: string;
  captureDate: string;
}): void {
  const { records, webPayloads, originalBytes, fixturesDir, captureDate } = input;
  const anchor = 'iG9CE55wbtY';
  const candidates = records
    .filter((r) => r.status === 'web-captured' && webPayloads.has(r.videoId))
    .sort((a, b) => (a.videoId === anchor ? -1 : b.videoId === anchor ? 1 : 0));
  const picked = candidates.slice(0, 3);
  if (picked.length === 0) {
    console.warn('no real WEB payloads to commit as fixtures (web-captured = 0)');
    return;
  }
  const rows: string[] = [];
  for (const record of picked) {
    const raw = webPayloads.get(record.videoId);
    if (raw === undefined) continue;
    const file = `windows-asr-${record.videoId}-trunc.json`;
    const truncated = truncateForFixture(raw);
    writeFileSync(join(fixturesDir, file), JSON.stringify(truncated, null, 1), 'utf8');
    const original = originalBytes.get(record.videoId) ?? 0;
    const size = JSON.stringify(truncated).length;
    console.log(
      `web fixture ${file} <- ${record.videoId} (${record.title ?? '?'}, ${original} -> ${size} bytes)`,
    );
    const title = (record.title ?? '?').replace(/\|/g, '/');
    rows.push(
      `| ${file} | ${record.videoId} | ${title} | ${captureDate} | player-signed intercept (page.on('response'), CC toggled on) | ${original} | ${size} | word timing parsing (words > 0 on a real WEB payload); windows==segs cue parity |`,
    );
  }
  const readmePath = join(fixturesDir, '..', 'README.md');
  writeFileSync(
    readmePath,
    [
      '# Real caption fixtures — provenance',
      '',
      `Captured ${captureDate} from a residential IP via the POT-aware harness ` +
        "(scripts/sample-captions.ts): the player's own signed /api/timedtext " +
        'response, intercepted while captions were toggled on — no fresh ' +
        'baseUrl fetches, so the POT token and signature are the ones the ' +
        'player used.',
      '',
      'Full transcripts are not committed: every fixture is truncated to the ' +
        'first 20 events (and first 12 top-level windows) of the payload. The ' +
        'captions are the work of their creators; copyright remains with them.',
      '',
      '| fixture | videoId | title | capture date | capture method | original bytes | truncated bytes | backs |',
      '|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n'),
    'utf8',
  );
  console.log(`provenance -> ${readmePath}`);
}

export function printReport(results: SampleRecord[]): void {
  printSummary(results);
  printGate(results);
  printStratification(results);
  printParity(results);
  printPauseBias(results);
  printErrors(results);
}

function printSummary(results: SampleRecord[]): void {
  console.log(`\n=== RE-RUN SUMMARY (n=${results.length}) ===`);
  const byStatus = new Map<string, number>();
  for (const r of results) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }
  console.log([...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join(' '));
}

function printGate(results: SampleRecord[]): void {
  const captionBearing = results.filter(
    (r) =>
      r.status !== 'no-track' &&
      r.status !== 'error' &&
      ((r.webTrackCount ?? 0) > 0 || (r.androidTrackCount ?? 0) > 0),
  );
  const asrBearing = results.filter(
    (r) => (r.webAsrCount ?? 0) > 0 || r.androidKind === 'asr',
  );
  const webYield = results.filter((r) => r.status === 'web-captured');
  const anyPath = results.filter(
    (r) => (r.windowsWords ?? 0) > 0 || (r.segsWords ?? 0) > 0,
  );

  console.log(`\n=== ASR GATE (>=90% of ASR-bearing videos yield word timing) ===`);
  console.log(`caption-bearing: ${captionBearing.length}`);
  console.log(`asr-bearing: ${asrBearing.length}`);
  const gate = asrBearing.length > 0 ? webYield.length / asrBearing.length : 0;
  console.log(
    `WEB yield (words>0 & cues>0 on the player's payload): ${webYield.length}/${asrBearing.length} = ` +
      `${(gate * 100).toFixed(1)}% ${gate >= 0.9 ? 'PASS' : 'FAIL'} ` +
      `(phase-0 ANDROID baseline: 17/17 = 100%)`,
  );
  const raw = captionBearing.length > 0 ? anyPath.length / captionBearing.length : 0;
  console.log(
    `any-path word timing (WEB or ANDROID control): ${anyPath.length}/${captionBearing.length} = ` +
      `${(raw * 100).toFixed(1)}% (phase-0 baseline parity: 17/22 = 77.3%)`,
  );
}

function printStratification(results: SampleRecord[]): void {
  const structural = results.filter(
    (r) => r.status === 'no-track' || r.status === 'manual-only',
  );
  const pot = results.filter(
    (r) => r.status === 'web-empty' || r.status === 'android-fallback',
  );
  const parserBug = results.filter((r) => r.status === 'parse-failed');
  const infra = results.filter((r) => r.status === 'error');
  console.log(`\n=== STRATIFICATION (runbook failure classes) ===`);
  console.log(
    `structural (no ASR, excluded from denominator): ` +
      `no-track=${structural.filter((r) => r.status === 'no-track').length} ` +
      `manual-only=${structural.filter((r) => r.status === 'manual-only').length}`,
  );
  console.log(
    `POT/IP access (WEB path blocked): ` +
      `web-empty=${pot.filter((r) => r.status === 'web-empty').length} ` +
      `android-fallback=${pot.filter((r) => r.status === 'android-fallback').length}`,
  );
  console.log(`PARSER BUG (hard fail): parse-failed=${parserBug.length}`);
  console.log(`infra: error=${infra.length}`);
  for (const r of [...pot, ...parserBug, ...infra]) {
    console.log(`  ${r.videoId.padEnd(14)} ${r.status.padEnd(16)} ${r.error ?? ''}`);
  }
  const walls = results.filter(
    (r) =>
      (r.error?.includes('bot-wall') ?? false) ||
      (r.error?.includes('consent') ?? false),
  );
  console.log(`bot-wall/consent-page: ${walls.length} (criteria 3: none expected)`);
}

function printParity(results: SampleRecord[]): void {
  const parityRows = results.filter(
    (r) => r.cuesParity !== null || r.wordsParity !== null,
  );
  console.log(`\n=== PARITY (windows==segs, ASR-bearing, n=${parityRows.length}) ===`);
  console.log('videoId       windowsWords windowsCues segsCues  segsWords  wordsParity cuesParity');
  let cuesOk = 0;
  let cuesN = 0;
  let wordsOk = 0;
  let wordsN = 0;
  for (const r of parityRows) {
    console.log(
      `${r.videoId.padEnd(14)} ${String(r.windowsWords).padStart(11)} ${String(r.windowsCues).padStart(11)} ` +
        `${String(r.segsCues).padStart(8)} ${String(r.segsWords).padStart(9)} ` +
        `${String(r.wordsParity).padStart(11)} ${String(r.cuesParity).padStart(10)}`,
    );
    if (r.cuesParity !== null) {
      cuesN += 1;
      if (r.cuesParity) cuesOk += 1;
    }
    if (r.wordsParity !== null) {
      wordsN += 1;
      if (r.wordsParity) wordsOk += 1;
    }
  }
  console.log(`cuesParity: ${cuesOk}/${cuesN}  wordsParity: ${wordsOk}/${wordsN}`);
}

function printPauseBias(results: SampleRecord[]): void {
  const biased = results.filter((r) => r.pauseBiasPct !== null);
  console.log(
    `\n=== PAUSE-BIAS (median; |bias| > 25% flags the unified-rate rule) ===`,
  );
  if (biased.length > 0) {
    const sorted = biased.map((r) => r.pauseBiasPct as number).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const a = sorted[mid];
    const median =
      a === undefined
        ? null
        : sorted.length % 2 === 1
          ? a
          : (() => {
              const b = sorted[mid - 1];
              return b === undefined ? null : (a + b) / 2;
            })();
    // Negative bias: word-accurate rate exceeds the unified estimate because
    // pauses inflate the cue-span denominator — the rule over-speeds by
    // |bias|. Runbook flags > 25% pause share.
    console.log(
      `median pauseBias=${median === null ? 'n/a' : `${median.toFixed(1)}%`} ` +
        `${median !== null && Math.abs(median) > 25 ? 'FLAG (|bias|>25%)' : ''}`,
    );
  }
  console.log('videoId       unifiedRate wordAccurateRate pauseBias% source');
  for (const r of biased) {
    console.log(
      `${r.videoId.padEnd(14)} ${(r.unifiedRate ?? 0).toFixed(1).padStart(10)} ` +
        `${(r.wordAccurateRate ?? 0).toFixed(1).padStart(15)} ` +
        `${(r.pauseBiasPct ?? 0).toFixed(1).padStart(10)} ${String(r.pauseBiasSource).padStart(6)}`,
    );
  }
}

function printErrors(results: SampleRecord[]): void {
  const errors = results.filter((r) => r.status === 'error');
  if (errors.length === 0) return;
  console.log(`\n=== ERRORS ===`);
  for (const r of errors) {
    console.log(`${r.videoId} [${r.category}] ${r.error}`);
  }
}
