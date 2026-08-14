import { describe, expect, it, vi } from 'vitest';
import { formatTimeSaved, timeUnit } from '../lib/i18n';
import {
  FLUSH_INTERVAL_MS,
  MAX_TICK_MS,
  normalizeSavedSec,
  TIME_SAVED_STORAGE_KEY,
  TimeSavedStore,
  TimeSavedTracker,
  type SavedTick,
  type VideoLike,
} from '../lib/time-saved';
import { mockStorage } from './fixtures/helpers';

/** Fake <video>-shaped element: the tracker only needs playbackRate plus
 * add/removeEventListener; fire() drives a listener synchronously. */
class FakeVideo implements VideoLike {
  playbackRate = 1;
  private readonly listeners = new Map<string, EventListener[]>();

  addEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const list = (this.listeners.get(type) ?? []).filter((l) => l !== listener);
    this.listeners.set(type, list);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }

  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

/** Injectable clock for the tracker's wall-time input. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function attach(
  video: VideoLike,
  multiplier: number,
  flushes: SavedTick[],
  clock: { now: () => number },
): TimeSavedTracker {
  const tracker = new TimeSavedTracker();
  tracker.attach(video, multiplier, (tick) => flushes.push(tick), clock.now);
  return tracker;
}

describe('TimeSavedTracker tick math', () => {
  it('accrues wall time at the applied rate, capped at MAX_TICK_MS per tick', () => {
    const video = new FakeVideo();
    video.playbackRate = 1.5;
    const clock = fakeClock(0);
    const flushes: SavedTick[] = [];
    const tracker = attach(video, 1.5, flushes, clock);

    clock.advance(400);
    video.fire('timeupdate'); // delta 400 ms → 0.4 s
    clock.advance(4000);
    video.fire('timeupdate'); // delta 4000 ms → capped at 1000 ms → 1 s
    clock.advance(600);
    video.fire('timeupdate'); // delta 600 ms → 0.6 s
    tracker.detach(); // flush the tail

    expect(flushes).toEqual([{ deltaSec: 2, multiplier: 1.5 }]);
  });

  it('a manual rate divergence accrues nothing and the gap is never credited', () => {
    const video = new FakeVideo();
    video.playbackRate = 1.5;
    const clock = fakeClock(0);
    const flushes: SavedTick[] = [];
    const tracker = attach(video, 1.5, flushes, clock);

    video.playbackRate = 1.2; // user manual change
    clock.advance(3000);
    video.fire('timeupdate'); // no accrue; lastTick resets
    video.playbackRate = 1.5; // back to the applied rate
    clock.advance(1000);
    video.fire('timeupdate'); // only 1 s counts, not the 3 s gap
    tracker.detach();

    expect(flushes).toEqual([{ deltaSec: 1, multiplier: 1.5 }]);
  });

  it('caps the first tick after a long stall (pause / background tab)', () => {
    const video = new FakeVideo();
    video.playbackRate = 1.5;
    const clock = fakeClock(0);
    const flushes: SavedTick[] = [];
    const tracker = attach(video, 1.5, flushes, clock);

    clock.advance(10_000);
    video.fire('timeupdate');
    tracker.detach();

    expect(flushes).toEqual([{ deltaSec: MAX_TICK_MS / 1000, multiplier: 1.5 }]);
  });

  it('flushes every FLUSH_INTERVAL_MS and starts the next window empty', () => {
    vi.useFakeTimers();
    try {
      const video = new FakeVideo();
      video.playbackRate = 2;
      const clock = fakeClock(0);
      const flushes: SavedTick[] = [];
      attach(video, 2, flushes, clock);

      // 10 s of 1 s ticks (under the per-tick cap) → the interval flush.
      for (let i = 0; i < 10; i++) {
        clock.advance(1000);
        video.fire('timeupdate');
      }
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
      expect(flushes).toEqual([{ deltaSec: 10, multiplier: 2 }]);

      // The next window accrues independently of the flushed one.
      clock.advance(1000);
      video.fire('timeupdate');
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
      expect(flushes).toEqual([
        { deltaSec: 10, multiplier: 2 },
        { deltaSec: 1, multiplier: 2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('attach replaces the previous attachment: old listener gone, tail flushed', () => {
    const first = new FakeVideo();
    first.playbackRate = 1.5;
    const second = new FakeVideo();
    second.playbackRate = 2;
    const clock = fakeClock(0);
    const flushes: SavedTick[] = [];
    const tracker = attach(first, 1.5, flushes, clock);

    clock.advance(500);
    first.fire('timeupdate'); // 0.5 s at 1.5x
    tracker.attach(second, 2, (tick) => flushes.push(tick), clock.now);
    expect(first.listenerCount('timeupdate')).toBe(0);

    clock.advance(500);
    first.fire('timeupdate'); // detached: must not accrue
    second.fire('timeupdate'); // delta 500 ms → 0.5 s at 2x
    tracker.detach();

    expect(flushes).toEqual([
      { deltaSec: 0.5, multiplier: 1.5 },
      { deltaSec: 0.5, multiplier: 2 },
    ]);
  });

  it('detach is a no-op when nothing is attached', () => {
    const flushes: SavedTick[] = [];
    const tracker = new TimeSavedTracker();
    expect(() => tracker.detach()).not.toThrow();
    expect(flushes).toEqual([]);
  });
});

describe('TimeSavedStore', () => {
  it('accrues savedSeconds: 60 s at 2x saves 30 s', async () => {
    const store = new TimeSavedStore(mockStorage());
    expect(await store.accrue(60, 2)).toBe(30);
    expect(await store.get()).toBe(30);
  });

  it('60 s at 1.5x saves 20 s; 60 s at 1x saves nothing', async () => {
    const store = new TimeSavedStore(mockStorage());
    expect(await store.accrue(60, 1.5)).toBe(20);
    expect(await store.accrue(60, 1)).toBe(20);
  });

  it('accumulates sequentially and returns the running total', async () => {
    const store = new TimeSavedStore(mockStorage());
    await store.accrue(60, 2); // +30
    await store.accrue(10, 2); // +5
    expect(await store.accrue(20, 1.5)).toBe(35 + (20 * 0.5) / 1.5);
  });

  it('serializes concurrent accrues over one storage so no update is lost', async () => {
    const store = new TimeSavedStore(mockStorage());
    await Promise.all([store.accrue(60, 2), store.accrue(60, 2), store.accrue(60, 2)]);
    expect(await store.get()).toBe(90);
  });

  it('normalizes corrupt stored values to 0 on read', async () => {
    for (const bad of [NaN, -5, Infinity, 'garbage']) {
      const store = new TimeSavedStore(mockStorage({ [TIME_SAVED_STORAGE_KEY]: bad }));
      expect(await store.get()).toBe(0);
    }
    expect(await new TimeSavedStore(mockStorage()).get()).toBe(0); // absent
    expect(normalizeSavedSec(12.5)).toBe(12.5);
  });

  it('ignores out-of-bounds accrues without writing', async () => {
    const storage = mockStorage();
    const store = new TimeSavedStore(storage);
    expect(await store.accrue(0, 2)).toBe(0); // deltaSec ≤ 0
    expect(await store.accrue(-5, 2)).toBe(0);
    expect(await store.accrue(60, 0.05)).toBe(0); // multiplier < MIN
    expect(await store.accrue(60, 11)).toBe(0); // multiplier > MAX
    expect(await store.get()).toBe(0);
    // A valid accrue still lands after the rejects.
    expect(await store.accrue(60, 2)).toBe(30);
  });
});

describe('formatTimeSaved golden values', () => {
  it('rounds to one significant figure (en)', () => {
    expect(formatTimeSaved(33732, 'en')).toEqual({ amount: '9', unit: 'hours' });
    expect(formatTimeSaved(2700, 'en')).toEqual({ amount: '50', unit: 'minutes' });
    expect(formatTimeSaved(54000, 'en')).toEqual({ amount: '20', unit: 'hours' });
    expect(formatTimeSaved(90, 'en')).toEqual({ amount: '2', unit: 'minutes' });
    expect(formatTimeSaved(30, 'en')).toEqual({ amount: '30', unit: 'seconds' });
    expect(formatTimeSaved(0.6, 'en')).toEqual({ amount: '0.6', unit: 'seconds' });
    expect(formatTimeSaved(3600, 'en')).toEqual({ amount: '1', unit: 'hour' });
  });

  it('localizes the amount (decimal comma) and the plural unit (ru)', () => {
    expect(formatTimeSaved(33732, 'ru')).toEqual({ amount: '9', unit: 'часов' });
    expect(formatTimeSaved(2700, 'ru')).toEqual({ amount: '50', unit: 'минут' });
    expect(formatTimeSaved(54000, 'ru')).toEqual({ amount: '20', unit: 'часов' });
    expect(formatTimeSaved(90, 'ru')).toEqual({ amount: '2', unit: 'минуты' });
    expect(formatTimeSaved(30, 'ru')).toEqual({ amount: '30', unit: 'секунд' });
    expect(formatTimeSaved(0.6, 'ru')).toEqual({ amount: '0,6', unit: 'секунд' });
    expect(formatTimeSaved(3600, 'ru')).toEqual({ amount: '1', unit: 'час' });
  });

  it('timeUnit picks the ru one/few/many forms', () => {
    expect(timeUnit('hour', 1, 'ru')).toBe('час');
    expect(timeUnit('hour', 21, 'ru')).toBe('час'); // 21 % 100 !== 11
    expect(timeUnit('hour', 2, 'ru')).toBe('часа');
    expect(timeUnit('hour', 22, 'ru')).toBe('часа');
    expect(timeUnit('hour', 5, 'ru')).toBe('часов');
    expect(timeUnit('hour', 11, 'ru')).toBe('часов'); // 11 excluded from few
    expect(timeUnit('minute', 1, 'ru')).toBe('минута');
    expect(timeUnit('minute', 3, 'ru')).toBe('минуты');
    expect(timeUnit('minute', 12, 'ru')).toBe('минут');
    expect(timeUnit('second', 1, 'ru')).toBe('секунда');
    expect(timeUnit('second', 4, 'ru')).toBe('секунды');
    expect(timeUnit('second', 14, 'ru')).toBe('секунд');
    expect(timeUnit('hour', 1, 'en')).toBe('hour');
    expect(timeUnit('hour', 2, 'en')).toBe('hours');
    expect(timeUnit('second', 0.6, 'en')).toBe('seconds');
  });
});
