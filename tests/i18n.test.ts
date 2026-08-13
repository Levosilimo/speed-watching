import { describe, expect, it } from 'vitest';
import {
  STRINGS,
  extractUnit,
  formatMultiplier,
  resolveUiLanguage,
  t,
  tierKeyFromLabel,
  tierLabel,
  unitLabel,
} from '../lib/i18n';
import { UNIT_LABELS } from '../lib/languages';
import { TIER_LABELS } from '../lib/recommend';

describe('i18n — completeness', () => {
  it('covers the same key set in every locale', () => {
    expect(Object.keys(STRINGS.ru).sort()).toEqual(Object.keys(STRINGS.en).sort());
  });

  it('keeps the canonical English tier and unit labels byte-identical', () => {
    expect(t('tier.asrWord', 'en')).toBe(TIER_LABELS['asr-word']);
    expect(t('tier.asrCue', 'en')).toBe(TIER_LABELS['asr-cue']);
    expect(t('tier.manualCue', 'en')).toBe(TIER_LABELS['manual-cue']);
    expect(t('tier.estimated', 'en')).toBe(TIER_LABELS['estimated']);
    expect(t('unit.wpm', 'en')).toBe(UNIT_LABELS.wpm);
    expect(t('unit.cpm', 'en')).toBe(UNIT_LABELS.cpm);
    expect(t('unit.syl', 'en')).toBe(UNIT_LABELS.syl);
    expect(t('unit.mora', 'en')).toBe(UNIT_LABELS.mora);
  });

  it('uses natural Russian unit labels', () => {
    expect(t('unit.wpm', 'ru')).toBe('слов/мин');
    expect(t('unit.cpm', 'ru')).toBe('симв/мин');
    expect(t('unit.syl', 'ru')).toBe('слогов/мин');
    expect(t('unit.mora', 'ru')).toBe('мор/мин');
  });
});

describe('resolveUiLanguage', () => {
  it('follows the browser UI language on auto', () => {
    expect(resolveUiLanguage('auto', 'ru-RU')).toBe('ru');
    expect(resolveUiLanguage('auto', 'ru')).toBe('ru');
    expect(resolveUiLanguage('auto', 'RU-ru')).toBe('ru');
    expect(resolveUiLanguage('auto', 'en-US')).toBe('en');
    expect(resolveUiLanguage(undefined, 'en-US')).toBe('en');
    expect(resolveUiLanguage(undefined, 'fr-FR')).toBe('en');
  });

  it('an explicit setting overrides auto', () => {
    expect(resolveUiLanguage('ru', 'en-US')).toBe('ru');
    expect(resolveUiLanguage('en', 'ru-RU')).toBe('en');
  });
});

describe('t', () => {
  it('substitutes {params} in both locales', () => {
    expect(t('pill.label.recommend', 'en', { mult: '1.55', rate: 248, unit: 'wpm' })).toBe(
      '→ 1.55x ≈ 248 wpm',
    );
    expect(t('pill.label.recommend', 'ru', { mult: '1,55', rate: 248, unit: 'слов/мин' })).toBe(
      '→ 1,55× ≈ 248 слов/мин',
    );
    expect(t('options.removeAria', 'en', { host: 'ted.com' })).toBe(
      'Remove override for ted.com',
    );
  });

  it('returns the raw string when no params are given', () => {
    expect(t('pill.apply', 'en')).toBe('Apply');
    expect(t('pill.apply', 'ru')).toBe('Применить');
  });
});

describe('formatMultiplier', () => {
  it('uses a decimal comma in Russian and an ASCII dot in English', () => {
    expect(formatMultiplier(1.55, 'en')).toBe('1.55');
    expect(formatMultiplier(1.55, 'ru')).toBe('1,55');
    expect(formatMultiplier(2, 'en')).toBe('2');
    expect(formatMultiplier(2, 'ru')).toBe('2');
  });
});

describe('extractUnit', () => {
  it('recovers the rate unit from a recommendation label', () => {
    expect(extractUnit('→ 1.9x ≈ 380 morae/min')).toBe('mora');
    expect(extractUnit('→ 1.5x ≈ 340 syl/min')).toBe('syl');
    expect(extractUnit('→ 1.55x ≈ 248 wpm')).toBe('wpm');
    expect(extractUnit('safe zone unreachable — 2x ≈ 200 cpm')).toBe('cpm');
  });

  it('defaults to wpm for unit-free labels', () => {
    expect(extractUnit('music — speed not recommended')).toBe('wpm');
  });
});

describe('tierKeyFromLabel', () => {
  it('maps the English tier strings back to their keys', () => {
    expect(tierKeyFromLabel('estimated')).toBe('estimated');
    expect(tierKeyFromLabel('from captions (corrected)')).toBe('manual-cue');
    // asr-word and asr-cue share the 'from captions' label; either key
    // localizes to the same string.
    expect(['asr-word', 'asr-cue']).toContain(tierKeyFromLabel('from captions'));
  });

  it('returns null for unknown labels', () => {
    expect(tierKeyFromLabel('nonsense')).toBeNull();
  });
});

describe('unitLabel / tierLabel', () => {
  it('localizes the unit and tier per locale', () => {
    expect(unitLabel('wpm', 'en')).toBe('wpm');
    expect(unitLabel('wpm', 'ru')).toBe('слов/мин');
    expect(unitLabel('mora', 'ru')).toBe('мор/мин');
    expect(tierLabel('manual-cue', 'en')).toBe('from captions (corrected)');
    expect(tierLabel('manual-cue', 'ru')).toBe('по субтитрам (с коррекцией)');
    expect(tierLabel('estimated', 'ru')).toBe('оценка');
  });
});
