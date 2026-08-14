// GM storage shim: the two-key userscript storage (target + channel memory)
// behind the lib's chrome.storage-shaped StorageLike contract, so
// ChannelMemory (lib/channel-memory.ts) runs unchanged.

import { CHANNEL_MEMORY_STORAGE_KEY, ChannelMemory } from '../../lib/channel-memory';
import type { StorageLike } from '../../lib/settings';

const TARGET_GM_KEY = 'speedwatcher.target';
const CHANNEL_RATES_GM_KEY = 'speedwatcher.channelRates';

/** Maps the lib's chrome.storage keys onto the GM keys. */
const GM_KEY_BY_STORAGE_KEY: Record<string, string> = {
  [CHANNEL_MEMORY_STORAGE_KEY]: CHANNEL_RATES_GM_KEY,
};

declare function GM_getValue(key: string): unknown;
declare function GM_setValue(key: string, value: unknown): unknown;

function gmGet(key: string): unknown {
  if (typeof GM_getValue === 'undefined') return undefined;
  try {
    return GM_getValue(key);
  } catch {
    return undefined;
  }
}

function gmSet(key: string, value: unknown): void {
  if (typeof GM_setValue === 'undefined') return;
  try {
    // Greasemonkey 4's GM_setValue is async and rejects before the document
    // is ready; a failed write must never block measurement.
    const result: unknown = GM_setValue(key, value);
    if (result instanceof Promise) void result.catch(() => undefined);
  } catch {
    // Storage dead — measure without memory.
  }
}

const gmStorage: StorageLike = {
  async get(key) {
    // chrome.storage's null = whole-store get; the shim keeps no whole-store view.
    if (key === null) return {};
    const raw = gmGet(GM_KEY_BY_STORAGE_KEY[key] ?? key);
    return raw === undefined || raw === null ? {} : { [key]: raw };
  },
  async set(items) {
    for (const [key, value] of Object.entries(items)) {
      gmSet(GM_KEY_BY_STORAGE_KEY[key] ?? key, value);
    }
  },
};

/** Channel memory over GM storage; corrupt records are dropped on read
 * (ChannelMemory's normalize-on-read). */
export const channelMemory = new ChannelMemory(gmStorage);

/** The stored explicit target; undefined when unset. */
export function readTarget(): number | undefined {
  const raw = gmGet(TARGET_GM_KEY);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** Persist the target; undefined clears it (null tombstone — GM cannot store
 * undefined). */
export function writeTarget(target: number | undefined): void {
  gmSet(TARGET_GM_KEY, target ?? null);
}
