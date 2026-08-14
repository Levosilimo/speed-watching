// Skip-silence (Option C: slow-through-pauses): instead of seeking past
// silent gaps in the caption timeline (which YouTube's player fights with
// its seek-reset) or cutting them out, playback rate DIPS inside a gap —
// silence passes at the pause rate while speech keeps the applied rate.
// No currentTime mutation, no jump cuts.
//
// Gap index: consecutive cue/word starts with start[i+1] − start[i] >= 1 s —
// the same convention speechDurationSec() uses (lib/wpm.ts), shared not
// forked. Only gaps >= the setting's minGapSec (default 1.5 s, the yield
// doc's "skimmable" threshold) produce spans; the words series when the
// payload carries word timing (>= 2 timed words), else the cue series.
//
// In-gap rate choice: pauseRate clamped to [1, min(applied, 1.3)]. The
// clamp keeps a dip a dip — never below real time, never above the applied
// rate — and caps silence at 1.3x so the slow-through promise holds even
// if the user raises pauseRate. When the clamp collapses the range (applied
// <= pauseRate) there is no dip to perform and the actuator never attaches.
//
// Saved-time interplay: the tracker and the saved-line gate keep the
// OUT-OF-GAP applied rate as the accrual multiplier, so the in-gap dip
// pauses accrual and hides the saved line while it lasts (wall time at the
// pause rate is not credited at the applied multiplier — honest, slightly
// conservative) and the live-rate line shows the dip. The content script
// re-renders the pill with skipSlowed on gap transitions, which swaps the
// saved-line area to the 'silence: slowed' indicator.
//
// The actuator mirrors the reset-sentinel arbitration of lib/matcher.ts: it
// writes only while the observed rate is one of the pair (base or pause) or
// an exactly-1.0 player reset — a user's manual rate is never overwritten.
// The store owns 'sw.skipSilence' (one key per module; see lib/settings.ts).

import type { Segment } from './captions';
import type { StorageLike } from './settings';
import { RATE_EPSILON } from './time-saved';

export const SKIP_SILENCE_STORAGE_KEY = 'sw.skipSilence';

/** The shared >= 1 s gap convention (speechDurationSec's threshold) and the
 * minGapSec floor. */
export const MIN_GAP_SEC = 1;
/** minGapSec ceiling: a threshold past a minute of silence is a mid-video
 * break, not a pause. The bridge's wire guard shares this bound. */
export const MAX_GAP_SEC = 60;
/** Default skimmable threshold — the yield doc's gap >= 1.5 s rule. */
export const DEFAULT_MIN_GAP_SEC = 1.5;
/** Default in-gap rate: silence passes 10% faster than real time. */
export const DEFAULT_PAUSE_RATE = 1.1;
/** The slow-through cap: silence never passes faster than this, whatever
 * pauseRate says. */
export const MAX_PAUSE_RATE = 1.3;
/** Floor: silence never passes slower than real time. */
export const MIN_PAUSE_RATE = 1;

export interface SkipSilencePrefs {
  /** Master opt-in; strict boolean on read. */
  enabled: boolean;
  /** Only inter-start gaps at least this long are slowed. */
  minGapSec: number;
  /** The in-gap rate target; clamped to [1, min(applied, 1.3)]. */
  pauseRate: number;
}

export function defaultSkipSilence(): SkipSilencePrefs {
  return { enabled: false, minGapSec: DEFAULT_MIN_GAP_SEC, pauseRate: DEFAULT_PAUSE_RATE };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Normalize-on-read: strict-boolean toggle, minGapSec floored at the
 * shared 1 s convention and capped at MAX_GAP_SEC, pauseRate clamped into
 * [1, 1.3]. No storage rewrite pass — read-path only, like lib/settings.ts. */
export function normalizeSkipSilence(raw: unknown): SkipSilencePrefs {
  const base = defaultSkipSilence();
  if (!isRecord(raw)) return base;
  return {
    enabled: raw.enabled === true,
    minGapSec: Math.min(MAX_GAP_SEC, Math.max(MIN_GAP_SEC, finiteOr(raw.minGapSec, base.minGapSec))),
    pauseRate: Math.min(MAX_PAUSE_RATE, Math.max(MIN_PAUSE_RATE, finiteOr(raw.pauseRate, base.pauseRate))),
  };
}

/** Skip-silence for a site: the override's flag, else the global toggle. */
export function resolveSkipSilence(
  prefs: SkipSilencePrefs,
  siteOverride: { skipSilence?: boolean } | undefined,
): SkipSilencePrefs {
  if (siteOverride?.skipSilence === undefined) return prefs;
  return { ...prefs, enabled: siteOverride.skipSilence };
}

/** One silent span [start, end) between consecutive cue/word starts. */
export interface GapSpan {
  start: number;
  end: number;
}

/** Sorted gap spans where start[i+1] − start[i] >= minGapSec. Non-positive
 * deltas (out-of-order timings) never form a gap; the input must be
 * chronological. */
export function buildGapIndex(items: readonly Segment[], minGapSec: number): GapSpan[] {
  const spans: GapSpan[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    const cur = items[i]!;
    const next = items[i + 1]!;
    if (next.startSec - cur.startSec >= minGapSec) {
      spans.push({ start: cur.startSec, end: next.startSec });
    }
  }
  return spans;
}

/** The gap span containing currentTime, or null outside every gap. */
export function gapForTime(index: readonly GapSpan[], currentTime: number): GapSpan | null {
  let lo = 0;
  let hi = index.length;
  // Last span with start <= t, then verify t is before its end.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid]!.start <= currentTime) lo = mid + 1;
    else hi = mid;
  }
  const span = index[lo - 1];
  return span !== undefined && currentTime < span.end ? span : null;
}

/** The pure gate: the toggle is on AND the timeline carries at least one
 * gap >= minGapSec. The content scripts pass the series they will index
 * (words when timed, else cues). */
export function shouldSkip(cues: readonly Segment[], prefs: SkipSilencePrefs): boolean {
  return prefs.enabled && buildGapIndex(cues, prefs.minGapSec).length > 0;
}

/** The in-gap rate for an applied multiplier: pauseRate clamped into
 * [1, min(applied, 1.3)]. */
export function pauseRateFor(applied: number, prefs: SkipSilencePrefs): number {
  return Math.min(applied, Math.max(MIN_PAUSE_RATE, Math.min(MAX_PAUSE_RATE, prefs.pauseRate)));
}

/** Injectable chrome.storage.local stand-in (same shape as SettingsStore). */
export class SkipSilenceStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly key = SKIP_SILENCE_STORAGE_KEY,
  ) {}

  async load(): Promise<SkipSilencePrefs> {
    const raw = await this.storage.get(this.key);
    return normalizeSkipSilence(raw[this.key]);
  }

  async save(prefs: SkipSilencePrefs): Promise<void> {
    await this.storage.set({ [this.key]: prefs });
  }

  async update(mutate: (prefs: SkipSilencePrefs) => SkipSilencePrefs): Promise<SkipSilencePrefs> {
    const next = mutate(await this.load());
    await this.save(next);
    return next;
  }
}

/** The playback surface the skip listener drives: the reapplier's VideoLike
 * plus currentTime. */
export interface SkipVideo {
  playbackRate: number;
  currentTime: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/** Slow-through actuator: a timeupdate listener that dips the rate to the
 * pause target inside a gap and restores the base rate outside it, and
 * reports gap transitions through onChange (the content script re-renders
 * the pill indicator on them). attach() with a collapsed rate range (the
 * dip would equal the base) is a no-op. */
export class SkipSilenceActuator {
  private video: SkipVideo | null = null;
  private index: readonly GapSpan[] = [];
  private prefs: SkipSilencePrefs = defaultSkipSilence();
  private base = 1;
  private inGap = false;
  private onChange: ((inGap: boolean) => void) | null = null;

  get active(): boolean {
    return this.video !== null;
  }

  get inGapNow(): boolean {
    return this.inGap;
  }

  /** The rate the actuator holds right now (or would hold): the pause
   * target in a gap, the base rate outside. The content scripts' override
   * detection treats it as ours. */
  get target(): number {
    return this.inGap ? pauseRateFor(this.base, this.prefs) : this.base;
  }

  attach(
    video: SkipVideo,
    index: readonly GapSpan[],
    prefs: SkipSilencePrefs,
    base: number,
    onChange?: (inGap: boolean) => void,
  ): void {
    this.detach();
    if (pauseRateFor(base, prefs) >= base) return; // no dip to perform
    this.video = video;
    this.index = index;
    this.prefs = prefs;
    this.base = base;
    this.onChange = onChange ?? null;
    video.addEventListener('timeupdate', this.onTick);
  }

  /** Stops listening; the current rate stays untouched (mirror of
   * RateReapplier.stop). */
  detach(): void {
    if (this.video !== null) this.video.removeEventListener('timeupdate', this.onTick);
    this.video = null;
    this.index = [];
    this.onChange = null;
    this.inGap = false;
  }

  private readonly onTick = (): void => {
    const video = this.video;
    if (video === null) return;
    const inGap = gapForTime(this.index, video.currentTime) !== null;
    const pause = pauseRateFor(this.base, this.prefs);
    const target = inGap ? pause : this.base;
    const rate = video.playbackRate;
    // Write only while the rate is ours — either member of the pair — or a
    // player reset to exactly 1.0 (the sentinel's own re-assert trigger). A
    // user's manual rate is never overwritten.
    const ours = Math.abs(rate - this.base) <= RATE_EPSILON || Math.abs(rate - pause) <= RATE_EPSILON;
    if ((ours || Math.abs(rate - 1) <= RATE_EPSILON) && Math.abs(rate - target) > RATE_EPSILON) {
      video.playbackRate = target;
    }
    if (inGap !== this.inGap) {
      this.inGap = inGap;
      this.onChange?.(inGap);
    }
  };
}
