// Generic player matcher: element selection and playback-rate application
// with a re-assert loop. Pure module — no DOM globals, so the content script
// (entrypoints/generic.content.ts) stays a thin adapter and everything here
// is unit-testable against a fake video element.
//
// Why the loop exists (measured, docs/phase0-generic-probe.md): native
// elements and YouTube embeds hold the assigned playbackRate through seek,
// but Vimeo's player resets it to 1.0 on pause/play (embed) and within ~2s
// on re-init (page). Re-asserting once at apply time is not enough — the
// matcher re-applies on ratechange/play/pause and on a fixed interval.
//
// The loop only runs while the pill recommendation is active (start() is
// called from the Apply handler, stop() from Dismiss). It treats a reset to
// playbackRate 1.0 (player re-init, seek) as the only re-assert trigger: any
// other divergence — including a user's manual rate — is respected, so the
// loop never fights the user. Dismissed recommendations never re-assert at
// all (stop() detaches the loop).

export interface VideoLike {
  playbackRate: number;
  paused: boolean;
  isConnected: boolean;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/** Multi-video pages: the last media-event target wins; before any event,
 * the first non-paused element; otherwise the first element. */
export function selectVideo<T extends VideoLike>(
  candidates: readonly T[],
  lastActive: T | null,
): T | null {
  if (lastActive !== null && candidates.includes(lastActive)) return lastActive;
  return candidates.find((video) => !video.paused) ?? candidates[0] ?? null;
}

export function applyRate(video: VideoLike, multiplier: number, platformMax: number): number {
  const clamped = Math.min(multiplier, platformMax);
  video.playbackRate = clamped;
  return clamped;
}

/** Float slack for rate read-back; a player clamping 1.5 → 1.25 is drift. */
const RATE_EPSILON = 1e-6;

export class RateReapplier {
  private video: VideoLike | null = null;
  private applied: number | null = null;
  /** The in-gap dip rate (skip-silence); null while no pair is armed. */
  private pause: number | null = null;
  private platformMax = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** When the loop last ran (the E2E hook's tick witness — the specs wait
   * for this to advance past a full interval instead of sleeping). */
  lastAssertAt: number | null = null;

  constructor(readonly intervalMs = 2000) {}

  get active(): boolean {
    return this.video !== null;
  }

  get lastApplied(): number | null {
    return this.applied;
  }

  start(video: VideoLike, multiplier: number, platformMax: number): void {
    this.stop();
    this.video = video;
    this.platformMax = platformMax;
    this.pause = null;
    this.applied = applyRate(video, multiplier, platformMax);
    video.addEventListener('ratechange', this.reassert);
    video.addEventListener('play', this.reassert);
    video.addEventListener('pause', this.reassert);
    this.timer = setInterval(() => this.reassert(), this.intervalMs);
  }

  /** Stops enforcement; the current rate stays untouched. */
  stop(): void {
    if (this.video !== null) {
      this.video.removeEventListener('ratechange', this.reassert);
      this.video.removeEventListener('play', this.reassert);
      this.video.removeEventListener('pause', this.reassert);
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.video = null;
    this.applied = null;
    this.pause = null;
    this.timer = null;
  }

  /** Arms the base-vs-pause rate pair (skip-silence): base is the out-of-gap
   * rate the loop re-asserts, pause the in-gap dip target. The reset
   * sentinel is unchanged — only an exactly-1.0 reset re-asserts, so a
   * user's non-1.0 rate outside the pair is never fought. */
  setRates(base: number, pause: number): void {
    this.applied = base;
    this.pause = pause;
  }

  /** The rate to hold right now: the pause target inside a gap, the base
   * rate outside; the base rate while no pair is armed. */
  currentRateFor(inGap: boolean): number {
    return inGap && this.pause !== null ? this.pause : (this.applied ?? 1);
  }

  private readonly reassert = (): void => {
    const video = this.video;
    if (video === null || this.applied === null) return;
    this.lastAssertAt = Date.now();
    // The player replaced the element (SPA re-render): nothing left to hold.
    if (!video.isConnected) {
      this.stop();
      return;
    }
    // Reset sentinel: players reset to exactly 1.0; any other rate is a
    // deliberate user change and stays untouched.
    if (Math.abs(video.playbackRate - 1) <= RATE_EPSILON) {
      this.applied = applyRate(video, this.applied, this.platformMax);
    }
  };
}
