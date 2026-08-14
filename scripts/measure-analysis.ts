// Per-video analysis and per-language gate reporting for the caption-rate
// corpus measurement (scripts/measure-corpus.ts). Kept separate so the
// capture runner stays under the reviewability size gate.

import { parseYouTubeJson3, type ParsedCaptions } from '../lib/captions';
import { cueSignal, detectContentType } from '../lib/heuristics';
import {
  LANGUAGES,
  type LanguageModel,
} from '../lib/languages';
import { detectMusic, type ContentType } from '../lib/music';
import {
  countWordTokens,
  hasDevanagari,
  isBracketMarker,
} from '../lib/tokenizer';
import { cueSpanSec } from '../lib/wpm';
import {
  countingInputs,
  g3Gate,
  G3_MODE_LABELS,
  medianOf,
  spokenText,
} from './measure-count-gate';
import {
  cuesParity,
  ratesFor,
  wordsParity,
  type SampleStatus,
} from './sample-analysis';

export type CorpusClassification =
  | 'web-ok'
  | 'pot-fail'
  | 'parse-fail'
  | 'no-track'
  | 'manual-only'
  | 'wrong-lang'
  | 'geo-block';

export interface CorpusRecord {
  videoId: string;
  url: string;
  language: string;
  register: string;
  title: string | null;
  classification: CorpusClassification;
  error: string | null;
  asrLang: string | null;
  trackCount: number;
  asrCount: number;
  // harness-internal mirrors (androidControl contract)
  status: SampleStatus;
  webAsrCount: number | null;
  androidKind: string | null;
  androidLang: string | null;
  androidTrackCount: number | null;
  webBytes: number | null;
  windowsWords: number | null;
  windowsCues: number | null;
  segsWords: number | null;
  segsCues: number | null;
  wordsParity: boolean | null;
  cuesParity: boolean | null;
  unifiedRate: number | null;
  wordAccurateRate: number | null;
  pauseBiasPct: number | null;
  rateSource: 'web' | 'android' | null;
  coveragePct: number | null;
  regexCount: number | null;
  icuCount: number | null;
  countDeltaPct: number | null;
  /** ko hangulBlocks determinism smoke (countHangulSyllables twice). */
  hangulDeltaPct: number | null;
  bandMin: number | null;
  bandMax: number | null;
  bandMid: number | null;
  inBand: boolean | null;
  withinBandPct: number | null;
  detectExpected: string;
  detectActual: string;
  durationSec: number | null;
  /** es-419-style provenance (ar dialect, hi script). */
  provenance: string | null;
  captureDate: string;
  /** Sidecar with the full parsed timeline (scripts/data/gap-full/), written
   * only under measure-corpus.ts --gap-full; null on plain corpus runs. */
  fullTimeline: string | null;
}

export interface CorpusVideo {
  videoId: string;
  register: string;
  title: string;
  language: string;
  provenance?: string;
}

export interface RegisterGate {
  n: number;
  median: number | null;
  bandMin: number | null;
  bandMax: number | null;
  bandMid: number | null;
  inBandFraction: number | null;
  status: 'pass' | 'fail' | 'priors-conservative' | 'underpowered' | 'no-band';
}

export interface GateSummary {
  language: string;
  records: number;
  classification: Record<string, number>;
  asrBearing: number;
  g1: { webOk: number; anyPath: number; pass: boolean };
  g2: { registers: Record<string, RegisterGate>; pass: boolean };
  g3: {
    /** G3 variant: 'regex-icu' (words-mode), 'vowels-sample' (hi),
     * 'mora-sample' (ja), 'chars-sanity' (th), or 'regex-icu+hangul' (ko). */
    mode: 'regex-icu' | 'vowels-sample' | 'mora-sample' | 'chars-sanity' | 'regex-icu+hangul';
    n: number;
    median: number | null;
    maxDeltaPct: number | null;
    violations: string[];
    pass: boolean;
  };
  g4: { rows: number; falseRows: string[]; pass: boolean };
  g5: { n: number; median: number | null };
  confusion: Record<string, Record<string, number>>;
  verdict: 'corpus-validated' | 'stays-derived' | 'underpowered' | 'addendum-measured';
  note: string | null;
}

/** Midpoint ± 20% window over the language's register band (music: none). */
export function registerBand(
  lang: string,
  register: string,
): { min: number; max: number; mid: number } | null {
  const model = LANGUAGES[lang];
  if (model === undefined || register === 'music') return null;
  const band = model.registerPriors?.[register as ContentType] ?? model.priors;
  const mid = (band.min + band.max) / 2;
  return { min: mid * 0.8, max: mid * 1.2, mid };
}

function tokenCoverage(parsed: ParsedCaptions): number | null {
  const cueTokens = parsed.cues.reduce(
    (sum, cue) => (isBracketMarker(cue.text) ? sum : sum + countWordTokens(cue.text)),
    0,
  );
  if (cueTokens === 0) return null;
  const wordTokens = parsed.words.reduce((sum, w) => sum + countWordTokens(w.text), 0);
  return (wordTokens / cueTokens) * 100;
}

/** Music has precedence, then the register bands over the cue signal. */
function detectActualFor(parsed: ParsedCaptions, rate: number, model: LanguageModel): string {
  if (detectMusic(parsed.cues, rate, model.unit)) return 'music';
  const signal = cueSignal(parsed.cues, rate, model);
  return signal === null ? 'unknown' : detectContentType(signal);
}

/** Fill the rate/parity/stats fields from the best available payload (WEB
 * preferred, ANDROID control fallback). No-op when neither carries word
 * timing. */
export function applyStats(
  record: CorpusRecord,
  webJson: unknown | null,
  androidJson: unknown | null,
  video: CorpusVideo,
): void {
  const model = LANGUAGES[video.language];
  const webParsed = webJson === null ? null : parseYouTubeJson3(webJson);
  const androidParsed = androidJson === null ? null : parseYouTubeJson3(androidJson);
  if (webParsed !== null && androidParsed !== null && record.classification === 'web-ok') {
    record.wordsParity = wordsParity(webParsed, androidParsed);
    record.cuesParity = cuesParity(webParsed, androidParsed);
  }
  const source = webParsed ?? androidParsed;
  if (source === null || model === undefined) return;
  const stats = ratesFor(source, model);
  if (stats === null) return;
  record.rateSource = webParsed !== null ? 'web' : 'android';
  record.unifiedRate = stats.unifiedRate;
  record.wordAccurateRate = stats.wordAccurateRate;
  record.pauseBiasPct = stats.pauseBiasPct;
  record.durationSec = cueSpanSec(source.cues);
  record.coveragePct = tokenCoverage(source);
  const text = spokenText(source);
    // Full-payload gate: re-picks can serve a ~22 s preview (often the
    // English opening) — a hinglish verdict needs the full text.
    if (
    video.language === 'hi' &&
    record.classification === 'web-ok' &&
    (record.webBytes ?? 0) > 50_000 &&
    !hasDevanagari(text)
  ) {
    // hi:asr tracks can serve Latin-script (hi-Latn/hinglish) text, which
    // the vowels-mode counter measures nothing on — wrong-lang (spec).
    record.classification = 'wrong-lang';
    record.status = 'manual-only';
    record.error = 'latin-script hi track (hi-Latn text); excluded from the hi denominator';
  }
  const inputs = countingInputs(source, video.language);
  record.regexCount = inputs.regexCount;
  record.icuCount = inputs.icuCount;
  record.countDeltaPct = inputs.countDeltaPct;
  record.hangulDeltaPct = inputs.hangulDeltaPct;
  const band = registerBand(video.language, video.register);
  record.bandMin = band?.min ?? null;
  record.bandMax = band?.max ?? null;
  record.bandMid = band?.mid ?? null;
  record.inBand = band !== null ? stats.unifiedRate >= band.min && stats.unifiedRate <= band.max : null;
  record.detectExpected = video.register;
  record.detectActual = detectActualFor(source, stats.unifiedRate, model);
}

function registerStatus(input: {
  n: number;
  median: number | null;
  band: { min: number; max: number };
  inBandFraction: number | null;
}): RegisterGate['status'] {
  if (input.n < 2 || input.median === null) return 'underpowered';
  if (input.median >= input.band.min && input.median <= input.band.max) return 'pass';
  const frac = input.inBandFraction ?? 0;
  if (input.median < input.band.min && input.median >= input.band.min * 0.9 && frac >= 0.6) {
    return 'priors-conservative';
  }
  return 'fail';
}

/** Per-register within-band fraction (record shape's withinBandPct). */
export function fillWithinBand(records: CorpusRecord[]): void {
  const byRegister = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    if (record.inBand === null) continue;
    const key = `${record.language}:${record.register}`;
    byRegister.set(key, [...(byRegister.get(key) ?? []), record]);
  }
  for (const rows of byRegister.values()) {
    const fraction = rows.filter((r) => r.inBand).length / rows.length;
    for (const record of rows) record.withinBandPct = fraction * 100;
  }
}

function availabilityGate(own: CorpusRecord[]): {
  asrBearing: number;
  g1: { webOk: number; anyPath: number; pass: boolean };
} {
  const structural = ['no-track', 'manual-only', 'wrong-lang', 'geo-block'];
  const asrBearing = own.filter((r) => !structural.includes(r.classification));
  const webOk = own.filter((r) => r.classification === 'web-ok');
  // any-path: WEB word timing, or the ANDROID control's when the WEB path
  // failed. Non-web-ok classes never count — no target-lang ASR track.
  const anyPath = own.filter(
    (r) =>
      r.classification === 'web-ok' ||
      ((r.classification === 'pot-fail' || r.classification === 'parse-fail') &&
        (r.segsWords ?? 0) > 0),
  );
  return {
    asrBearing: asrBearing.length,
    g1: {
      webOk: webOk.length,
      anyPath: anyPath.length,
      pass: asrBearing.length > 0 && anyPath.length / asrBearing.length >= 0.9,
    },
  };
}

function registerGates(own: CorpusRecord[], lang: string): {
  registers: Record<string, RegisterGate>;
  pass: boolean;
} {
  const registers: Record<string, RegisterGate> = {};
  for (const register of new Set(own.map((r) => r.register))) {
    const measured = own.filter(
      (r) => r.classification === 'web-ok' && r.register === register && r.unifiedRate !== null,
    );
    const band = registerBand(lang, register);
    const rates = measured.map((r) => r.unifiedRate as number).sort((a, b) => a - b);
    const median = medianOf(rates);
    const inBandFraction =
      measured.length > 0
        ? measured.filter((r) => r.inBand === true).length / measured.length
        : null;
    registers[register] = {
      n: measured.length,
      median,
      bandMin: band?.min ?? null,
      bandMax: band?.max ?? null,
      bandMid: band?.mid ?? null,
      inBandFraction,
      status:
        band === null
          ? 'no-band'
          : registerStatus({ n: measured.length, median, band, inBandFraction }),
    };
  }
  return {
    registers,
    pass: Object.values(registers).every(
      (g) => g.status === 'pass' || g.status === 'no-band',
    ),
  };
}

function parityGate(own: CorpusRecord[]): GateSummary['g4'] {
  const parityRows = own.filter(
    (r) => r.classification === 'web-ok' && (r.wordsParity !== null || r.cuesParity !== null),
  );
  const falseRows = parityRows
    .filter((r) => r.wordsParity === false || r.cuesParity === false)
    .map((r) => r.videoId);
  return { rows: parityRows.length, falseRows, pass: falseRows.length === 0 };
}

function pauseGate(own: CorpusRecord[]): GateSummary['g5'] {
  const pauseRows = own.filter(
    (r) => r.classification === 'web-ok' && r.register !== 'music' && r.pauseBiasPct !== null,
  );
  return {
    n: pauseRows.length,
    median: medianOf(pauseRows.map((r) => r.pauseBiasPct as number).sort((a, b) => a - b)),
  };
}

function confusionMatrix(own: CorpusRecord[]): Record<string, Record<string, number>> {
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of own) {
    if (r.classification !== 'web-ok' || r.detectActual === 'unknown') continue;
    (confusion[r.detectExpected] ??= {})[r.detectActual] =
      (confusion[r.detectExpected]?.[r.detectActual] ?? 0) + 1;
  }
  return confusion;
}

function verdictFor(
  lang: string,
  g1: GateSummary['g1'],
  g2: GateSummary['g2'],
  g3: GateSummary['g3'],
  registers: Record<string, RegisterGate>,
  asrBearing: number,
): { verdict: GateSummary['verdict']; note: string | null } {
  const underpowered = Object.values(registers).some((g) => g.status === 'underpowered');
  if (lang === 'sr') {
    // sr is not on YouTube's ASR language list; the probe runs anyway and
    // records the structural fail (no-track/manual-only) as evidence.
    const srNote =
      asrBearing === 0
        ? 'sr availability probe: no sr ASR tracks (not on YouTube\'s ASR language list); structural fail recorded'
        : 'sr availability probe: sr ASR tracks present; measured';
    return { verdict: 'stays-derived', note: srNote };
  }
  if (['ru', 'uk', 'pl', 'cs', 'hi', 'ar', 'id', 'vi', 'ja', 'th', 'ko'].includes(lang)) {
    if (g1.pass && g2.pass && g3.pass) return { verdict: 'corpus-validated', note: null };
    if (underpowered) return { verdict: 'underpowered', note: 'a register has <2 measured videos; no verdict' };
    return {
      verdict: 'stays-derived',
      note: lang === 'uk' ? 'uk ASR only; ru-broadcasting uk-topic channels classify wrong-lang' : null,
    };
  }
  return { verdict: underpowered ? 'underpowered' : 'addendum-measured', note: null };
}

export function summarizeLang(records: CorpusRecord[], lang: string): GateSummary {
  const own = records.filter((r) => r.language === lang);
  const classification: Record<string, number> = {};
  for (const r of own) {
    classification[r.classification] = (classification[r.classification] ?? 0) + 1;
  }
  const { asrBearing, g1 } = availabilityGate(own);
  const { registers, pass: g2Pass } = registerGates(own, lang);
  const g2 = { registers, pass: g2Pass };
  const g3 = g3Gate(own, lang);
  const g4 = parityGate(own);
  const g5 = pauseGate(own);
  const { verdict, note } = verdictFor(lang, g1, g2, g3, registers, asrBearing);
  return {
    language: lang,
    records: own.length,
    classification,
    asrBearing,
    g1,
    g2,
    g3,
    g4,
    g5,
    confusion: confusionMatrix(own),
    verdict,
    note,
  };
}

export function printLangSummary(summary: GateSummary): void {
  console.log(`\n=== LANGUAGE ${summary.language} (n=${summary.records}) ===`);
  console.log(
    `classification: ${Object.entries(summary.classification)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  console.log(
    `G1 availability: web-ok ${summary.g1.webOk}/${summary.asrBearing}, any-path ${summary.g1.anyPath}/${summary.asrBearing} = ` +
      `${summary.asrBearing > 0 ? ((summary.g1.anyPath / summary.asrBearing) * 100).toFixed(1) : 'n/a'}% ` +
      `${summary.g1.pass ? 'PASS' : 'FAIL'}`,
  );
  for (const [register, gate] of Object.entries(summary.g2.registers)) {
    console.log(
      `G2 ${register}: n=${gate.n} median=${gate.median === null ? 'n/a' : gate.median.toFixed(1)} ` +
        `band=[${gate.bandMin === null ? '-' : gate.bandMin.toFixed(0)},${gate.bandMax === null ? '-' : gate.bandMax.toFixed(0)}] ` +
        `within=${gate.inBandFraction === null ? 'n/a' : `${(gate.inBandFraction * 100).toFixed(0)}%`} ` +
        `${gate.status}`,
    );
  }
  console.log(`G2 verdict: ${summary.g2.pass ? 'PASS' : 'FAIL'}`);
  const g3Label = G3_MODE_LABELS[summary.g3.mode];
  console.log(
    `${g3Label}: n=${summary.g3.n} median=${summary.g3.median === null ? 'n/a' : `${summary.g3.median.toFixed(1)}%`} ` +
      `max=${summary.g3.maxDeltaPct === null ? 'n/a' : `${summary.g3.maxDeltaPct.toFixed(1)}%`} ` +
      `${summary.g3.pass ? 'PASS' : `FAIL (${summary.g3.violations.join(', ')})`}`,
  );
  console.log(
    `G4 parity: rows=${summary.g4.rows} false=${summary.g4.falseRows.length} ` +
      `${summary.g4.falseRows.length === 0 ? 'PASS' : `INSPECT (${summary.g4.falseRows.join(', ')})`}`,
  );
  console.log(
    `G5 pause-bias (informational): n=${summary.g5.n} median=${summary.g5.median === null ? 'n/a' : `${summary.g5.median.toFixed(1)}%`}`,
  );
  console.log(`VERDICT ${summary.language}: ${summary.verdict}${summary.note ? ` (${summary.note})` : ''}`);
}

export function printVerdict(summaries: GateSummary[]): void {
  const ru = summaries.find((s) => s.language === 'ru');
  if (ru !== undefined) {
    console.log(`\nVERDICT ru: ${ru.verdict}`);
  }
}
