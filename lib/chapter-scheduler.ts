// Chapter scheduler: applies the per-segment multipliers of a chapter-based
// rate plan while playback crosses segment boundaries. DOM-free — it drives
// a VideoLike (the same surface lib/matcher.ts and lib/time-saved.ts use)
// plus an injected apply callback, so unit tests run against a fake element.
//
// The reset-sentinel arbitration mirrors RateReapplier: a rate reset to
// exactly 1.0 (player re-init, seek) is re-asserted with the current
// segment's multiplier; a rate equal to what we applied is ours; any other
// rate is a deliberate user change, and we yield — no more applies until the
// next segment boundary (or a reset back to 1.0).

import type { RateSegment } from './chapters';

export interface VideoLike {
  currentTime: number;
  playbackRate: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/** Float slack for rate read-back; the same 1e-6 lib/matcher.ts uses. */
const RATE_EPSILON = 1e-6;

/** Index of the segment containing `time`: the last segment whose startSec
 * is at or before it. -1 before the first segment starts. */
function segmentIndexAt(rates: readonly RateSegment[], time: number): number {
  let lo = 0;
  let hi = rates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = rates[mid]!;
    if (seg.startSec <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export class ChapterScheduler {
  private video: VideoLike | null = null;
  private rates: RateSegment[] = [];
  private apply: ((multiplier: number) => number) | null = null;
  private index = -1;
  private applied: number | null = null;
  private yielded = false;

  get active(): boolean {
    return this.video !== null;
  }

  /** Index of the segment being enforced; -1 before the first tick. */
  get activeIndex(): number {
    return this.index;
  }

  /** The multiplier currently being enforced, or null when inactive. */
  get lastApplied(): number | null {
    return this.applied;
  }

  /** True after the user set a rate that is neither a reset nor ours; the
   * scheduler holds off until the next segment boundary. */
  get hasYielded(): boolean {
    return this.yielded;
  }

  /** Starts scheduling: applies the rate of the segment under currentTime
   * and re-applies on every segment boundary. Replaces any previous
   * attachment. */
  start(
    video: VideoLike,
    rates: readonly RateSegment[],
    apply: (multiplier: number) => number,
  ): void {
    this.stop();
    this.video = video;
    this.rates = [...rates];
    this.apply = apply;
    video.addEventListener('timeupdate', this.onTick);
    video.addEventListener('play', this.onTick);
    video.addEventListener('ratechange', this.onRatechange);
  }

  /** Stops scheduling: listeners removed, playback rate untouched. */
  stop(): void {
    if (this.video !== null) {
      this.video.removeEventListener('timeupdate', this.onTick);
      this.video.removeEventListener('play', this.onTick);
      this.video.removeEventListener('ratechange', this.onRatechange);
    }
    this.video = null;
    this.rates = [];
    this.apply = null;
    this.index = -1;
    this.applied = null;
    this.yielded = false;
  }

  private readonly onTick = (): void => {
    const video = this.video;
    if (video === null) return;
    const index = segmentIndexAt(this.rates, video.currentTime);
    if (index === -1 || index === this.index) return;
    const apply = this.apply;
    if (apply === null) return;
    this.index = index;
    this.yielded = false;
    this.applied = apply(this.rates[index]!.multiplier);
  };

  private readonly onRatechange = (): void => {
    const video = this.video;
    if (video === null || this.applied === null) return;
    const rate = video.playbackRate;
    if (Math.abs(rate - 1) <= RATE_EPSILON) {
      this.yielded = false;
      this.applied = this.apply?.(this.applied) ?? this.applied;
      return;
    }
    if (Math.abs(rate - this.applied) <= RATE_EPSILON) return;
    this.yielded = true;
  };
}
