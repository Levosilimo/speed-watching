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
// called from the Apply handler, stop() from Dismiss) and only re-asserts
// when the video's rate diverges from the last-applied multiplier, so a
// dismissed recommendation never fights the user's manual rate.

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

/** Sets the rate clamped to the platform max; returns the value applied. */
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
  private platformMax = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly intervalMs = 2000) {}

  get active(): boolean {
    return this.video !== null;
  }

  /** The multiplier currently being enforced, or null when inactive. */
  get lastApplied(): number | null {
    return this.applied;
  }

  /** Applies the multiplier and re-asserts it until stop() is called. */
  start(video: VideoLike, multiplier: number, platformMax: number): void {
    this.stop();
    this.video = video;
    this.platformMax = platformMax;
    this.applied = applyRate(video, multiplier, platformMax);
    video.addEventListener('ratechange', this.reassert);
    video.addEventListener('play', this.reassert);
    video.addEventListener('pause', this.reassert);
    this.timer = setInterval(() => this.reassert(), this.intervalMs);
  }

  /** Stops enforcement: listeners removed, timer cleared, rate untouched. */
  stop(): void {
    if (this.video !== null) {
      this.video.removeEventListener('ratechange', this.reassert);
      this.video.removeEventListener('play', this.reassert);
      this.video.removeEventListener('pause', this.reassert);
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.video = null;
    this.applied = null;
    this.timer = null;
  }

  private readonly reassert = (): void => {
    const video = this.video;
    if (video === null || this.applied === null) return;
    // The player replaced the element (SPA re-render): nothing left to hold.
    if (!video.isConnected) {
      this.stop();
      return;
    }
    if (Math.abs(video.playbackRate - this.applied) > RATE_EPSILON) {
      this.applied = applyRate(video, this.applied, this.platformMax);
    }
  };
}
