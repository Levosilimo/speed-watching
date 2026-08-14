import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_TYPES, isAutoContentType, shouldAutoApply } from '../lib/auto-apply';
import { defaultSettings, type Settings } from '../lib/settings';
import type { Recommendation } from '../lib/recommend';
import type { ContentType } from '../lib/music';

function autoSettings(overrides: Partial<Settings['autoApply']> = {}): Settings {
  return { ...defaultSettings(), autoApply: { enabled: true, contentTypes: {}, ...overrides } };
}

function recommend(mode: Recommendation['mode'], multiplier = 1.55): Recommendation {
  return {
    mode,
    multiplier,
    effectiveWpm: 248,
    tierLabel: 'from captions',
    label: '→ 1.55x ≈ 248 wpm',
    reason: null,
  };
}

describe('shouldAutoApply', () => {
  it('is false when the master toggle is off (or absent — strict consent)', () => {
    const settings = { ...defaultSettings(), autoApply: { enabled: false, contentTypes: {} } };
    expect(shouldAutoApply(settings, recommend('recommend'), 'asr-word', 'talk')).toBe(false);
    const migrated = defaultSettings();
    expect(shouldAutoApply(migrated, recommend('recommend'), 'asr-word', 'talk')).toBe(false);
  });

  it('is false for generic, news, and music content types even when enabled', () => {
    const settings = autoSettings();
    for (const type of ['generic', 'news', 'music'] as ContentType[]) {
      expect(shouldAutoApply(settings, recommend('recommend'), 'asr-word', type)).toBe(false);
    }
  });

  it('is false for the estimated tier in recommend mode (priors never auto)', () => {
    expect(shouldAutoApply(autoSettings(), recommend('recommend'), 'estimated', 'talk')).toBe(
      false,
    );
  });

  it('is false for warning modes (above-zone and pause-diluted)', () => {
    const above = recommend('warning', 2);
    above.reason = 'above-zone';
    const diluted = recommend('warning', 2);
    diluted.reason = 'pause-diluted';
    expect(shouldAutoApply(autoSettings(), above, 'asr-word', 'talk')).toBe(false);
    expect(shouldAutoApply(autoSettings(), diluted, 'asr-word', 'talk')).toBe(false);
  });

  it('is false for music and unreachable modes', () => {
    expect(shouldAutoApply(autoSettings(), recommend('music'), 'asr-word', 'talk')).toBe(false);
    expect(shouldAutoApply(autoSettings(), recommend('unreachable'), 'asr-word', 'talk')).toBe(
      false,
    );
  });

  it('is true for the four default content types on measured tiers', () => {
    const settings = autoSettings();
    for (const type of ['talk', 'lecture', 'explainer', 'podcast'] as ContentType[]) {
      for (const tier of ['asr-word', 'asr-cue', 'manual-cue'] as const) {
        expect(shouldAutoApply(settings, recommend('recommend'), tier, type)).toBe(true);
      }
    }
  });
});

describe('isAutoContentType', () => {
  it('falls back to DEFAULT_AUTO_TYPES for an absent key', () => {
    const settings = autoSettings();
    for (const type of DEFAULT_AUTO_TYPES) {
      expect(isAutoContentType(settings, type)).toBe(true);
    }
    expect(isAutoContentType(settings, 'news')).toBe(false);
    expect(isAutoContentType(settings, 'music')).toBe(false);
  });

  it('lets an explicit false win over the default set', () => {
    const settings = autoSettings({ contentTypes: { talk: false } });
    expect(isAutoContentType(settings, 'talk')).toBe(false);
  });

  it('lets an explicit true opt a non-default type in', () => {
    const settings = autoSettings({ contentTypes: { news: true } });
    expect(isAutoContentType(settings, 'news')).toBe(true);
  });
});
