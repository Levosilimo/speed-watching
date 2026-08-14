import { describe, expect, it } from 'vitest';
import {
  formatTimeSaved,
  STRINGS,
  extractUnit,
  formatMultiplier,
  resolveUiLanguage,
  t,
  tierKeyFromLabel,
  tierLabel,
  timeUnit,
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

describe('time-saved strings (12 new keys, both locales)', () => {
  it('holds the spec copy in English', () => {
    expect(t('options.timeSavedHeadline', 'en', { amount: '9', unit: 'hours' })).toBe(
      '≈ 9 hours reclaimed (estimate)',
    );
    expect(t('options.timeSavedStarted', 'en')).toBe('Time-saved tracking started');
    expect(t('pill.savedTime', 'en', { amount: '2', unit: 'minutes' })).toBe(
      '~2 minutes saved',
    );
    expect(t('time.unit.hourOne', 'en')).toBe('hour');
    expect(t('time.unit.hourMany', 'en')).toBe('hours');
    expect(t('time.unit.minuteOne', 'en')).toBe('minute');
    expect(t('time.unit.minuteMany', 'en')).toBe('minutes');
    expect(t('time.unit.secondOne', 'en')).toBe('second');
    expect(t('time.unit.secondMany', 'en')).toBe('seconds');
  });

  it('holds the spec copy in Russian', () => {
    expect(t('options.timeSavedHeadline', 'ru', { amount: '9', unit: 'часов' })).toBe(
      '≈ 9 часов сэкономлено (оценка)',
    );
    expect(t('options.timeSavedStarted', 'ru')).toBe('Учёт сэкономленного времени начат');
    expect(t('pill.savedTime', 'ru', { amount: '2', unit: 'минуты' })).toBe(
      '~2 минуты сэкономлено',
    );
    expect(t('time.unit.hourOne', 'ru')).toBe('час');
    expect(t('time.unit.hourFew', 'ru')).toBe('часа');
    expect(t('time.unit.hourMany', 'ru')).toBe('часов');
    expect(t('time.unit.minuteOne', 'ru')).toBe('минута');
    expect(t('time.unit.minuteFew', 'ru')).toBe('минуты');
    expect(t('time.unit.minuteMany', 'ru')).toBe('минут');
    expect(t('time.unit.secondOne', 'ru')).toBe('секунда');
    expect(t('time.unit.secondFew', 'ru')).toBe('секунды');
    expect(t('time.unit.secondMany', 'ru')).toBe('секунд');
  });

  it('formatTimeSaved: golden values in both locales', () => {
    expect(formatTimeSaved(33732, 'en')).toEqual({ amount: '9', unit: 'hours' });
    expect(formatTimeSaved(90, 'en')).toEqual({ amount: '2', unit: 'minutes' });
    expect(formatTimeSaved(0.6, 'en')).toEqual({ amount: '0.6', unit: 'seconds' });
    expect(formatTimeSaved(33732, 'ru')).toEqual({ amount: '9', unit: 'часов' });
    expect(formatTimeSaved(90, 'ru')).toEqual({ amount: '2', unit: 'минуты' });
    expect(formatTimeSaved(0.6, 'ru')).toEqual({ amount: '0,6', unit: 'секунд' });
  });

  it('timeUnit plural selection per locale', () => {
    expect(timeUnit('minute', 1, 'en')).toBe('minute');
    expect(timeUnit('minute', 1.5, 'en')).toBe('minutes');
    expect(timeUnit('minute', 1, 'ru')).toBe('минута');
    expect(timeUnit('minute', 2, 'ru')).toBe('минуты');
    expect(timeUnit('minute', 5, 'ru')).toBe('минут');
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
