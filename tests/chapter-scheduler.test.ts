import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterScheduler, type VideoLike } from '../lib/chapter-scheduler';
import type { RateSegment } from '../lib/chapters';

class FakeVideo implements VideoLike {
  currentTime = 0;
  playbackRate = 1;
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

  /** Fires a media event to every registered listener. */
  fire(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

const rates: RateSegment[] = [
  { startSec: 0, endSec: 30, multiplier: 1.5, mode: 'recommend' },
  { startSec: 30, endSec: 60, multiplier: 1.8, mode: 'recommend' },
  { startSec: 60, endSec: 0, multiplier: 1.2, mode: 'recommend' },
];

describe('ChapterScheduler', () => {
  let video: FakeVideo;
  let scheduler: ChapterScheduler;
  let apply: ReturnType<typeof vi.fn<(multiplier: number) => number>>;

  beforeEach(() => {
    video = new FakeVideo();
    scheduler = new ChapterScheduler();
    apply = vi.fn((multiplier: number) => multiplier);
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('applies the segment multiplier on boundary steps', () => {
    scheduler.start(video, rates, apply);
    video.currentTime = 10;
    video.fire('timeupdate');
    expect(apply).toHaveBeenLastCalledWith(1.5);
    expect(scheduler.lastApplied).toBe(1.5);

    video.currentTime = 40;
    video.fire('timeupdate');
    expect(apply).toHaveBeenLastCalledWith(1.8);

    video.currentTime = 70;
    video.fire('play');
    expect(apply).toHaveBeenLastCalledWith(1.2);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it('does not apply before the first segment starts', () => {
    const late: RateSegment[] = [{ startSec: 10, endSec: 30, multiplier: 2, mode: 'recommend' }];
    scheduler.start(video, late, apply);
    video.currentTime = 5;
    video.fire('timeupdate');
    expect(apply).not.toHaveBeenCalled();
    video.currentTime = 15;
    video.fire('timeupdate');
    expect(apply).toHaveBeenLastCalledWith(2);
  });

  it('re-asserts the last applied rate when the player resets to 1.0', () => {
    scheduler.start(video, rates, apply);
    video.currentTime = 10;
    video.fire('timeupdate');
    apply.mockClear();

    video.playbackRate = 1;
    video.fire('ratechange');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(1.5);
    expect(scheduler.hasYielded).toBe(false);
  });

  it('treats a rate equal to the applied one as its own and does nothing', () => {
    scheduler.start(video, rates, apply);
    video.currentTime = 10;
    video.fire('timeupdate');
    apply.mockClear();

    video.playbackRate = 1.5;
    video.fire('ratechange');
    expect(apply).not.toHaveBeenCalled();
    expect(scheduler.hasYielded).toBe(false);
  });

  it('yields to any other rate until the next boundary', () => {
    scheduler.start(video, rates, apply);
    video.currentTime = 10;
    video.fire('timeupdate');
    apply.mockClear();

    video.playbackRate = 1.3;
    video.fire('ratechange');
    expect(scheduler.hasYielded).toBe(true);

    video.currentTime = 15;
    video.fire('timeupdate');
    expect(apply).not.toHaveBeenCalled();

    video.currentTime = 40;
    video.fire('timeupdate');
    expect(apply).toHaveBeenLastCalledWith(1.8);
    expect(scheduler.hasYielded).toBe(false);
  });

  it('stop removes the listeners and leaves the playback rate untouched', () => {
    scheduler.start(video, rates, apply);
    video.playbackRate = 1.3;
    scheduler.stop();
    expect(video.playbackRate).toBe(1.3);
    expect(video.listenerCount()).toBe(0);
    expect(scheduler.active).toBe(false);
  });
});

describe('ChapterScheduler activeIndex', () => {
  let video: FakeVideo;
  let scheduler: ChapterScheduler;
  let apply: ReturnType<typeof vi.fn<(multiplier: number) => number>>;

  beforeEach(() => {
    video = new FakeVideo();
    scheduler = new ChapterScheduler();
    apply = vi.fn((multiplier: number) => multiplier);
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('tracks the enforced segment; -1 before the first tick and after stop', () => {
    expect(scheduler.activeIndex).toBe(-1);
    scheduler.start(video, rates, apply);
    expect(scheduler.activeIndex).toBe(-1);
    video.currentTime = 40;
    video.fire('timeupdate');
    expect(scheduler.activeIndex).toBe(1);
    video.currentTime = 70;
    video.fire('timeupdate');
    expect(scheduler.activeIndex).toBe(2);
    scheduler.stop();
    expect(scheduler.activeIndex).toBe(-1);
  });
});
