import { describe, expect, it } from 'vitest';
import { LANGUAGES, UNIT_LABELS, normalizeLanguageCode, resolveLanguage } from '../lib/languages';
import type { ContentType } from '../lib/music';

describe('normalizeLanguageCode', () => {
  it('lowercases and strips the region', () => {
    expect(normalizeLanguageCode('en-US')).toBe('en');
    expect(normalizeLanguageCode('EN')).toBe('en');
    expect(normalizeLanguageCode('zh-Hans')).toBe('zh');
    expect(normalizeLanguageCode('zh-CN')).toBe('zh');
    expect(normalizeLanguageCode('zh-TW')).toBe('zh');
    expect(normalizeLanguageCode('es-419')).toBe('es');
    expect(normalizeLanguageCode('pt-BR')).toBe('pt');
    expect(normalizeLanguageCode('pt-PT')).toBe('pt');
  });

  it('returns null for an empty code', () => {
    expect(normalizeLanguageCode('')).toBeNull();
  });
});

describe('resolveLanguage', () => {
  it('resolves known codes to their model', () => {
    expect(resolveLanguage('en-US')?.code).toBe('en');
    expect(resolveLanguage('pt-BR')?.code).toBe('pt');
    expect(resolveLanguage('zh-Hans')?.code).toBe('zh');
    expect(resolveLanguage('ko')?.unit).toBe('syl');
  });

  it('returns null for unmapped or missing codes', () => {
    expect(resolveLanguage('xx')).toBeNull();
    expect(resolveLanguage('')).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
  });
});

describe('language table', () => {
  it('covers the v1.0 language set', () => {
    const codes = ['en', 'es', 'pt', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'ar', 'tr', 'hi', 'th', 'vi', 'id', 'ms', 'tl', 'ru', 'uk', 'pl', 'cs', 'sr'];
    for (const code of codes) {
      expect(LANGUAGES[code], code).toBeDefined();
    }
  });

  it('labels everything except en and zh as derived', () => {
    expect(LANGUAGES['en']?.derived).toBe(false);
    // zh's 258 cpm ceiling is the only comprehension-measured ceiling in the set.
    expect(LANGUAGES['zh']?.derived).toBe(false);
    for (const [code, model] of Object.entries(LANGUAGES)) {
      if (code !== 'en' && code !== 'zh') expect(model.derived, code).toBe(true);
    }
  });

  it('pins the research constants', () => {
    expect(LANGUAGES['en']).toMatchObject({ unit: 'wpm', target: 250, ceiling: 275, tokenizerMode: 'words' });
    expect(LANGUAGES['es']).toMatchObject({ target: 170, ceiling: 175 });
    expect(LANGUAGES['it']).toMatchObject({ target: 180, ceiling: 184 });
    expect(LANGUAGES['pt']).toMatchObject({ target: 165, ceiling: 167 });
    expect(LANGUAGES['fr']).toMatchObject({ target: 250, ceiling: 253 });
    expect(LANGUAGES['de']).toMatchObject({ target: 175, ceiling: 181 });
    expect(LANGUAGES['ja']).toMatchObject({ unit: 'mora', target: 380, ceiling: 400, tokenizerMode: 'mora' });
    expect(LANGUAGES['zh']).toMatchObject({ unit: 'cpm', target: 240, ceiling: 258, tokenizerMode: 'chars' });
    expect(LANGUAGES['th']).toMatchObject({ unit: 'cpm', tokenizerMode: 'chars' });
    expect(LANGUAGES['ko']).toMatchObject({ unit: 'syl', target: 340, ceiling: 350, hangulBlocks: true });
    expect(LANGUAGES['ar']).toMatchObject({ unit: 'syl', target: 330, ceiling: 360, syllablesPerWord: 2.0 });
    expect(LANGUAGES['tr']).toMatchObject({ unit: 'syl', target: 340, ceiling: 350, tokenizerMode: 'vowels' });
    expect(LANGUAGES['hi']).toMatchObject({ unit: 'syl', target: 240, tokenizerMode: 'vowels' });
    // The vowel-nucleus counters replaced tr's 2.3 and hi's 1.5 factors.
    expect(LANGUAGES['tr']?.syllablesPerWord).toBeUndefined();
    expect(LANGUAGES['hi']?.syllablesPerWord).toBeUndefined();
    expect(LANGUAGES['ru']).toMatchObject({ target: 168, ceiling: 180 });
    expect(LANGUAGES['uk']).toMatchObject({ target: 168, ceiling: 180 });
    expect(LANGUAGES['pl']).toMatchObject({ target: 185, ceiling: 200 });
    expect(LANGUAGES['cs']).toMatchObject({ target: 185, ceiling: 200 });
    expect(LANGUAGES['sr']).toMatchObject({ target: 185, ceiling: 200 });
    expect(LANGUAGES['vi']).toMatchObject({ unit: 'wpm', target: 280, ceiling: 290 });
    expect(LANGUAGES['id']).toMatchObject({ unit: 'syl', target: 400 });
    expect(LANGUAGES['ms']).toMatchObject({ unit: 'syl', target: 400 });
    expect(LANGUAGES['tl']).toMatchObject({ unit: 'syl', target: 400 });
  });

  it('gives every priors range within its own target band', () => {
    for (const [code, model] of Object.entries(LANGUAGES)) {
      expect(model.priors.min, code).toBeLessThan(model.priors.max);
      // Ratio-derived priors stay below the target; corpus-measured bands
      // are measurements and can reach or exceed it (uk talk rides the
      // ceiling; ja/th natural rates sit at/above the derived targets —
      // the estimated tier's range then overlaps the safe zone, which is
      // the measured finding, not a modeling error).
      if (model.priorsSource !== 'corpus') {
        expect(model.priors.min, code).toBeLessThan(model.target);
        expect(model.priors.max, code).toBeLessThan(model.target);
      }
    }
  });

  it('anchors ru register priors to the gathered Russian rate norms', () => {
    const register: Partial<Record<ContentType, { min: number; max: number }>> = {
      news: { min: 120, max: 150 },
      podcast: { min: 100, max: 140 },
      lecture: { min: 95, max: 135 },
      explainer: { min: 100, max: 140 },
      talk: { min: 100, max: 140 },
      generic: { min: 105, max: 145 },
    };
    const model = LANGUAGES['ru']!;
    expect(model.registerPriors).toEqual(register);
    expect(model.priors).toEqual(register.generic);
    for (const [type, band] of Object.entries(register)) {
      expect(band!.min, `ru ${type}`).toBeGreaterThan(0);
      expect(band!.max, `ru ${type}`).toBeLessThan(model.target);
    }
  });

  it('anchors uk register priors to its measured lecture/talk bands', () => {
    // uk news/podcast/explainer are unmeasured and keep the ru-copied bands;
    // lecture/talk are measured (phase0-slavic-corpus, median ± 20 wpm).
    const uk = LANGUAGES['uk']!;
    expect(uk.registerPriors).toEqual({
      news: { min: 120, max: 150 },
      podcast: { min: 100, max: 140 },
      lecture: { min: 110, max: 150 },
      explainer: { min: 100, max: 140 },
      talk: { min: 140, max: 180 },
      generic: { min: 120, max: 160 },
    });
    expect(uk.priors).toEqual({ min: 120, max: 160 });
    // measured bands can ride the derived target: uk talk measures at the
    // safe zone, so its band top equals the ceiling rather than sitting
    // below the target.
    expect(uk.registerPriors?.talk?.max).toBe(uk.ceiling);
  });

  it('keeps the register priors off every other language', () => {
    const withRegisters = ['ru', 'uk', 'ar', 'id', 'vi', 'ms', 'tl', 'ja', 'th', 'ko'];
    for (const [code, model] of Object.entries(LANGUAGES)) {
      if (withRegisters.includes(code)) continue;
      expect(model.registerPriors, code).toBeUndefined();
    }
  });

  it('anchors ar/id/vi register priors to the captionless-reach corpus', () => {
    // Built bands = measured median ± 20 (2026-08 phase0-captionless-corpus),
    // labeled corpus-derived; the generic band is the union mid.
    const ar = LANGUAGES['ar']!;
    expect(ar.priorsSource).toBe('corpus');
    expect(ar.priors).toEqual({ min: 195, max: 235 });
    expect(ar.registerPriors).toEqual({
      news: { min: 195, max: 235 },
      lecture: { min: 165, max: 205 },
      explainer: { min: 150, max: 190 },
      podcast: { min: 235, max: 275 },
      generic: { min: 195, max: 235 },
    });
    const id = LANGUAGES['id']!;
    expect(id.priorsSource).toBe('corpus');
    expect(id.priors).toEqual({ min: 200, max: 240 });
    expect(id.registerPriors).toEqual({
      news: { min: 185, max: 225 },
      lecture: { min: 160, max: 200 },
      explainer: { min: 175, max: 215 },
      podcast: { min: 240, max: 280 },
      generic: { min: 200, max: 240 },
    });
    const vi = LANGUAGES['vi']!;
    expect(vi.priorsSource).toBe('corpus');
    expect(vi.priors).toEqual({ min: 185, max: 225 });
    expect(vi.registerPriors).toEqual({
      news: { min: 205, max: 245 },
      lecture: { min: 160, max: 200 },
      explainer: { min: 190, max: 230 },
      podcast: { min: 180, max: 220 },
      generic: { min: 185, max: 225 },
    });
    for (const code of ['ar', 'id', 'vi']) {
      const model = LANGUAGES[code]!;
      expect(model.priors, code).toEqual(model.registerPriors?.generic);
      for (const [type, band] of Object.entries(model.registerPriors ?? {})) {
        expect(band!.min, `${code} ${type}`).toBeGreaterThan(0);
        expect(band!.max, `${code} ${type}`).toBeLessThan(model.target);
      }
    }
  });

  it('anchors ja/th/ko register priors to the east-asian corpus', () => {
    // Built bands = measured median ± 20 in the language's unit (2026-08
    // phase0-east-asian-corpus), labeled corpus-derived; the generic band
    // is the union mid. These are the first bands that reach/exceed the
    // derived targets — the priors.max < target invariant is relaxed for
    // corpus-measured languages (see the within-target-band spec).
    const ja = LANGUAGES['ja']!;
    expect(ja.priorsSource).toBe('corpus');
    expect(ja.unit).toBe('mora');
    expect(ja.priors).toEqual({ min: 395, max: 435 });
    expect(ja.registerPriors).toEqual({
      news: { min: 335, max: 375 },
      lecture: { min: 450, max: 490 },
      explainer: { min: 385, max: 425 },
      podcast: { min: 450, max: 490 },
      generic: { min: 395, max: 435 },
    });
    const th = LANGUAGES['th']!;
    expect(th.priorsSource).toBe('corpus');
    expect(th.unit).toBe('cpm');
    expect(th.priors).toEqual({ min: 505, max: 545 });
    expect(th.registerPriors).toEqual({
      news: { min: 545, max: 585 },
      lecture: { min: 420, max: 460 },
      explainer: { min: 590, max: 630 },
      podcast: { min: 535, max: 575 },
      generic: { min: 505, max: 545 },
    });
    const ko = LANGUAGES['ko']!;
    expect(ko.priorsSource).toBe('corpus');
    expect(ko.unit).toBe('syl');
    expect(ko.priors).toEqual({ min: 305, max: 345 });
    expect(ko.registerPriors).toEqual({
      news: { min: 265, max: 305 },
      lecture: { min: 320, max: 360 },
      explainer: { min: 350, max: 390 },
      podcast: { min: 260, max: 300 },
      generic: { min: 305, max: 345 },
    });
    for (const code of ['ja', 'th', 'ko']) {
      const model = LANGUAGES[code]!;
      expect(model.priors, code).toEqual(model.registerPriors?.generic);
      expect(model.derived, code).toBe(true);
    }
  });

  it('copies id measured priors to ms/tl', () => {
    for (const code of ['ms', 'tl']) {
      const model = LANGUAGES[code]!;
      expect(model.priorsSource, code).toBe('corpus');
      expect(model.priors, code).toEqual(LANGUAGES['id']?.priors);
      expect(model.registerPriors, code).toEqual(LANGUAGES['id']?.registerPriors);
    }
  });

  it('keeps hi measured but ratio-derived (addendum-only)', () => {
    // hi's medians sit far above the derived band and the Devanagari
    // counter overcounts code-mixed text — no band is built.
    const hi = LANGUAGES['hi']!;
    expect(hi.priorsSource).toBeUndefined();
    expect(hi.registerPriors).toBeUndefined();
    expect(hi.priors).toEqual({ min: 125, max: 182 });
  });

  it('uses the script counters only where intended', () => {
    for (const [code, model] of Object.entries(LANGUAGES)) {
      if (code === 'ja') expect(model.tokenizerMode).toBe('mora');
      else if (code === 'tr' || code === 'hi') expect(model.tokenizerMode).toBe('vowels');
      else expect(['words', 'words-marks', 'chars']).toContain(model.tokenizerMode);
    }
  });

  it('labels the units for the pill', () => {
    expect(UNIT_LABELS).toEqual({ wpm: 'wpm', cpm: 'cpm', syl: 'syl/min', mora: 'morae/min' });
  });
});
