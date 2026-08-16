import { describe, expect, it } from 'vitest';
import { priorMidpoint } from '../lib/heuristics';
import { LANGUAGES, resolveLanguage } from '../lib/languages';
import { recommend } from '../lib/recommend';

// The estimated tier (P2): a resolved track/UI language must drive the
// natural-rate prior, the recommend math, and the displayed range as ONE
// model instance. Dropping the language anywhere (the pre-fix shape) falls
// back to the en 250/275 defaults and breaks the ru zone.

describe('estimated tier — resolved language threads math and range', () => {
  it('priorMidpoint resolves the ru register priors, not the en generic 160', () => {
    const ru = resolveLanguage('ru')!;
    expect(ru).toBe(LANGUAGES['ru']); // the table instance, not a copy
    // ru generic band 105–145 → midpoint 125; the register bands resolve too.
    expect(priorMidpoint('generic', ru)).toBe(125);
    expect(priorMidpoint('news', ru)).toBe(135);
    expect(priorMidpoint('lecture', ru)).toBe(115);
    // The no-language shape keeps the en anchor: 160 — a caller that drops
    // the language silently measures against English.
    expect(priorMidpoint('generic')).toBe(160);
  });

  it('recommend targets the ru 168 wpm target from the ru midpoint (1.35x)', () => {
    const ru = resolveLanguage('ru')!;
    const rec = recommend({
      naturalRate: 125,
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
      language: ru,
    });
    expect(rec.multiplier).toBe(1.35);
    expect(rec.effectiveWpm).toBeCloseTo(168.75, 2);
    expect(rec.label).toBe('→ 1.35x ≈ 169 wpm');
    expect(rec.mode).toBe('recommend');
    // The same rate without the language targets 250: 2x ≈ 250 wpm — the
    // divergence the fix closed.
    const en = recommend({ naturalRate: 125, tier: 'estimated', contentType: 'generic', platformMax: 2 });
    expect(en.multiplier).toBe(2);
    expect(en.label).toBe('→ 2x ≈ 250 wpm');
  });

  it('lands the effective rate inside the displayed ru range (168–180)', () => {
    const ru = resolveLanguage('ru')!;
    // renderRecommendation derives the pill range straight from the model.
    const range = { lo: ru.target, hi: ru.ceiling, unit: ru.unit };
    expect(range).toEqual({ lo: 168, hi: 180, unit: 'wpm' });
    const rec = recommend({
      naturalRate: priorMidpoint('generic', ru),
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
      language: ru,
    });
    expect(rec.effectiveWpm).toBeGreaterThanOrEqual(range.lo);
    expect(rec.effectiveWpm).toBeLessThanOrEqual(range.hi);
    // Without the language the same rate breaks the ru zone (250 > 180).
    const en = recommend({
      naturalRate: priorMidpoint('generic', ru),
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
    });
    expect(en.effectiveWpm).toBeGreaterThan(range.hi);
  });

  it('keeps the ja estimated math unit-coherent (morae target ÷ morae prior)', () => {
    const ja = resolveLanguage('ja')!;
    expect(ja.unit).toBe('mora');
    // ja generic band 395–435 morae/min → midpoint 415; target 470 morae/min.
    // The rate and the target share the unit, so the multiplier stays sane.
    const rec = recommend({
      naturalRate: priorMidpoint('generic', ja),
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
      language: ja,
    });
    expect(rec.multiplier).toBeCloseTo(1.15, 5);
    expect(rec.mode).toBe('recommend');
    // The en-anchored prior shape (a caller that drops the language) divides
    // the morae target by the wpm prior — 470 ÷ 160 → clamped to 2x in
    // unreachable mode: the unit mix the estimated call sites must avoid.
    const mixed = recommend({
      naturalRate: priorMidpoint('generic'),
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
      language: ja,
    });
    expect(mixed.multiplier).toBe(2);
    expect(mixed.mode).toBe('unreachable');
  });

  it('keeps the no-language defaults byte-identical (en 250/275 anchors)', () => {
    const rec = recommend({ naturalRate: 160, tier: 'estimated', contentType: 'generic', platformMax: 2 });
    expect(rec.multiplier).toBe(1.55);
    expect(rec.effectiveWpm).toBe(248);
    expect(rec.label).toBe('→ 1.55x ≈ 248 wpm');
    expect(rec.mode).toBe('recommend');
  });
});
