import { describe, expect, it } from 'vitest';
import { LANGUAGES, UNIT_LABELS, normalizeLanguageCode, resolveLanguage } from '../lib/languages';

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
    expect(LANGUAGES['ja']).toMatchObject({ unit: 'cpm', target: 380, ceiling: 400, tokenizerMode: 'chars' });
    expect(LANGUAGES['zh']).toMatchObject({ unit: 'cpm', target: 240, ceiling: 258, tokenizerMode: 'chars' });
    expect(LANGUAGES['th']).toMatchObject({ unit: 'cpm', tokenizerMode: 'chars' });
    expect(LANGUAGES['ko']).toMatchObject({ unit: 'syl', target: 340, ceiling: 350, hangulBlocks: true });
    expect(LANGUAGES['ar']).toMatchObject({ unit: 'syl', target: 330, ceiling: 360 });
    expect(LANGUAGES['tr']).toMatchObject({ unit: 'syl', target: 340, ceiling: 350 });
    expect(LANGUAGES['hi']).toMatchObject({ unit: 'syl', target: 240, tokenizerMode: 'words-marks' });
    expect(LANGUAGES['ru']).toMatchObject({ target: 168, ceiling: 185 });
    expect(LANGUAGES['uk']).toMatchObject({ target: 168, ceiling: 185 });
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
      expect(model.priors.max, code).toBeLessThan(model.target);
    }
  });

  it('labels the units for the pill', () => {
    expect(UNIT_LABELS).toEqual({ wpm: 'wpm', cpm: 'cpm', syl: 'syl/min' });
  });
});
