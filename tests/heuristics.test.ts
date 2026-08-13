import { describe, expect, it } from 'vitest';
import type { WpmRange } from '../lib/heuristics';
import { priorMidpoint, priorRange } from '../lib/heuristics';
import { LANGUAGES } from '../lib/languages';

describe('priorRange', () => {
  it('returns the measured anchors for known content types', () => {
    const talk: WpmRange = priorRange('talk');
    expect(talk).toEqual({ min: 140, max: 206 });
    expect(priorRange('lecture')).toEqual({ min: 110, max: 188 });
    expect(priorRange('explainer')).toEqual({ min: 103, max: 191 });
    expect(priorRange('news')).toEqual({ min: 127, max: 150 });
  });

  it('falls back to defaults for unmeasured types', () => {
    expect(priorRange('podcast')).toEqual({ min: 140, max: 200 });
    expect(priorRange('generic')).toEqual({ min: 130, max: 190 });
    expect(priorRange('unknown')).toEqual({ min: 130, max: 190 });
    expect(priorRange('music')).toEqual({ min: 130, max: 190 });
  });
});

describe('priorMidpoint', () => {
  it('is the range midpoint, the estimated-tier natural rate', () => {
    expect(priorMidpoint('generic')).toBe(160);
    expect(priorMidpoint('talk')).toBe(173);
    expect(priorMidpoint('podcast')).toBe(170);
    expect(priorMidpoint('unknown')).toBe(160);
  });
});

describe('priorRange — language-aware', () => {
  it('uses the language priors for known non-English tracks', () => {
    expect(priorRange('lecture', LANGUAGES['ja'])).toEqual(LANGUAGES['ja']?.priors);
    expect(priorRange('generic', LANGUAGES['de'])).toEqual(LANGUAGES['de']?.priors);
  });

  it('resolves the ru register bands per content type', () => {
    expect(priorRange('news', LANGUAGES['ru'])).toEqual({ min: 120, max: 150 });
    expect(priorRange('lecture', LANGUAGES['ru'])).toEqual({ min: 95, max: 135 });
    expect(priorRange('podcast', LANGUAGES['ru'])).toEqual({ min: 100, max: 140 });
    expect(priorRange('generic', LANGUAGES['ru'])).toEqual({ min: 105, max: 145 });
    expect(priorRange('talk', LANGUAGES['uk'])).toEqual({ min: 100, max: 140 });
  });

  it('falls back to the language generic band for registers without a band', () => {
    expect(priorRange('music', LANGUAGES['ru'])).toEqual({ min: 105, max: 145 });
    expect(priorRange('unknown', LANGUAGES['ru'])).toEqual(LANGUAGES['ru']?.priors);
  });

  it('keeps the measured content-type anchors for English and unmapped tracks', () => {
    expect(priorRange('lecture', LANGUAGES['en'])).toEqual({ min: 110, max: 188 });
    expect(priorRange('lecture')).toEqual({ min: 110, max: 188 });
    expect(priorRange('news', LANGUAGES['en'])).toEqual({ min: 127, max: 150 });
  });
});

describe('priorMidpoint — language-aware', () => {
  it('is the language prior midpoint for non-English tracks', () => {
    const ja = LANGUAGES['ja']!;
    expect(priorMidpoint('generic', ja)).toBe((ja.priors.min + ja.priors.max) / 2);
  });

  it('is the register band midpoint when the type resolves to one', () => {
    expect(priorMidpoint('news', LANGUAGES['ru'])).toBe(135);
    expect(priorMidpoint('lecture', LANGUAGES['ru'])).toBe(115);
  });

  it('keeps the English midpoints without a language', () => {
    expect(priorMidpoint('generic')).toBe(160);
    expect(priorMidpoint('talk')).toBe(173);
  });
});
