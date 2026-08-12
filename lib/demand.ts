// Demand proxy for the Phase-2 STT gate: counts pill renders that fell back
// to the 'estimated' heuristic tier (no captions found), per content type.
// Local-only by construction — the record lives in chrome.storage.local and
// no code path in this module touches the network. Key 'sw.demand' joins
// the namespace declared in lib/settings.ts.

import type { ContentType } from './music';
import { isContentType } from './music';
import type { StorageLike } from './settings';

export const DEMAND_STORAGE_KEY = 'sw.demand';

export interface DemandRecord {
  estimatedCount: number;
  /** Only known ContentType keys survive normalization. */
  byContentType: Partial<Record<ContentType, number>>;
  /** Timestamp of the first counted render; absent before any increment. */
  firstSeenTs?: number;
  lastSeenTs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Counts with unknown or corrupt content-type keys are dropped. */
function normalizeByType(raw: unknown): DemandRecord['byContentType'] {
  if (!isRecord(raw)) return {};
  const byType: DemandRecord['byContentType'] = {};
  for (const [type, count] of Object.entries(raw)) {
    if (!isContentType(type)) continue;
    const value = nonNegativeInt(count);
    if (value > 0) byType[type] = value;
  }
  return byType;
}

function normalizeDemand(raw: unknown): DemandRecord {
  if (!isRecord(raw)) return { estimatedCount: 0, byContentType: {} };
  return {
    estimatedCount: nonNegativeInt(raw.estimatedCount),
    byContentType: normalizeByType(raw.byContentType),
    ...(typeof raw.firstSeenTs === 'number' && Number.isFinite(raw.firstSeenTs)
      ? { firstSeenTs: raw.firstSeenTs }
      : {}),
    ...(typeof raw.lastSeenTs === 'number' && Number.isFinite(raw.lastSeenTs)
      ? { lastSeenTs: raw.lastSeenTs }
      : {}),
  };
}

/**
 * Serialized read-modify-write: increments queue on a promise chain so
 * concurrent calls cannot lose updates (chrome.storage.local has no atomic
 * increment). The bridge is the single writer; the options page only reads.
 */
export class DemandStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageLike,
    private readonly key = DEMAND_STORAGE_KEY,
  ) {}

  async increment(contentType: ContentType, now = Date.now()): Promise<DemandRecord> {
    const result = this.tail.then(() => this.incrementNow(contentType, now));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async incrementNow(contentType: ContentType, now: number): Promise<DemandRecord> {
    const current = normalizeDemand((await this.storage.get(this.key))[this.key]);
    const next: DemandRecord = {
      estimatedCount: current.estimatedCount + 1,
      byContentType: {
        ...current.byContentType,
        [contentType]: (current.byContentType[contentType] ?? 0) + 1,
      },
      firstSeenTs: current.firstSeenTs ?? now,
      lastSeenTs: now,
    };
    await this.storage.set({ [this.key]: next });
    return next;
  }

  async get(): Promise<DemandRecord> {
    const raw = await this.storage.get(this.key);
    return normalizeDemand(raw[this.key]);
  }
}
