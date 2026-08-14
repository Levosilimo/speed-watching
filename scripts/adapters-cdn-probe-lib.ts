// Measurement core for the CDN fetch probe (scripts/adapters-cdn-probe.ts):
// reads video > track[src] exactly as production, issues the explicit
// cors-mode page-context fetch per carrier, classifies the outcome
// (cors-blocked / signed-expiry / http-error / parse-fail / fetch-ok), and
// parses fetch-ok bytes in Node with the production parsers. CORS is a
// fetch-time property — an opaque <video> element load proves nothing — so
// only the explicit fetch counts; parsing is deterministic given bytes and
// runs the tested parser code. Pure classifier/verdict/serializer functions
// are exported for unit tests.

import vttjs from 'vtt.js';
import type { Page } from 'playwright';
import { parseSrt, parseVtt, parseVttWords, type VttHost } from '../lib/captions-harvest';
import { withTimeout } from './vk-probe-network';

// Node-side parser host, same shim the adapters test uses: vtt.js in Node
// has no DOM, so VTTCue comes from the module and createElement is stubbed.
const VTT_HOST: VttHost = {
  VTTCue: vttjs.VTTCue,
  document: {
    createElement: (tagName: string) => ({ tagName, style: {}, children: [], appendChild() {}, setAttribute() {} }),
  },
};

export type PlatformName = 'dzen' | 'rutube';
export type FetchClass = 'fetch-ok' | 'cors-blocked' | 'signed-expiry' | 'http-error' | 'parse-fail';
export type VideoStatus =
  | 'word-ok'
  | 'cue-ok'
  | 'fetch-fail'
  | 'no-track'
  | 'no-video'
  | 'login-wall'
  | 'geo-block'
  | 'error';

export interface FetchOk {
  kind: 'ok';
  status: number;
  acao: string | null;
  bytes: number;
  text: string;
}

export interface FetchRejected {
  kind: 'cors-or-network';
  error: string;
}

export type CarrierOutcome = FetchOk | FetchRejected;

/** The fetch half of a JSONL carrier record: the outcome minus its body. */
export type CarrierFetch = Omit<FetchOk, 'text'> | FetchRejected;

export interface CarrierParse {
  words: number;
  cues: number;
}

/** One carrier attempt. `parse` is null when the fetch never resolved ok;
 *  counts (not segments) are what the JSONL record needs. */
export interface CarrierRecord {
  url: string;
  fetch: CarrierFetch;
  parse: CarrierParse | null;
}

export interface ProbeRecord {
  platform: PlatformName;
  url: string;
  title: string | null;
  status: VideoStatus;
  reason: string | null;
  carriers: CarrierRecord[];
  probeMs: number;
}

export const GOTO_TIMEOUT_MS = 45_000;
const CARRIER_FETCH_TIMEOUT_MS = 15_000;

// ── Page probe ────────────────────────────────────────────────────────────

/** The EXACT production read (entrypoints/generic.content.ts): every
 *  video > track[src] attribute across the page's frames, DOM order. */
export async function readTrackSrcs(page: Page): Promise<string[]> {
  for (const frame of page.frames()) {
    try {
      const srcs = await withTimeout(
        frame.evaluate(() =>
          [...document.querySelectorAll('video')]
            .flatMap((el) => [...el.querySelectorAll<HTMLTrackElement>(':scope > track[src]')])
            .map((track) => track.getAttribute('src'))
            .filter((src): src is string => src !== null && src !== ''),
        ),
        5000,
        null,
      );
      if (srcs !== null && srcs.length > 0) return srcs;
    } catch {
      // frame navigated away or evaluate timed out
    }
  }
  return [];
}

/** The EXACT production fetch: cors-mode page-context fetch of the carrier
 *  URL, ACAO header read (a CORS-withholding CDN rejects the fetch), body
 *  text. A rejected promise is classified cors-blocked — opaque element
 *  loads never reach this code path. */
export async function fetchCarrier(page: Page, src: string): Promise<CarrierOutcome> {
  for (const frame of page.frames()) {
    try {
      const outcome = await withTimeout(
        frame.evaluate(
          async (url: string): Promise<CarrierOutcome> => {
            try {
              const res = await fetch(url);
              const acao = res.headers.get('access-control-allow-origin');
              const text = await res.text();
              return { kind: 'ok', status: res.status, acao, bytes: text.length, text };
            } catch (e) {
              return { kind: 'cors-or-network', error: String(e) };
            }
          },
          src,
        ),
        CARRIER_FETCH_TIMEOUT_MS,
        null,
      );
      if (outcome !== null) return outcome;
    } catch {
      // frame navigated away or evaluate timed out
    }
  }
  return { kind: 'cors-or-network', error: 'page-unresponsive' };
}

/** Parses fetch-ok bytes with the production parsers, mirroring
 *  probeTrackSrcs' order: word runs first (Dzen), then cue-level VTT with
 *  the SRT fallback (Rutube). Returns counts. */
export function parseCarrierBody(text: string): CarrierParse {
  const words = parseVttWords(text, VTT_HOST);
  let cues = parseVtt(text, VTT_HOST);
  if (cues.length === 0) cues = parseSrt(text, VTT_HOST);
  return { words: words.length, cues: cues.length };
}

export async function probeCarrier(page: Page, src: string): Promise<CarrierRecord> {
  const outcome = await fetchCarrier(page, src);
  const parse = outcome.kind === 'ok' ? parseCarrierBody(outcome.text) : null;
  const fetch =
    outcome.kind === 'ok'
      ? { kind: 'ok' as const, status: outcome.status, acao: outcome.acao, bytes: outcome.bytes }
      : { kind: 'cors-or-network' as const, error: outcome.error };
  return { url: src, fetch, parse };
}

// ── Pure classification ───────────────────────────────────────────────────

export function classifyCarrier(outcome: CarrierOutcome | CarrierFetch, parse: CarrierParse | null): FetchClass {
  if (outcome.kind === 'cors-or-network') return 'cors-blocked';
  if (outcome.status === 403) return 'signed-expiry';
  if (outcome.status >= 400) return 'http-error';
  if (parse === null || (parse.words === 0 && parse.cues === 0)) return 'parse-fail';
  return 'fetch-ok';
}

/** Video-level verdict from the carrier attempts. Any fetch-ok carrier
 *  wins (word-ok at the ≥2-word gate, cue-ok below); fetch-fail reasons
 *  resolve cors-blocked > signed-expiry > http-<status> > parse-fail. */
export function videoVerdict(carriers: CarrierRecord[], trackCount: number): { status: VideoStatus; reason: string | null } {
  if (trackCount === 0) return { status: 'no-track', reason: null };
  const fetchOk = carriers.filter((c) => classifyCarrier(c.fetch, c.parse) === 'fetch-ok');
  if (fetchOk.length > 0) {
    const words = fetchOk.reduce((n, c) => n + (c.parse?.words ?? 0), 0);
    return { status: words >= 2 ? 'word-ok' : 'cue-ok', reason: null };
  }
  for (const c of carriers) {
    const cls = classifyCarrier(c.fetch, c.parse);
    if (cls === 'cors-blocked') return { status: 'fetch-fail', reason: 'cors-blocked' };
    if (cls === 'signed-expiry') return { status: 'fetch-fail', reason: 'signed-expiry' };
    if (cls === 'http-error' && c.fetch.kind === 'ok') {
      return { status: 'fetch-fail', reason: `http-${c.fetch.status}` };
    }
  }
  return { status: 'fetch-fail', reason: 'parse-fail' };
}

/** PASS = zero cors-blocked, zero parse-fail, and ≥80% of reachable
 *  carriers fetch-ok (denominator excludes no-track/no-video/wall videos
 *  structurally — those never produce a carrier outcome). */
export function passCriteria(corsBlocked: number, fetchOk: number, reachable: number, parseFail: number): boolean {
  return corsBlocked === 0 && parseFail === 0 && reachable > 0 && fetchOk / reachable >= 0.8;
}

export function recordLine(record: ProbeRecord): string {
  const ok = record.carriers.filter((c) => classifyCarrier(c.fetch, c.parse) === 'fetch-ok').length;
  const status = `${record.platform} ${record.status}${record.reason !== null ? ` (${record.reason})` : ''}`;
  return `${status} carriers=${ok}/${record.carriers.length} ${record.probeMs}ms`;
}

/** Per-platform table + the PASS criteria verdict over all carrier
 *  outcomes. Only carrier-bearing records contribute to the counts;
 *  no-track/no-video/wall records are structural and excluded. */
export function summarize(records: ProbeRecord[]): void {
  const byClass = new Map<string, number>();
  let reachable = 0;
  for (const record of records) {
    for (const carrier of record.carriers) {
      reachable += 1;
      const cls = classifyCarrier(carrier.fetch, carrier.parse);
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    }
  }
  const fetchOk = byClass.get('fetch-ok') ?? 0;
  const corsBlocked = byClass.get('cors-blocked') ?? 0;
  const parseFail = byClass.get('parse-fail') ?? 0;
  const signedExpiry = byClass.get('signed-expiry') ?? 0;
  const httpError = byClass.get('http-error') ?? 0;
  const header = ['platform', 'status', 'reason', 'carriers', 'ms'];
  const rows = records.map((r) => [
    r.platform,
    r.status,
    (r.reason ?? '').slice(0, 60),
    `${r.carriers.filter((c) => c.fetch.kind === 'ok').length}/${r.carriers.length}`,
    String(r.probeMs),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const printRow = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  console.log('\n' + printRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(printRow(row));
  const pct = reachable === 0 ? 0 : Math.round((fetchOk / reachable) * 1000) / 10;
  console.log(
    `\ncarrier outcomes: reachable=${reachable} fetch-ok=${fetchOk} (${pct}%) cors-blocked=${corsBlocked} signed-expiry=${signedExpiry} http-error=${httpError} parse-fail=${parseFail}`,
  );
  const pass = passCriteria(corsBlocked, fetchOk, reachable, parseFail);
  console.log(
    `PASS criteria: ${pass ? 'PASS' : 'FAIL'} (cors-blocked=0 ${corsBlocked === 0 ? '✓' : '✗'}, parse-fail=0 ${parseFail === 0 ? '✓' : '✗'}, fetch-ok>=80% ${pct >= 80 ? '✓' : '✗'})`,
  );
}
