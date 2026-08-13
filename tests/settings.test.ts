import { describe, expect, it } from 'vitest';
import type { ContentTypePrefs, Settings, SiteOverride } from '../lib/settings';
import {
  CONSERVATIVE_TARGET_WPM,
  DEFAULT_PLATFORM_MAX,
  DEFAULT_TARGET_WPM,
  PLATFORM_MAX_MAX,
  PLATFORM_MAX_MIN,
  SettingsStore,
  defaultSettings,
  resolveContentType,
  resolveMultiplierOverride,
  resolvePlatformMax,
  resolveTarget,
  resolveUserTarget,
} from '../lib/settings';
import { mockStorage } from './fixtures/helpers';

describe('settings resolution', () => {
  it('distinguishes an unset target from an explicit one', () => {
    const settings = defaultSettings();
    expect(resolveTarget(settings)).toBeUndefined();
    expect(resolveUserTarget(settings)).toBeUndefined();
    expect(resolvePlatformMax(settings)).toBe(DEFAULT_PLATFORM_MAX);
    expect(resolveUserTarget({ ...settings, target: DEFAULT_TARGET_WPM })).toBe(DEFAULT_TARGET_WPM);
  });

  it('uses 225 as the conservative default target', () => {
    const settings = { ...defaultSettings(), conservative: true };
    expect(resolveUserTarget(settings)).toBe(CONSERVATIVE_TARGET_WPM);
  });

  it('prefers site, then content-type, then profile targets', () => {
    const siteOverride: SiteOverride = { target: 240 };
    const lecturePrefs: ContentTypePrefs = { target: 235 };
    const settings: Settings = {
      ...defaultSettings(),
      target: 260,
      sites: { 'youtube.com': siteOverride },
      contentTypes: { lecture: lecturePrefs },
    };
    expect(resolveTarget(settings, 'youtube.com', 'lecture')).toBe(240);
    expect(resolveTarget(settings, undefined, 'lecture')).toBe(235);
    expect(resolveTarget(settings)).toBe(260);
  });

  it('resolves per-site content type, multiplier override, and platform max', () => {
    const settings: Settings = {
      ...defaultSettings(),
      sites: {
        'youtube.com': { contentType: 'talk', multiplierOverride: 1.3, platformMax: 1.75 },
      },
    };
    expect(resolveContentType(settings, 'youtube.com', 'lecture')).toBe('talk');
    expect(resolveContentType(settings, 'other.com', 'lecture')).toBe('lecture');
    expect(resolveMultiplierOverride(settings, 'youtube.com')).toBe(1.3);
    expect(resolveMultiplierOverride(settings, 'other.com')).toBeUndefined();
    expect(resolvePlatformMax(settings, 'youtube.com')).toBe(1.75);
    expect(resolvePlatformMax(settings, 'other.com')).toBe(DEFAULT_PLATFORM_MAX);
  });

  it('falls back from site to global content type, then detected', () => {
    const settings: Settings = { ...defaultSettings(), contentType: 'podcast' };
    expect(resolveContentType(settings, 'youtube.com', 'generic')).toBe('podcast');
    expect(resolveContentType(settings, 'youtube.com', 'music')).toBe('podcast');
    const withSite = { ...settings, sites: { 'youtube.com': { contentType: 'talk' as const } } };
    expect(resolveContentType(withSite, 'youtube.com', 'music')).toBe('talk');
  });
});

describe('SettingsStore', () => {
  it('round-trips settings through storage', async () => {
    const store = new SettingsStore(mockStorage());
    const settings = {
      ...defaultSettings(),
      conservative: true,
      contentType: 'music' as const,
      sites: { 'youtube.com': { target: 240 } },
    };
    await store.save(settings);
    expect(await store.load()).toEqual(settings);
  });

  it('normalizes malformed storage back to defaults', async () => {
    const store = new SettingsStore(
      mockStorage({ 'sw.settings': { conservative: true, platformMax: 'oops' } }),
    );
    const loaded = await store.load();
    expect(loaded.conservative).toBe(true);
    expect(loaded.platformMax).toBe(DEFAULT_PLATFORM_MAX);
    expect(loaded.sites).toEqual({});
    expect(await new SettingsStore(mockStorage()).load()).toEqual(defaultSettings());
  });

  it('clamps out-of-range platformMax into [1, 4] on load', async () => {
    const high = new SettingsStore(
      mockStorage({ 'sw.settings': { conservative: false, platformMax: 10 } }),
    );
    expect((await high.load()).platformMax).toBe(PLATFORM_MAX_MAX);
    const low = new SettingsStore(
      mockStorage({ 'sw.settings': { conservative: false, platformMax: 0.5 } }),
    );
    expect((await low.load()).platformMax).toBe(PLATFORM_MAX_MIN);
  });

  it('round-trips the uiLanguage setting and drops invalid values', async () => {
    const store = new SettingsStore(mockStorage({ 'sw.settings': { uiLanguage: 'ru' } }));
    expect((await store.load()).uiLanguage).toBe('ru');
    const invalid = new SettingsStore(mockStorage({ 'sw.settings': { uiLanguage: 'de' } }));
    expect((await invalid.load()).uiLanguage).toBeUndefined();
    const auto = new SettingsStore(mockStorage({ 'sw.settings': { uiLanguage: 'auto' } }));
    expect((await auto.load()).uiLanguage).toBe('auto');
  });

  it('update mutates and persists', async () => {
    const store = new SettingsStore(mockStorage());
    await store.update((settings) => ({ ...settings, target: 240 }));
    expect((await store.load()).target).toBe(240);
  });
});
