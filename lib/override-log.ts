import type { ContentType } from './music';
import type { RecommendationMode } from './recommend';
import type { StorageLike } from './settings';

export const OVERRIDE_LOG_LIMIT = 500;

export interface OverrideLogEntry {
  ts: number;
  videoId?: string;
  site: string;
  contentType: ContentType;
  naturalRate: number;
  multiplier: number;
  mode: RecommendationMode;
  userAction: 'apply' | 'dismiss' | 'adjust';
  /** Set when the user adjusted the recommended multiplier. */
  finalMultiplier?: number;
}

export interface ContentTypeStats {
  count: number;
  avgMultiplier: number | null;
}

export interface OverrideReport {
  total: number;
  byContentType: Partial<Record<ContentType, ContentTypeStats>>;
}

/**
 * Append-only user-action log (report-only; no learning). Entries are
 * trimmed to the newest OVERRIDE_LOG_LIMIT on every append.
 */
export class OverrideLog {
  constructor(
    private readonly storage: StorageLike,
    private readonly key = 'sw.overrideLog',
  ) {}

  async append(entry: Omit<OverrideLogEntry, 'ts'>): Promise<void> {
    const entries = await this.entries();
    entries.push({ ts: Date.now(), ...entry });
    await this.storage.set({ [this.key]: entries.slice(-OVERRIDE_LOG_LIMIT) });
  }

  async entries(): Promise<OverrideLogEntry[]> {
    const raw = await this.storage.get(this.key);
    const value = raw[this.key];
    return Array.isArray(value) ? (value as OverrideLogEntry[]) : [];
  }

  /** Counts per content type and the average multiplier users applied. */
  async report(): Promise<OverrideReport> {
    const entries = await this.entries();
    interface Accumulator extends ContentTypeStats {
      applied: number[];
    }
    const acc = new Map<ContentType, Accumulator>();
    for (const entry of entries) {
      const stats = acc.get(entry.contentType) ?? { count: 0, avgMultiplier: null, applied: [] };
      stats.count += 1;
      if (entry.userAction === 'apply') stats.applied.push(entry.multiplier);
      acc.set(entry.contentType, stats);
    }
    const byContentType: OverrideReport['byContentType'] = {};
    for (const [contentType, stats] of acc) {
      const applied = stats.applied;
      byContentType[contentType] = {
        count: stats.count,
        avgMultiplier: applied.length === 0 ? null : applied.reduce((a, b) => a + b, 0) / applied.length,
      };
    }
    return { total: entries.length, byContentType };
  }
}
