import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Segment } from '../lib/captions';
import { RateReapplier, type VideoLike } from '../lib/matcher';
import { mockStorage } from './fixtures/helpers';
import {
  DEFAULT_MIN_GAP_SEC,
  MAX_PAUSE_RATE,
  MIN_GAP_SEC,
  MIN_PAUSE_RATE,
  SkipSilenceActuator,
  SkipSilenceStore,
  buildGapIndex,
  defaultSkipSilence,
  gapForTime,
  normalizeSkipSilence,
  pauseRateFor,
  resolveSkipSilence,
  shouldSkip,
  type GapSpan,
  type SkipVideo,
} from '../lib/skip-silence';

function seg(startSec: number, text = 'word'): Segment {
  return { text, startSec };
}

describe('buildGapIndex', () => {
  it('emits spans only for inter-start gaps >= minGapSec', () => {
    const items = [seg(0), seg(1.2), seg(2.7), seg(3.9)];
    expect(buildGapIndex(items, 1.5)).toEqual([{ start: 1.2, end: 2.7 }]);
  });

  it('includes a gap exactly at minGapSec and excludes sub-threshold ones', () => {
    const items = [seg(0), seg(1.5), seg(2.9), seg(4.4)];
    expect(buildGapIndex(items, 1.5)).toEqual([
      { start: 0, end: 1.5 },
      { start: 2.9, end: 4.4 },
    ]);
  });

  it('skips out-of-order deltas but keeps later valid gaps', () => {
    // The 5 → 3 delta is negative (never a gap); the 3 → 6.5 and
    // 6.5 → 8 deltas both clear the threshold.
    const items = [seg(5), seg(3), seg(6.5), seg(8)];
    expect(buildGapIndex(items, 1.5)).toEqual([
      { start: 3, end: 6.5 },
      { start: 6.5, end: 8 },
    ]);
  });

  it('returns [] for fewer than two items', () => {
    expect(buildGapIndex([], 1.5)).toEqual([]);
    expect(buildGapIndex([seg(0)], 1.5)).toEqual([]);
  });
});

describe('gapForTime', () => {
  const index: GapSpan[] = [
    { start: 1.2, end: 2.7 },
    { start: 10, end: 14 },
  ];

  it('returns the containing span for a time inside a gap', () => {
    expect(gapForTime(index, 1.2)).toEqual({ start: 1.2, end: 2.7 });
    expect(gapForTime(index, 2.0)).toEqual({ start: 1.2, end: 2.7 });
    expect(gapForTime(index, 13.999)).toEqual({ start: 10, end: 14 });
  });

  it('returns null at and past the gap end, and before its start', () => {
    expect(gapForTime(index, 2.7)).toBeNull();
    expect(gapForTime(index, 14)).toBeNull();
    expect(gapForTime(index, 1.199)).toBeNull();
    expect(gapForTime(index, 0)).toBeNull();
  });

  it('returns null for an empty index', () => {
    expect(gapForTime([], 5)).toBeNull();
  });
});

describe('shouldSkip', () => {
  it('is false when the toggle is off even with skimmable gaps', () => {
    const cues = [seg(0), seg(3), seg(6)];
    expect(shouldSkip(cues, defaultSkipSilence())).toBe(false);
  });

  it('is true when on and a gap >= minGapSec exists', () => {
    const cues = [seg(0), seg(1.2), seg(2.7)];
    expect(shouldSkip(cues, { ...defaultSkipSilence(), enabled: true })).toBe(true);
  });

  it('is false when on but every gap is below minGapSec', () => {
    const cues = [seg(0), seg(1.2), seg(2.4)];
    expect(shouldSkip(cues, { ...defaultSkipSilence(), enabled: true })).toBe(false);
  });
});

describe('normalizeSkipSilence', () => {
  it('defaults to off with the skimmable gap and pause-rate defaults', () => {
    expect(defaultSkipSilence()).toEqual({ enabled: false, minGapSec: 1.5, pauseRate: 1.1 });
    expect(normalizeSkipSilence(undefined)).toEqual(defaultSkipSilence());
    expect(normalizeSkipSilence('garbage')).toEqual(defaultSkipSilence());
  });

  it('treats anything but true as off (strict consent)', () => {
    expect(normalizeSkipSilence({ enabled: 'yes' }).enabled).toBe(false);
    expect(normalizeSkipSilence({ enabled: true }).enabled).toBe(true);
  });

  it('floors minGapSec at the shared 1 s convention and caps it at 60', () => {
    expect(normalizeSkipSilence({ minGapSec: 0.2 }).minGapSec).toBe(MIN_GAP_SEC);
    expect(normalizeSkipSilence({ minGapSec: 3 }).minGapSec).toBe(3);
    expect(normalizeSkipSilence({ minGapSec: 120 }).minGapSec).toBe(60);
  });

  it('clamps pauseRate into [1, 1.3]', () => {
    expect(normalizeSkipSilence({ pauseRate: 0.5 }).pauseRate).toBe(MIN_PAUSE_RATE);
    expect(normalizeSkipSilence({ pauseRate: 2 }).pauseRate).toBe(MAX_PAUSE_RATE);
    expect(normalizeSkipSilence({ pauseRate: 1.15 }).pauseRate).toBe(1.15);
  });
});

describe('resolveSkipSilence', () => {
  it('keeps the global prefs without a site override', () => {
    expect(resolveSkipSilence(defaultSkipSilence(), undefined)).toEqual(defaultSkipSilence());
  });

  it('replaces the enabled flag when the site override names one', () => {
    const on = resolveSkipSilence(defaultSkipSilence(), { skipSilence: true });
    expect(on.enabled).toBe(true);
    expect(on.minGapSec).toBe(DEFAULT_MIN_GAP_SEC);
    expect(resolveSkipSilence({ ...defaultSkipSilence(), enabled: true }, { skipSilence: false }).enabled).toBe(false);
  });
});

describe('pauseRateFor', () => {
  it('clamps into [1, min(applied, 1.3)]', () => {
    expect(pauseRateFor(1.5, defaultSkipSilence())).toBe(1.1);
    expect(pauseRateFor(1.5, { ...defaultSkipSilence(), pauseRate: 2 })).toBe(1.3);
    expect(pauseRateFor(1.5, { ...defaultSkipSilence(), pauseRate: 0.8 })).toBe(1);
    expect(pauseRateFor(1.05, defaultSkipSilence())).toBe(1.05); // never above applied
  });
});

describe('SkipSilenceStore', () => {
  it('round-trips prefs through storage', async () => {
    const store = new SkipSilenceStore(mockStorage());
    const prefs = { enabled: true, minGapSec: 2, pauseRate: 1.2 };
    await store.save(prefs);
    expect(await store.load()).toEqual(prefs);
  });

  it('normalizes malformed storage to defaults', async () => {
    const store = new SkipSilenceStore(mockStorage({ 'sw.skipSilence': { enabled: 1 } }));
    expect(await store.load()).toEqual(defaultSkipSilence());
    expect(await new SkipSilenceStore(mockStorage()).load()).toEqual(defaultSkipSilence());
  });

  it('update mutates and persists', async () => {
    const store = new SkipSilenceStore(mockStorage());
    await store.update((prefs) => ({ ...prefs, enabled: true }));
    expect((await store.load()).enabled).toBe(true);
  });
});

function fakeVideo(rate = 1, at = 0): SkipVideo & { listeners: Record<string, EventListener[]> } {
  const listeners: Record<string, EventListener[]> = {};
  return {
    playbackRate: rate,
    currentTime: at,
    addEventListener: (type, listener) => {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener: (type, listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    },
    listeners,
  };
}

function tick(video: SkipVideo & { listeners: Record<string, EventListener[]> }): void {
  for (const listener of video.listeners['timeupdate'] ?? []) listener(new Event('timeupdate'));
}

describe('SkipSilenceActuator', () => {
  const index: GapSpan[] = [{ start: 2, end: 5 }];
  const prefs = { enabled: true, minGapSec: 1.5, pauseRate: 1.1 };

  it('dips to the pause rate inside a gap and restores the base outside', () => {
    const video = fakeVideo(1.5);
    const actuator = new SkipSilenceActuator();
    actuator.attach(video, index, prefs, 1.5);
    expect(actuator.active).toBe(true);
    video.currentTime = 3; // inside [2, 5)
    tick(video);
    expect(video.playbackRate).toBe(1.1);
    expect(actuator.inGapNow).toBe(true);
    video.currentTime = 1; // outside
    tick(video);
    expect(video.playbackRate).toBe(1.5);
    expect(actuator.inGapNow).toBe(false);
  });

  it('reports gap transitions through onChange and stays silent on no-ops', () => {
    const video = fakeVideo(1.5);
    const onChange = vi.fn();
    const actuator = new SkipSilenceActuator();
    actuator.attach(video, index, prefs, 1.5, onChange);
    video.currentTime = 3;
    tick(video);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    tick(video); // still in the gap: no second transition
    expect(onChange).toHaveBeenCalledTimes(1);
    video.currentTime = 1;
    tick(video);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('never writes over a user manual rate (sentinel semantics)', () => {
    const video = fakeVideo(1.8);
    const actuator = new SkipSilenceActuator();
    actuator.attach(video, index, prefs, 1.5);
    video.currentTime = 3;
    tick(video);
    expect(video.playbackRate).toBe(1.8);
    video.currentTime = 1;
    tick(video);
    expect(video.playbackRate).toBe(1.8);
  });

  it('treats an exactly-1.0 reset as ours and writes the target', () => {
    const video = fakeVideo(1);
    const actuator = new SkipSilenceActuator();
    actuator.attach(video, index, prefs, 1.5);
    video.currentTime = 3;
    tick(video);
    expect(video.playbackRate).toBe(1.1);
    video.currentTime = 1;
    tick(video);
    expect(video.playbackRate).toBe(1.5);
  });

  it('is a no-op attach when the dip would equal the base rate', () => {
    const video = fakeVideo(1.05);
    const actuator = new SkipSilenceActuator();
    actuator.attach(video, index, prefs, 1.05);
    expect(actuator.active).toBe(false);
    video.currentTime = 3;
    tick(video);
    expect(video.playbackRate).toBe(1.05);
  });

  it('detach stops listening and leaves the rate untouched', () => {
    const video = fakeVideo(1.5);
    const actuator = new SkipSilenceActuator();
    actuator.attach(video, index, prefs, 1.5);
    video.currentTime = 3;
    tick(video);
    expect(video.playbackRate).toBe(1.1);
    actuator.detach();
    expect(actuator.active).toBe(false);
    expect(video.listeners['timeupdate'] ?? []).toHaveLength(0);
    video.currentTime = 1;
    tick(video);
    expect(video.playbackRate).toBe(1.1); // untouched
  });

  it('attach replaces any previous attachment', () => {
    const first = fakeVideo(1.5);
    const second = fakeVideo(1.5);
    const actuator = new SkipSilenceActuator();
    actuator.attach(first, index, prefs, 1.5);
    actuator.attach(second, index, prefs, 1.5);
    expect(first.listeners['timeupdate'] ?? []).toHaveLength(0);
    expect(second.listeners['timeupdate'] ?? []).toHaveLength(1);
  });
});

describe('skip-silence × reapplier composition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function comboVideo(rate = 1.5): SkipVideo &
    VideoLike & { fire: (type: string) => void } {
    const listeners: Record<string, EventListener[]> = {};
    return {
      playbackRate: rate,
      currentTime: 0,
      paused: false,
      isConnected: true,
      addEventListener: (type, listener) => {
        (listeners[type] ??= []).push(listener);
      },
      removeEventListener: (type, listener) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
      },
      fire: (type) => {
        for (const listener of listeners[type] ?? []) listener(new Event(type));
      },
    };
  }

  it('never dips to 1.0 with pauseRate at the floor: the rate stays steady in every gap', () => {
    const video = comboVideo();
    const reapplier = new RateReapplier();
    reapplier.start(video, 1.5, 2);
    reapplier.setRates(1.5, 1.0);
    const actuator = new SkipSilenceActuator();
    actuator.attach(
      video,
      [{ start: 2, end: 5 }],
      { enabled: true, minGapSec: 1.5, pauseRate: MIN_PAUSE_RATE },
      1.5,
    );
    expect(actuator.active).toBe(false); // the 1.0 pause is the reset sentinel — no dip to perform
    video.currentTime = 3; // inside the gap
    for (let i = 0; i < 5; i++) {
      video.fire('timeupdate');
      expect(video.playbackRate).toBe(1.5); // never written 1.0
      video.fire('ratechange'); // a 1.0 write would re-assert the base here
      expect(video.playbackRate).toBe(1.5);
    }
    video.currentTime = 1; // outside the gap
    video.fire('timeupdate');
    expect(video.playbackRate).toBe(1.5);
    reapplier.stop();
  });
});
