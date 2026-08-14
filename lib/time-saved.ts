// Time-saved metric (lib-13): the extension's applied rate reclaims wall
// clock — 60 s watched at 2x is 30 s of life back. Accrual happens in the
// content scripts (TimeSavedTracker, this file), which count only real
// timeupdate ticks while the video plays at the rate the extension set
// (the RATE_EPSILON gate); paused spans, user-manual rates, and pre-apply
// seconds never accrue, and the first tick after a stall is capped at
// MAX_TICK_MS so a background-tab gap cannot over-credit. The count flushes
// to the background every FLUSH_INTERVAL_MS and on detach, and the
// background's TimeSavedStore is the single writer (mirror of DemandStore,
// lib-11#3), so per-frame get→set pairs cannot interleave.
//
// Honest limits (spec): dismissed pills never attach, a divergent rate hits
// the EPS gate, the wall-clock gap while the rate is wrong is never credited
// on return, seek jumps are wall-clock, and the unflushed tail (≤
// FLUSH_INTERVAL_MS) is lost on abrupt close. The stored value, key
// 'sw.timeSavedSec', is a plain finite float of saved seconds; missing or
// corrupt values normalize to 0 on read (never fabricated).
//
// Chrome-free and DOM-free: the tracker talks to a VideoLike (the same
// shape lib/matcher.ts uses) and a flush callback, so unit tests run against
// a fake element with an injected clock.

import { MULTIPLIER_MAX, MULTIPLIER_MIN } from './messaging';
import type { StorageLike } from './settings';

export const TIME_SAVED_STORAGE_KEY = 'sw.timeSavedSec';

/** Playback-rate slack for the accrual gate: the player must still run at
 * the applied multiplier. 1e-6 is float drift, not a user change — the same
 * slack lib/matcher.ts uses for its reset sentinel. */
export const RATE_EPSILON = 1e-6;

/** Per-tick accrual cap in ms: a timeupdate after a long stall (background
 * tab, OS sleep, seek) never over-credits — the first tick back counts at
 * most this much. */
export const MAX_TICK_MS = 1000;

/** The tracker pushes its accrued seconds to the store on this cadence and
 * on detach. */
export const FLUSH_INTERVAL_MS = 10_000;

/** The video surface the tracker listens to: playbackRate (the gate input)
 * plus add/removeEventListener for the timeupdate signal. */
export interface VideoLike {
  playbackRate: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/** One flush: the wall-clock seconds accrued since the last flush, at the
 * multiplier the session is gated on. */
export interface SavedTick {
  deltaSec: number;
  multiplier: number;
}

/** Saved wall time for deltaSec watched at multiplier. Written as
 * deltaSec × (multiplier − 1) / multiplier rather than
 * deltaSec × (1 − 1/multiplier): the 1 − 1/m round trip lands inexact
 * (60 s at 1.5x → 20.000000000000004), and the store tests pin the exact
 * golden values. */
export function savedSeconds(deltaSec: number, multiplier: number): number {
  return (deltaSec * (multiplier - 1)) / multiplier;
}

/**
 * Counts wall-clock seconds the video spent playing at the applied rate.
 * attach() replaces any previous attachment — the old listener is removed
 * and its tail flushed — and detach() flushes the tail and stops the
 * cadence. Both are idempotent-safe for the content-script lifecycle
 * (dismiss, navigation, video change).
 */
export class TimeSavedTracker {
  private video: VideoLike | null = null;
  private multiplier = 0;
  private flushTick: ((tick: SavedTick) => void) | null = null;
  private now: () => number = Date.now;
  private lastTick = 0;
  private accruedSec = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly onTimeupdate = (): void => this.tick();

  attach(
    video: VideoLike,
    multiplier: number,
    flush: (tick: SavedTick) => void,
    now: () => number = Date.now,
  ): void {
    this.detach();
    this.video = video;
    this.multiplier = multiplier;
    this.flushTick = flush;
    this.now = now;
    this.lastTick = now();
    video.addEventListener('timeupdate', this.onTimeupdate);
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  detach(): void {
    if (this.video === null) return;
    this.video.removeEventListener('timeupdate', this.onTimeupdate);
    this.flush();
    if (this.timer !== null) clearInterval(this.timer);
    this.video = null;
    this.flushTick = null;
    this.timer = null;
  }

  private tick(): void {
    const video = this.video;
    if (video === null) return;
    const now = this.now();
    const delta = now - this.lastTick;
    this.lastTick = now;
    // The accrual gate: only wall time at the applied rate counts. A
    // divergent rate (user manual change) or a paused gap drops the whole
    // delta — lastTick already advanced, so the gap is never credited on
    // return.
    if (Math.abs(video.playbackRate - this.multiplier) <= RATE_EPSILON && delta > 0) {
      this.accruedSec += Math.min(delta, MAX_TICK_MS) / 1000;
    }
  }

  private flush(): void {
    if (this.accruedSec <= 0) return;
    const flush = this.flushTick;
    if (flush === null) return;
    flush({ deltaSec: this.accruedSec, multiplier: this.multiplier });
    this.accruedSec = 0;
  }
}

/** Stored value must be a finite non-negative number; anything else reads
 * as 0 (normalize-on-read — no migration, no schema change). */
export function normalizeSavedSec(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/**
 * Serialized read-modify-write for the saved-seconds total, mirroring
 * DemandStore: accrues queue on a promise chain so concurrent calls cannot
 * lose updates (chrome.storage.local has no atomic increment). Single writer
 * by construction: the background owns the only instance and every frame's
 * bridge forwards timeSaved:accrue to it, so the per-instance chain covers
 * all frames. Unlike DemandStore the schema is a plain float, so accrue()
 * takes no clock or timestamps.
 */
export class TimeSavedStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageLike,
    private readonly key = TIME_SAVED_STORAGE_KEY,
  ) {}

  /** Adds savedSeconds(deltaSec, multiplier) to the total; resolves to the
   * running total. Non-positive deltas and out-of-range multipliers (outside
   * the SEC-3 log bounds) are ignored — nothing is written, the current
   * total is returned. No upper delta bound here: a legitimate flush spans
   * up to FLUSH_INTERVAL_MS of wall time (ten 1 s ticks), and the store math
   * is pinned on 60 s deltas by the tests, so the per-tick cap in the
   * tracker is the accrual authority (the wire guard proves finite). */
  async accrue(deltaSec: number, multiplier: number): Promise<number> {
    const result = this.tail.then(() => this.accrueNow(deltaSec, multiplier));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async accrueNow(deltaSec: number, multiplier: number): Promise<number> {
    if (deltaSec <= 0) return this.get();
    if (multiplier < MULTIPLIER_MIN || multiplier > MULTIPLIER_MAX) return this.get();
    const current = normalizeSavedSec((await this.storage.get(this.key))[this.key]);
    const saved = current + savedSeconds(deltaSec, multiplier);
    await this.storage.set({ [this.key]: saved });
    return saved;
  }

  async get(): Promise<number> {
    return normalizeSavedSec((await this.storage.get(this.key))[this.key]);
  }
}
