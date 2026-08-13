// Storage namespace: chrome.storage.local holds exactly three keys, all
// prefixed 'sw.' and owned by their lib module — 'sw.settings' (this file,
// via SettingsStore), 'sw.overrideLog' (lib/override-log.ts), and 'sw.demand'
// (lib/demand.ts, the local STT demand proxy). The options page, the
// isolated-world bridge, and the background all read/write through the lib
// stores over browser.storage.local; ui/storage.ts's parallel 'sw:' schema
// is retired. No other key may be introduced.

import type { ContentType } from './music';

export const SETTINGS_STORAGE_KEY = 'sw.settings';
export const DEFAULT_TARGET_WPM = 250;
export const CONSERVATIVE_TARGET_WPM = 225;
export const DEFAULT_PLATFORM_MAX = 2;

// Bridge-accepted bounds: the pill recommends up to platformMax× and targets
// near the 250–275 wpm safe zone, so values outside these ranges are forgery.
export const TARGET_WPM_MIN = 100;
export const TARGET_WPM_MAX = 400;
export const PLATFORM_MAX_MIN = 1;
export const PLATFORM_MAX_MAX = 4;

/** UI-language preference: 'auto' follows the browser UI language. */
export type UiLanguageSetting = 'auto' | 'ru' | 'en';

export function isUiLanguageSetting(value: unknown): value is UiLanguageSetting {
  return value === 'auto' || value === 'ru' || value === 'en';
}

export interface SiteOverride {
  target?: number;
  contentType?: ContentType;
  multiplierOverride?: number;
  platformMax?: number;
}

export interface ContentTypePrefs {
  target?: number;
}

export interface Settings {
  /** Explicit profile target; unset → the language model's own target
   * (conservative mode lowers the default to 225). */
  target?: number;
  /** Conservative mode: default target 225 instead of 250. */
  conservative: boolean;
  platformMax: number;
  /** Global content-type default; unset means auto-detect. */
  contentType?: ContentType;
  /** Keyed by hostname, e.g. 'youtube.com'. */
  sites: Record<string, SiteOverride>;
  contentTypes: Partial<Record<ContentType, ContentTypePrefs>>;
  /** UI-language preference; unset/'auto' → navigator.language. */
  uiLanguage?: UiLanguageSetting;
}

/** Injectable chrome.storage.local stand-in for unit tests. */
export interface StorageLike {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function defaultSettings(): Settings {
  return {
    conservative: false,
    platformMax: DEFAULT_PLATFORM_MAX,
    sites: {},
    contentTypes: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!isRecord(raw)) return base;
  const settings: Settings = {
    conservative: raw.conservative === true,
    platformMax: clamp(finiteOr(raw.platformMax, base.platformMax), PLATFORM_MAX_MIN, PLATFORM_MAX_MAX),
    sites: isRecord(raw.sites) ? (raw.sites as Record<string, SiteOverride>) : {},
    contentTypes: isRecord(raw.contentTypes)
      ? (raw.contentTypes as Partial<Record<ContentType, ContentTypePrefs>>)
      : {},
  };
  const target = finiteOr(raw.target, undefined);
  if (target !== undefined) settings.target = target;
  if (typeof raw.contentType === 'string') settings.contentType = raw.contentType as ContentType;
  if (isUiLanguageSetting(raw.uiLanguage)) settings.uiLanguage = raw.uiLanguage;
  return settings;
}

/**
 * The explicitly configured target — site override, then content-type
 * preference, then the profile target — or undefined when none is set.
 * Defaults (the language-model target, conservative 225) are the caller's
 * job; resolveUserTarget applies them.
 */
export function resolveTarget(
  settings: Settings,
  site?: string,
  contentType?: ContentType,
): number | undefined {
  const siteOverride = site === undefined ? undefined : settings.sites[site];
  if (siteOverride?.target !== undefined) return siteOverride.target;
  const ctPrefs = contentType === undefined ? undefined : settings.contentTypes[contentType];
  if (ctPrefs?.target !== undefined) return ctPrefs.target;
  return settings.target;
}

/**
 * The target content scripts pass to recommend(): the explicit target,
 * else the conservative 225 default, else undefined — which leaves the
 * language model's own target in charge (en 250 wpm, derived estimates
 * for every other language).
 */
export function resolveUserTarget(
  settings: Settings,
  site?: string,
  contentType?: ContentType,
): number | undefined {
  return (
    resolveTarget(settings, site, contentType) ??
    (settings.conservative ? CONSERVATIVE_TARGET_WPM : undefined)
  );
}

export function resolvePlatformMax(settings: Settings, site?: string): number {
  const siteOverride = site === undefined ? undefined : settings.sites[site];
  return siteOverride?.platformMax ?? settings.platformMax;
}

export function resolveContentType(
  settings: Settings,
  site: string,
  detected: ContentType,
): ContentType {
  return settings.sites[site]?.contentType ?? settings.contentType ?? detected;
}

export function resolveMultiplierOverride(
  settings: Settings,
  site: string,
): number | undefined {
  return settings.sites[site]?.multiplierOverride;
}

export class SettingsStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly key = SETTINGS_STORAGE_KEY,
  ) {}

  async load(): Promise<Settings> {
    const raw = await this.storage.get(this.key);
    return normalizeSettings(raw[this.key]);
  }

  async save(settings: Settings): Promise<void> {
    await this.storage.set({ [this.key]: settings });
  }

  async update(mutate: (settings: Settings) => Settings): Promise<Settings> {
    const next = mutate(await this.load());
    await this.save(next);
    return next;
  }
}
