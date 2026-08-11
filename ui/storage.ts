// Thin chrome.storage.local wrapper. Read/write JSON blobs by key.
// UI-adjacent — consumed by options page and pill host.

import { browser } from 'wxt/browser';

const STORAGE_PREFIX = 'sw:';

export interface StorageKey<T> {
  key: string;
  fallback: T;
}

/** Define a typed storage key with a default value. */
export function defineKey<T>(key: string, fallback: T): StorageKey<T> {
  return { key: `${STORAGE_PREFIX}${key}`, fallback };
}

/** Read a value from storage. Returns the fallback if missing or corrupted. */
export async function read<T>(storageKey: StorageKey<T>): Promise<T> {
  try {
    const result = await browser.storage.local.get(storageKey.key);
    const raw = result[storageKey.key];
    if (raw === undefined || raw === null) return storageKey.fallback;
    return raw as T;
  } catch {
    return storageKey.fallback;
  }
}

/** Write a value to storage. */
export async function write<T>(storageKey: StorageKey<T>, value: T): Promise<void> {
  try {
    await browser.storage.local.set({ [storageKey.key]: value });
  } catch {
    // Storage quota exceeded or other error — silent fail, UI already shows current state.
  }
}

// ── Predefined keys ──────────────────────────────────────────────────────

export const KEY_TARGET_WPM = defineKey<number>('targetWpm', 250);

export type ContentType = 'lecture' | 'talk' | 'podcast' | 'music' | 'generic';
export const KEY_CONTENT_TYPE = defineKey<ContentType>('contentType', 'generic');

export interface SiteOverride {
  hostname: string;
  contentType: ContentType;
  addedAt: number;
}
export const KEY_SITE_OVERRIDES = defineKey<SiteOverride[]>('siteOverrides', []);

export interface HabitEntry {
  contentType: ContentType;
  multiplier: number;
  timestamp: number;
}
export const KEY_HABITS = defineKey<HabitEntry[]>('habits', []);
