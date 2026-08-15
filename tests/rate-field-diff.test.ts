// Field-diff spec lane (Wave 3): classifyRateFieldDiff's observable contract
// against the COMMITTED golden-master registry — a speech record's measured
// rate vs the row's recorded full-payload rate for the same metric class,
// within the pinned ratesRel band (within = benign, outside = breaking).
// The rows are the committed registry (never regenerated); the records are
// shaped like the runner's initRecord + measure payload, so the spec pins
// the classification contract, not the implementation.

import { describe, expect, it } from 'vitest';
import type { MeasureEventDetail } from '../lib/measure-hooks';
import { classifyRateFieldDiff } from '../scripts/rate-field-diff';
import { initRecord, type RealsiteRecord } from '../scripts/realsite-runner-lib';
import { loadRegistry } from './fixtures/registry';

const rows = loadRegistry();

function speechRecord(videoId: string, stats: MeasureEventDetail['stats']): RealsiteRecord {
  const record = initRecord({ videoId, category: 'talk', kind: 'speech' });
  record.measure = {
    videoId,
    kind: 'asr',
    lang: 'en',
    stats,
    line: `video=${videoId} kind=asr lang=en: wpm word-level=${stats.word} cue-level=${stats.cue} corrected=${stats.corrected} nWords=${stats.nWords}`,
  };
  return record;
}

/** The recorded full-payload word-level rate of the asr-word registry slot
 * (iG9CE55wbtY) — the anchor the measured rate is compared against. */
const IG9_PINNED_WORD_WPM = 140.5117560992208;

describe('classifyRateFieldDiff', () => {
  it('anchors on the registry row recorded rate for the same videoId and metric', () => {
    const diff = classifyRateFieldDiff(speechRecord('iG9CE55wbtY', {
      word: 141.0,
      cue: 167.0,
      corrected: 167.0,
      nWords: 2753,
    }), rows);
    expect(diff).not.toBeNull();
    expect(diff?.videoId).toBe('iG9CE55wbtY');
    expect(diff?.metric).toBe('word');
    expect(diff?.pinnedWpm).toBeCloseTo(IG9_PINNED_WORD_WPM, 6);
    expect(diff?.measuredWpm).toBeCloseTo(141.0, 6);
  });

  it('classifies inside the pinned band as benign', () => {
    // +0.3% — far inside ratesRel 0.15.
    const diff = classifyRateFieldDiff(speechRecord('iG9CE55wbtY', {
      word: 141.0,
      cue: 167.0,
      corrected: 167.0,
      nWords: 2753,
    }), rows);
    expect(diff?.verdict).toBe('benign');
    expect(diff?.relDeltaPct).toBeCloseTo(((141.0 - IG9_PINNED_WORD_WPM) / IG9_PINNED_WORD_WPM) * 100, 6);
  });

  it('classifies a rate drift beyond the band as breaking', () => {
    // +42% — a re-uploaded or re-timed caption file.
    const diff = classifyRateFieldDiff(speechRecord('iG9CE55wbtY', {
      word: 200.0,
      cue: 167.0,
      corrected: 167.0,
      nWords: 2753,
    }), rows);
    expect(diff?.verdict).toBe('breaking');
  });

  it('reports the negative delta direction below the pin', () => {
    const diff = classifyRateFieldDiff(speechRecord('iG9CE55wbtY', {
      word: 120.0,
      cue: 167.0,
      corrected: 167.0,
      nWords: 2753,
    }), rows);
    expect(diff?.relDeltaPct).toBeLessThan(0);
    expect(diff?.verdict).toBe('benign'); // −14.6% is still inside 0.15
  });

  it('anchors the cue metric on the recorded cueWpm', () => {
    // The manual-cue registry slot (qp0HIF3SfI4) records cueWpm 170.18.
    const diff = classifyRateFieldDiff(speechRecord('qp0HIF3SfI4', {
      word: undefined,
      cue: 170.0,
      corrected: 181.65,
      nWords: 3015,
    }), rows);
    expect(diff?.metric).toBe('cue');
    expect(diff?.pinnedWpm).toBeCloseTo(170.1787394167451, 6);
    expect(diff?.verdict).toBe('benign');
  });

  it('returns null when the registry row records no rate for the metric', () => {
    // Ks-_Mh1QhMc has a row, but its recorded block carries no wordWpm.
    expect(classifyRateFieldDiff(speechRecord('Ks-_Mh1QhMc', {
      word: 161.0,
      cue: 183.0,
      corrected: 183.0,
      nWords: 3297,
    }), rows)).toBeNull();
  });

  it('returns null for videos without a registry row', () => {
    expect(classifyRateFieldDiff(speechRecord('HtSuA80QTyo', {
      word: 180.0,
      cue: 190.0,
      corrected: 190.0,
      nWords: 5000,
    }), rows)).toBeNull();
  });

  it('never diffs non-speech kinds', () => {
    const record = initRecord({ videoId: 'iG9CE55wbtY', category: 'music', kind: 'music' });
    record.measure = {
      videoId: 'iG9CE55wbtY',
      kind: 'music',
      lang: 'en',
      stats: { word: 141.0, cue: 167.0, corrected: 167.0, nWords: 2753 },
      line: 'music',
    };
    expect(classifyRateFieldDiff(record, rows)).toBeNull();
  });

  it('returns null without a measured rate', () => {
    const record = initRecord({ videoId: 'iG9CE55wbtY', category: 'talk', kind: 'speech' });
    expect(classifyRateFieldDiff(record, rows)).toBeNull();
  });

  it('keeps the record diff null by default (no fabricated anchor)', () => {
    expect(initRecord({ videoId: 'iG9CE55wbtY', category: 'talk', kind: 'speech' }).rateDiff).toBeNull();
  });
});
