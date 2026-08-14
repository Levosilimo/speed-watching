import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRate,
  RateReapplier,
  selectVideo,
  type VideoLike,
} from '../lib/matcher';

class FakeVideo implements VideoLike {
  playbackRate = 1;
  paused = false;
  isConnected = true;
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Fires a media event; returns how many listeners ran. */
  fire(type: string): number {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return this.listeners.get(type)?.size ?? 0;
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

describe('applyRate', () => {
  it('clamps the multiplier to the platform max', () => {
    const video = new FakeVideo();
    expect(applyRate(video, 3, 2)).toBe(2);
    expect(video.playbackRate).toBe(2);
  });

  it('applies unclamped multipliers below the max', () => {
    const video = new FakeVideo();
    expect(applyRate(video, 1.55, 2)).toBe(1.55);
    expect(video.playbackRate).toBe(1.55);
  });
});

describe('selectVideo', () => {
  it('prefers the last media-event target when still present', () => {
    const a = new FakeVideo();
    const b = new FakeVideo();
    expect(selectVideo([a, b], b)).toBe(b);
  });

  it('drops a removed last target and picks the first playing element', () => {
    const removed = new FakeVideo();
    const a = new FakeVideo();
    const b = new FakeVideo();
    a.paused = true;
    expect(selectVideo([a, b], removed)).toBe(b);
  });

  it('falls back to the first element when nothing is playing', () => {
    const a = new FakeVideo();
    const b = new FakeVideo();
    a.paused = true;
    b.paused = true;
    expect(selectVideo([a, b], null)).toBe(a);
  });

  it('returns null when there are no candidates', () => {
    expect(selectVideo([], null)).toBeNull();
  });
});

describe('RateReapplier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the multiplier on start', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.55, 2);
    expect(video.playbackRate).toBe(1.55);
    expect(loop.lastApplied).toBe(1.55);
    expect(loop.active).toBe(true);
  });

  it('re-asserts a rate reset by the player (ratechange event)', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    video.playbackRate = 1; // player reset, like Vimeo's pause/play
    video.fire('ratechange');
    expect(video.playbackRate).toBe(1.5);
  });

  it('re-asserts on play and pause', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    for (const type of ['play', 'pause'] as const) {
      video.playbackRate = 1;
      video.fire(type);
      expect(video.playbackRate).toBe(1.5);
    }
  });

  it('re-asserts silently drifting rates on the re-check interval', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier(2000);
    loop.start(video, 1.5, 2);
    video.playbackRate = 1; // re-init style reset, no event fired
    vi.advanceTimersByTime(1999);
    expect(video.playbackRate).toBe(1);
    vi.advanceTimersByTime(1);
    expect(video.playbackRate).toBe(1.5);
  });

  it('does not fight the player over float read-back noise', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    video.playbackRate = 1.5 + 1e-9;
    video.fire('ratechange');
    expect(video.playbackRate).toBe(1.5 + 1e-9);
  });

  it('respects a user manual rate: only a reset to 1.0 is re-asserted', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    video.playbackRate = 1.25; // user dials their own speed
    video.fire('ratechange');
    expect(video.playbackRate).toBe(1.25);
    expect(loop.lastApplied).toBe(1.5);
  });

  it('leaves a manual rate alone on the re-check interval', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier(2000);
    loop.start(video, 1.5, 2);
    video.playbackRate = 1.25;
    vi.advanceTimersByTime(2500); // > one re-check interval
    expect(video.playbackRate).toBe(1.25);
  });

  it('still re-asserts a manual return to 1.0 (indistinguishable from a reset)', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    video.playbackRate = 1.25;
    video.fire('ratechange');
    video.playbackRate = 1;
    video.fire('ratechange');
    expect(video.playbackRate).toBe(1.5);
  });

  it('stops re-asserting after stop() and leaves the rate untouched', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    loop.stop();
    expect(loop.active).toBe(false);
    expect(loop.lastApplied).toBeNull();
    video.playbackRate = 1;
    video.fire('ratechange');
    expect(video.playbackRate).toBe(1);
    expect(video.listenerCount()).toBe(0);
  });

  it('stops the loop when the video unmounts', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    video.isConnected = false;
    video.playbackRate = 1;
    video.fire('ratechange');
    expect(loop.active).toBe(false);
    expect(video.playbackRate).toBe(1);
    expect(video.listenerCount()).toBe(0);
  });

  it('restart applies the new multiplier and keeps a single timer', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    loop.start(video, 1.8, 2);
    expect(video.playbackRate).toBe(1.8);
    video.playbackRate = 1;
    vi.advanceTimersByTime(2000);
    expect(video.playbackRate).toBe(1.8);
  });

  it('re-applies through the platform max when re-asserting', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 3, 2); // clamped to 2
    expect(video.playbackRate).toBe(2);
    video.playbackRate = 1;
    video.fire('ratechange');
    expect(video.playbackRate).toBe(2);
  });

  it('setRates arms the pair and currentRateFor picks per gap state', () => {
    const loop = new RateReapplier();
    loop.setRates(1.5, 1.1);
    expect(loop.currentRateFor(false)).toBe(1.5);
    expect(loop.currentRateFor(true)).toBe(1.1);
  });

  it('currentRateFor falls back to the applied rate without a pair', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    expect(loop.currentRateFor(true)).toBe(1.5);
  });

  it('re-asserts the pair base, never the pause rate, on a 1.0 reset', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    loop.setRates(1.5, 1.1);
    video.playbackRate = 1; // player reset mid-gap
    video.fire('ratechange');
    expect(video.playbackRate).toBe(1.5);
  });

  it('the pause rate is not a re-assert trigger for a user change', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    loop.setRates(1.5, 1.1);
    video.playbackRate = 1.8; // user change outside the pair
    video.fire('ratechange');
    expect(video.playbackRate).toBe(1.8);
  });

  it('stop() clears the pair', () => {
    const video = new FakeVideo();
    const loop = new RateReapplier();
    loop.start(video, 1.5, 2);
    loop.setRates(1.5, 1.1);
    loop.stop();
    expect(loop.currentRateFor(true)).toBe(1);
  });
});
