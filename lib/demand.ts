// Demand proxy for the Phase-2 STT gate: counts pill renders that fell back
// to the 'estimated' heuristic tier (no captions found), per content type.
// Local-only by construction — the record lives in chrome.storage.local and
// no code path in this module touches the network. Key 'sw.demand' joins
// the namespace declared in lib/settings.ts.
//
// Gate (lib-9): trip when >=RENDER_THRESHOLD speech-eligible estimated
// renders have accumulated across >=DAYS_THRESHOLD distinct render days, or
// >=ELAPSED_CAP_DAYS elapsed since firstSeenTs — whichever first. A trip is
// a flag for review only (options page); nothing auto-starts. Music is
// excluded from speech-eligible counting (captionless music has no speech),
// but stays in byContentType for the raw breakdown.

import type { ContentType } from './music';
import { isContentType } from './music';
import type { StorageLike } from './settings';

export const DEMAND_STORAGE_KEY = 'sw.demand';

/** SEC-4: the proxy saturates at this total count. The gate trips at 40
 * renders / 3 days / 42 days — far below — so the cap only bounds storage
 * and stops the per-increment write at saturation. */
export const MAX_ESTIMATED_COUNT = 10_000;

/** Types whose estimated renders indicate transcribable speech (lib-9). */
export const SPEECH_ELIGIBLE_TYPES: readonly ContentType[] = [
  'talk',
  'lecture',
  'explainer',
  'news',
  'podcast',
  'generic',
];

/** Speech-eligible renders that, spread across DAYS_THRESHOLD days, trip the gate. */
export const RENDER_THRESHOLD = 40;
/** Distinct render-days the speech-eligible count must be spread across. */
export const DAYS_THRESHOLD = 3;
/** Days after firstSeenTs that trip the review-and-close cap regardless of renders. */
export const ELAPSED_CAP_DAYS = 42;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DemandRecord {
  estimatedCount: number;
  /** Only known ContentType keys survive normalization. */
  byContentType: Partial<Record<ContentType, number>>;
  /** Timestamp of the first counted render; absent before any increment. */
  firstSeenTs?: number;
  lastSeenTs?: number;
  /** Distinct local dates with >=1 speech-eligible increment; absent while zero. */
  renderDays?: number;
  /** Local date (YYYY-MM-DD) of the last speech-eligible increment. */
  lastRenderDate?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Counts with unknown or corrupt content-type keys are dropped; values are
 * clamped to MAX_ESTIMATED_COUNT so the cap is a record invariant. */
function normalizeByType(raw: unknown): DemandRecord['byContentType'] {
  if (!isRecord(raw)) return {};
  const byType: DemandRecord['byContentType'] = {};
  for (const [type, count] of Object.entries(raw)) {
    if (!isContentType(type)) continue;
    const value = Math.min(nonNegativeInt(count), MAX_ESTIMATED_COUNT);
    if (value > 0) byType[type] = value;
  }
  return byType;
}

function normalizeDemand(raw: unknown): DemandRecord {
  if (!isRecord(raw)) return { estimatedCount: 0, byContentType: {} };
  const renderDays = nonNegativeInt(raw.renderDays);
  return {
    estimatedCount: Math.min(nonNegativeInt(raw.estimatedCount), MAX_ESTIMATED_COUNT),
    byContentType: normalizeByType(raw.byContentType),
    ...(typeof raw.firstSeenTs === 'number' && Number.isFinite(raw.firstSeenTs)
      ? { firstSeenTs: raw.firstSeenTs }
      : {}),
    ...(typeof raw.lastSeenTs === 'number' && Number.isFinite(raw.lastSeenTs)
      ? { lastSeenTs: raw.lastSeenTs }
      : {}),
    ...(renderDays > 0 ? { renderDays } : {}),
    ...(typeof raw.lastRenderDate === 'string' && LOCAL_DATE_RE.test(raw.lastRenderDate)
      ? { lastRenderDate: raw.lastRenderDate }
      : {}),
  };
}

/** Local calendar date of `now` as YYYY-MM-DD (distinct-render-days key). */
function localDate(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Serialized read-modify-write: increments queue on a promise chain so
 * concurrent calls cannot lose updates (chrome.storage.local has no atomic
 * increment). Single writer by construction (lib-11#3): the background owns
 * the only instance (entrypoints/background.ts) and every frame's bridge
 * forwards demand:increment to it, so the per-instance chain covers all
 * frames — per-frame stores could interleave their get→set pairs and drop
 * increments.
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
    // SEC-4: at the cap further increments are no-ops — the record stays
    // stable and no storage write happens (write-amplification bound).
    if (current.estimatedCount >= MAX_ESTIMATED_COUNT) return current;
    const date = localDate(now);
    const speechEligible = SPEECH_ELIGIBLE_TYPES.includes(contentType);
    const renderDays =
      !speechEligible || current.lastRenderDate === date
        ? current.renderDays
        : (current.renderDays ?? 0) + 1;
    const next: DemandRecord = {
      estimatedCount: current.estimatedCount + 1,
      byContentType: {
        ...current.byContentType,
        [contentType]: (current.byContentType[contentType] ?? 0) + 1,
      },
      firstSeenTs: current.firstSeenTs ?? now,
      lastSeenTs: now,
      ...(renderDays !== undefined ? { renderDays } : {}),
      ...(speechEligible || current.lastRenderDate !== undefined
        ? { lastRenderDate: speechEligible ? date : current.lastRenderDate }
        : {}),
    };
    await this.storage.set({ [this.key]: next });
    return next;
  }

  async get(): Promise<DemandRecord> {
    const raw = await this.storage.get(this.key);
    return normalizeDemand(raw[this.key]);
  }
}

export type DemandGateReason = 'renders' | 'days' | 'elapsed';

export interface DemandGateState {
  tripped: boolean;
  /**
   * Trip cause: 'renders' = adoption compound (count across days met),
   * 'elapsed' = review-and-close cap, null = not tripped. 'days' is part
   * of the display contract but the current rule never produces it.
   */
  reason: DemandGateReason | null;
  /** Sum of byContentType over SPEECH_ELIGIBLE_TYPES. */
  speechEligibleCount: number;
  renderDays: number;
  /** Whole days since firstSeenTs; null before the first increment. */
  elapsedDays: number | null;
}

/**
 * Pure gate evaluation (lib-9): the adoption trip needs both the render
 * threshold and the distinct-day spread (a single-day binge cannot trip);
 * the elapsed cap trips on its own. `now` is injected so tests pin dates.
 */
export function computeDemandGate(record: DemandRecord, now: number): DemandGateState {
  const speechEligibleCount = SPEECH_ELIGIBLE_TYPES.reduce(
    (sum, type) => sum + (record.byContentType[type] ?? 0),
    0,
  );
  const renderDays = record.renderDays ?? 0;
  const elapsedDays =
    record.firstSeenTs === undefined
      ? null
      : Math.max(0, Math.floor((now - record.firstSeenTs) / DAY_MS));
  const adoptionMet = speechEligibleCount >= RENDER_THRESHOLD && renderDays >= DAYS_THRESHOLD;
  const elapsedMet = elapsedDays !== null && elapsedDays >= ELAPSED_CAP_DAYS;
  const reason: DemandGateReason | null = adoptionMet ? 'renders' : elapsedMet ? 'elapsed' : null;
  return { tripped: reason !== null, reason, speechEligibleCount, renderDays, elapsedDays };
}
