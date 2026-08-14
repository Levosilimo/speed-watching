// Metacognitive recall nudge: after NUDGE_APPLIES_BEFORE_SHOW applies at
// >= NUDGE_MULTIPLIER_MIN, the store flags a show and the content script
// renders the separate nudge overlay (ui/nudge.ts) — never the pill.
// Local-only by construction — the record lives in chrome.storage.local and
// no code path in this module touches the network. Key 'sw.nudge' joins the
// namespace declared in lib/settings.ts.
//
// Signal: applied count at >=1.5x (via applyMultiplier). Not time-at-rate,
// not content-type-gated; music never reaches apply, so the signal is
// speech-only in practice. Global across tabs by construction: the
// background owns the only instance (entrypoints/background.ts) and every
// frame's bridge forwards nudge:recordApply to it, so the per-instance
// promise chain covers all frames (lib-11#3, same shape as DemandStore).
//
// Honest limits (lib-16): the 3-apply / 7-day thresholds are engineering
// defaults, not calibrated; the copy's single-study claim (Keehr 2025) is
// hedged in the i18n strings.

import type { StorageLike } from './settings';

export const NUDGE_STORAGE_KEY = 'sw.nudge';
/** Applies at or above this multiplier count toward the nudge. */
export const NUDGE_MULTIPLIER_MIN = 1.5;
/** High-speed applies that accumulate before a show; a show resets the count. */
export const NUDGE_APPLIES_BEFORE_SHOW = 3;
/** Minimum gap between shows, so a returning user is not re-nudged weekly. */
export const NUDGE_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** 'Got it' suppression: the nudge stays away for a week after dismissal. */
export const NUDGE_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export interface NudgeRecord {
  /** Applies at >= NUDGE_MULTIPLIER_MIN since the last show or dismiss. */
  highApplied: number;
  /** Last show timestamp; absent before the first show. */
  lastShownTs?: number;
  /** Cooldown end after a 'Got it' dismiss; absent when never dismissed. */
  dismissedUntil?: number;
  /** 'Don't show again': permanent suppression. */
  dismissedForever?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finiteTs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Corrupt or absent storage falls back to a fresh record; invalid fields
 * are dropped rather than trusted. */
function normalizeNudge(raw: unknown): NudgeRecord {
  if (!isRecord(raw)) return { highApplied: 0 };
  const lastShownTs = finiteTs(raw.lastShownTs);
  const dismissedUntil = finiteTs(raw.dismissedUntil);
  return {
    highApplied: nonNegativeInt(raw.highApplied),
    ...(lastShownTs !== undefined ? { lastShownTs } : {}),
    ...(dismissedUntil !== undefined ? { dismissedUntil } : {}),
    ...(raw.dismissedForever === true ? { dismissedForever: true } : {}),
  };
}

/** `now` is injected so tests pin dates. */
export function shouldShowNudge(record: NudgeRecord, now: number): boolean {
  if (record.dismissedForever === true) return false;
  if (record.dismissedUntil !== undefined && record.dismissedUntil > now) return false;
  if (record.lastShownTs !== undefined && now - record.lastShownTs < NUDGE_MIN_INTERVAL_MS) {
    return false;
  }
  return record.highApplied >= NUDGE_APPLIES_BEFORE_SHOW;
}

/**
 * Serialized read-modify-write: recordApply and dismiss queue on a promise
 * chain so concurrent calls cannot lose updates (chrome.storage.local has
 * no atomic increment). Single writer by construction (lib-11#3): the
 * background owns the only instance and every frame's bridge forwards
 * nudge messages to it.
 */
export class NudgeStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageLike,
    private readonly key = NUDGE_STORAGE_KEY,
  ) {}

  async recordApply(multiplier: number, now = Date.now()): Promise<{ show: boolean }> {
    const result = this.tail.then(() => this.recordApplyNow(multiplier, now));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async recordApplyNow(multiplier: number, now: number): Promise<{ show: boolean }> {
    // Write-amplification bound: sub-threshold applies never touch storage.
    if (multiplier < NUDGE_MULTIPLIER_MIN) return { show: false };
    const current = normalizeNudge((await this.storage.get(this.key))[this.key]);
    const next: NudgeRecord = { ...current, highApplied: current.highApplied + 1 };
    const show = shouldShowNudge(next, now);
    // A show stamps lastShownTs and resets the counter in the same write.
    await this.storage.set({
      [this.key]: show ? { ...current, highApplied: 0, lastShownTs: now } : next,
    });
    return { show };
  }

  async dismiss(forever: boolean, now = Date.now()): Promise<NudgeRecord> {
    const result = this.tail.then(() => this.dismissNow(forever, now));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async dismissNow(forever: boolean, now: number): Promise<NudgeRecord> {
    const current = normalizeNudge((await this.storage.get(this.key))[this.key]);
    const next: NudgeRecord = {
      ...current,
      highApplied: 0,
      ...(forever
        ? { dismissedForever: true }
        : { dismissedUntil: now + NUDGE_DISMISS_COOLDOWN_MS }),
    };
    await this.storage.set({ [this.key]: next });
    return next;
  }

  async get(): Promise<NudgeRecord> {
    const raw = await this.storage.get(this.key);
    return normalizeNudge(raw[this.key]);
  }
}
