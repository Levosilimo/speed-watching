// Per-channel measured-rate memory (roadmap item: a channel's last measured
// rate seeds its captionless videos' estimated tier). Key 'sw.channelRates'
// joins the storage namespace declared in lib/settings.ts — one flat record
// per channel, bounded to CHANNEL_MEMORY_MAX entries with least-recently-
// written eviction (every put stamps a fresh ts, so write order is use
// order). The bridge answers channel:get/put straight from
// chrome.storage.local like settings (lib/messaging.ts). YouTube-only for
// now — entrypoints/generic.content.ts never touches this store.

import type { StorageLike } from './settings';

export const CHANNEL_MEMORY_STORAGE_KEY = 'sw.channelRates';
/** LRU bound: 50 channels is far beyond a working watch rotation; the cap
 * keeps the flat record readable and the storage write small. */
export const CHANNEL_MEMORY_MAX = 50;
/** channelKey length cap (bridge boundary): keys are channelIds (~24
 * chars) or author names, never hundreds of characters. */
export const CHANNEL_KEY_MAX_LENGTH = 200;

export interface ChannelRecord {
  /** Last measured presentation rate, in `unit`. */
  rate: number;
  /** Rate-unit label ('wpm' | 'cpm' | 'syl/min' | 'morae/min'). */
  unit: string;
  /** Language code the rate was measured in; '?' when unresolvable. */
  language: string;
  /** Last-measured epoch millis; LRU eviction rank. */
  ts: number;
}

// Forgery bounds mirror lib/bridge-protocol.ts's SEC-3 log-entry bounds: no
// speech track runs above 1000 wpm and every measured rate is positive.
const RATE_MIN = 1;
const RATE_MAX = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Runtime shape check for a stored channel record; corrupt entries are
 * dropped on read (normalize-on-read), never returned, never counted in
 * the LRU bound. */
export function isChannelRecord(value: unknown): value is ChannelRecord {
  if (!isRecord(value)) return false;
  if (typeof value.rate !== 'number' || !Number.isFinite(value.rate)) return false;
  if (value.rate < RATE_MIN || value.rate > RATE_MAX) return false;
  if (typeof value.unit !== 'string' || value.unit.length === 0) return false;
  if (typeof value.language !== 'string' || value.language.length === 0) return false;
  return typeof value.ts === 'number' && Number.isFinite(value.ts);
}

export class ChannelMemory {
  constructor(private readonly storage: StorageLike) {}

  /** The channel's last measured record, or null when unknown or corrupt. */
  async get(channelKey: string): Promise<ChannelRecord | null> {
    const raw = await this.storage.get(CHANNEL_MEMORY_STORAGE_KEY);
    const data = raw[CHANNEL_MEMORY_STORAGE_KEY];
    if (!isRecord(data)) return null;
    const record = data[channelKey];
    return isChannelRecord(record) ? record : null;
  }

  /** Store a measured rate for the channel, evicting the least-recently-
   * written entry when the bound is exceeded. */
  async put(channelKey: string, record: ChannelRecord): Promise<void> {
    const current = await this.load();
    current[channelKey] = record;
    const keys = Object.keys(current);
    if (keys.length > CHANNEL_MEMORY_MAX) {
      const oldest = keys.reduce((a, b) => (current[a]!.ts <= current[b]!.ts ? a : b));
      delete current[oldest];
    }
    await this.storage.set({ [CHANNEL_MEMORY_STORAGE_KEY]: current });
  }

  /** Normalized snapshot: corrupt entries dropped. put reads through this
   * so eviction and writes always see the clean record set. */
  async load(): Promise<Record<string, ChannelRecord>> {
    const raw = await this.storage.get(CHANNEL_MEMORY_STORAGE_KEY);
    const data = raw[CHANNEL_MEMORY_STORAGE_KEY];
    if (!isRecord(data)) return {};
    const clean: Record<string, ChannelRecord> = {};
    for (const [key, value] of Object.entries(data)) {
      if (isChannelRecord(value)) clean[key] = value;
    }
    return clean;
  }
}
