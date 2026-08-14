import { describe, expect, it } from 'vitest';
import type { ParsedCaptions } from '../lib/captions';
import { LANGUAGES } from '../lib/languages';
import { DEVANAGARI_G3_SAMPLE } from '../scripts/measure-count-gate';
import {
  registerBand,
  summarizeLang,
  type CorpusRecord,
} from '../scripts/measure-analysis';
import { ratesFor } from '../scripts/sample-analysis';

/** Synthetic payload: cues double as timed words (inter-start gaps < 1 s,
 * so the pause-excluded duration equals the cue span). */
function parsed(cues: Array<{ text: string; startSec: number }>): ParsedCaptions {
  return {
    cues,
    words: cues.map((c) => ({ text: c.text, startSec: c.startSec })),
  };
}

const SPEECH = parsed([
  { text: 'one two', startSec: 0 },
  { text: 'three', startSec: 0.5 },
  { text: 'four five', startSec: 1 },
  { text: 'six', startSec: 1.5 },
]);

describe('ratesFor language-awareness', () => {
  it('applies the ar syllablesPerWord factor (2.0) to both rates', () => {
    const words = ratesFor(SPEECH);
    const ar = ratesFor(SPEECH, LANGUAGES['ar']);
    expect(words?.unifiedRate).toBeCloseTo(240, 6);
    // 6 words × 2.0 syl/word over a 1.5 s span
    expect(ar?.unifiedRate).toBeCloseTo(480, 6);
    expect(ar?.wordAccurateRate).toBeCloseTo(480, 6);
    expect(ar?.pauseBiasPct).toBeCloseTo(0, 6);
  });

  it('applies the id syllablesPerWord factor (1.5)', () => {
    const id = ratesFor(SPEECH, LANGUAGES['id']);
    expect(id?.unifiedRate).toBeCloseTo(360, 6);
  });

  it('keeps words-mode behavior without a model', () => {
    expect(ratesFor(SPEECH)?.unifiedRate).toBeCloseTo(240, 6);
  });
});

function baseRecord(over: Partial<CorpusRecord>): CorpusRecord {
  return {
    videoId: 'x',
    url: 'https://www.youtube.com/watch?v=x',
    language: 'hi',
    register: 'news',
    title: null,
    classification: 'web-ok',
    error: null,
    asrLang: 'hi',
    trackCount: 1,
    asrCount: 1,
    status: 'web-captured',
    webAsrCount: 1,
    androidKind: 'asr',
    androidLang: 'hi',
    androidTrackCount: 1,
    webBytes: 100000,
    windowsWords: 100,
    windowsCues: 50,
    segsWords: 100,
    segsCues: 50,
    wordsParity: true,
    cuesParity: true,
    unifiedRate: null,
    wordAccurateRate: null,
    pauseBiasPct: null,
    rateSource: 'web',
    coveragePct: 80,
    regexCount: null,
    icuCount: null,
    countDeltaPct: null,
    bandMin: null,
    bandMax: null,
    bandMid: null,
    inBand: null,
    withinBandPct: null,
    detectExpected: 'news',
    detectActual: 'news',
    durationSec: 600,
    provenance: null,
    captureDate: '2026-08-14',
    ...over,
  };
}

/** Two hi news records inside the current hi band (midpoint of the ±20%
 * gate window is always inside), determinism-clean — the G1/G2/G3/G4 pass
 * shape for the hi vowels-mode gate test. */
function hiNewsPair(): CorpusRecord[] {
  const band = registerBand('hi', 'news')!;
  const mid = (band.min + band.max) / 2;
  return [
    baseRecord({ videoId: 'hi1', unifiedRate: mid, inBand: true }),
    baseRecord({ videoId: 'hi2', unifiedRate: mid, inBand: true }),
  ];
}

describe('hi vowels-mode G3 gate', () => {
  it('runs the determinism + hand-annotated sample gate, not regex-icu', () => {
    const records = hiNewsPair().map((r) => ({ ...r, countDeltaPct: 0 }));
    const summary = summarizeLang(records, 'hi');
    expect(summary.g3.mode).toBe('vowels-sample');
    // 2 determinism rows + 7 sample rows
    expect(summary.g3.n).toBe(2 + DEVANAGARI_G3_SAMPLE.length);
    expect(summary.g3.pass).toBe(true);
    expect((summary.g3.maxDeltaPct ?? 0)).toBeLessThanOrEqual(10);
  });

  it('every sample row lands inside the documented ±10% band', () => {
    for (const row of DEVANAGARI_G3_SAMPLE) {
      expect(row.syllables).toBeGreaterThan(0);
    }
    const records = hiNewsPair().map((r) => ({ ...r, countDeltaPct: 0 }));
    const { g3 } = summarizeLang(records, 'hi');
    expect(g3.maxDeltaPct).toBeLessThanOrEqual(10);
  });

  it('a drifting determinism row fails the gate and blocks the verdict', () => {
    const records = hiNewsPair().map((r, i) => ({
      ...r,
      countDeltaPct: i === 0 ? 42 : 0,
    }));
    const summary = summarizeLang(records, 'hi');
    expect(summary.g3.pass).toBe(false);
    expect(summary.g3.violations[0]).toMatch(/^determinism hi1 /);
    expect(summary.verdict).toBe('stays-derived');
  });

  it('grants corpus-validated to hi on G1∧G2∧G3∧G4 (mirror slavic)', () => {
    const records = hiNewsPair().map((r) => ({ ...r, countDeltaPct: 0 }));
    const summary = summarizeLang(records, 'hi');
    expect(summary.g1.pass).toBe(true);
    expect(summary.g2.pass).toBe(true);
    expect(summary.g3.pass).toBe(true);
    expect(summary.g4.pass).toBe(true);
    expect(summary.verdict).toBe('corpus-validated');
  });
});

describe('words-mode G3 stays regex-icu', () => {
  it('reports mode regex-icu for ru records', () => {
    const records = hiNewsPair().map((r) => ({
      ...r,
      language: 'ru',
      register: 'news',
      countDeltaPct: 0.2,
      asrLang: 'ru',
    }));
    const summary = summarizeLang(records, 'ru');
    expect(summary.g3.mode).toBe('regex-icu');
    expect(summary.g3.n).toBe(2);
    expect(summary.g3.pass).toBe(true);
  });
});
