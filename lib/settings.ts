import type { ContentType } from './music';

export const DEFAULT_TARGET_WPM = 250;
export const CONSERVATIVE_TARGET_WPM = 225;
export const DEFAULT_PLATFORM_MAX = 2;

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
  /** Explicit profile target; falls back to conservative ? 225 : 250. */
  target?: number;
  /** Conservative mode: default target 225 instead of 250. */
  conservative: boolean;
  platformMax: number;
  /** Keyed by hostname, e.g. 'youtube.com'. */
  sites: Record<string, SiteOverride>;
  contentTypes: Partial<Record<ContentType, ContentTypePrefs>>;
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

function normalizeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!isRecord(raw)) return base;
  const settings: Settings = {
    conservative: raw.conservative === true,
    platformMax: finiteOr(raw.platformMax, base.platformMax),
    sites: isRecord(raw.sites) ? (raw.sites as Record<string, SiteOverride>) : {},
    contentTypes: isRecord(raw.contentTypes)
      ? (raw.contentTypes as Partial<Record<ContentType, ContentTypePrefs>>)
      : {},
  };
  const target = finiteOr(raw.target, undefined);
  if (target !== undefined) settings.target = target;
  return settings;
}

export function resolveTarget(
  settings: Settings,
  site?: string,
  contentType?: ContentType,
): number {
  const siteOverride = site === undefined ? undefined : settings.sites[site];
  if (siteOverride?.target !== undefined) return siteOverride.target;
  const ctPrefs = contentType === undefined ? undefined : settings.contentTypes[contentType];
  if (ctPrefs?.target !== undefined) return ctPrefs.target;
  return settings.target ?? (settings.conservative ? CONSERVATIVE_TARGET_WPM : DEFAULT_TARGET_WPM);
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
  return settings.sites[site]?.contentType ?? detected;
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
    private readonly key = 'sw.settings',
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
