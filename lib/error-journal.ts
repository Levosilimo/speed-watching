// Local error journal: the caption-collapse reasons recorded when the
// estimated tier rendered (the same three points whose copy ships on the
// pill). A bounded ring buffer of the newest ERROR_JOURNAL_LIMIT entries;
// normalize-on-read drops corrupt records the way lib/demand.ts does.
// Local-only by construction: chrome.storage.local, no network path — the
// data_collection_permissions 'none' claim stays true. Key 'sw.errorJournal'
// joins the namespace declared in lib/settings.ts.

import type { CaptionStatus } from '../ui/pill';
import type { StorageLike } from './settings';

export const ERROR_JOURNAL_STORAGE_KEY = 'sw.errorJournal';
/** Ring-buffer bound: the newest entries only, so storage stays a few KB. */
export const ERROR_JOURNAL_LIMIT = 20;

export interface ErrorJournalEntry {
  ts: number;
  reason: CaptionStatus;
  videoId?: string;
}

/** Wire + storage validator for the caption-collapse reason. */
export function isCaptionStatus(value: unknown): value is CaptionStatus {
  return value === 'no-track' || value === 'fetch-failed' || value === 'capture-missed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Corrupt records (wrong shape, non-finite ts, unknown reason, non-string
 * videoId) are dropped; the ring bound holds on read too. */
function normalizeEntry(raw: unknown): ErrorJournalEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) return null;
  if (!isCaptionStatus(raw.reason)) return null;
  if (raw.videoId !== undefined && typeof raw.videoId !== 'string') return null;
  const entry: ErrorJournalEntry = { ts: raw.ts, reason: raw.reason };
  if (typeof raw.videoId === 'string' && raw.videoId !== '') entry.videoId = raw.videoId;
  return entry;
}

/**
 * Bounded ring buffer of caption-collapse records. The background owns the
 * only instance (single writer, lib-11#3) — every bridge frame's
 * journal:append forwards there, so the get→set pairs serialize on one
 * promise chain and concurrent collapses cannot drop entries.
 */
export class ErrorJournal {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageLike,
    private readonly key = ERROR_JOURNAL_STORAGE_KEY,
  ) {}

  append(entry: Omit<ErrorJournalEntry, 'ts'>, now = Date.now()): Promise<void> {
    const result = this.tail.then(() => this.appendNow(entry, now));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async appendNow(entry: Omit<ErrorJournalEntry, 'ts'>, now: number): Promise<void> {
    const entries = await this.entries();
    entries.push({ ts: now, ...entry });
    await this.storage.set({ [this.key]: entries.slice(-ERROR_JOURNAL_LIMIT) });
  }

  async entries(): Promise<ErrorJournalEntry[]> {
    const raw = await this.storage.get(this.key);
    if (!Array.isArray(raw[this.key])) return [];
    return (raw[this.key] as unknown[]).flatMap((entry) => {
      const normalized = normalizeEntry(entry);
      return normalized === null ? [] : [normalized];
    }).slice(-ERROR_JOURNAL_LIMIT);
  }

  async clear(): Promise<void> {
    await this.storage.set({ [this.key]: [] });
  }
}
