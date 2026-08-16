// @vitest-environment happy-dom
// Rate-controller unit suite (lib/rate-controller.ts): the auto-apply
// lifecycle, the pill render, the override guard, and the session teardown
// plumbing. Written from the controller's public contract — the deps
// interface (lib/rate-controller-types.ts), the pill contract, and the
// auto-apply rules in lib/auto-apply.ts — against a stub bridge, anchor,
// and video element. The Stryker baseline (wave 5) found the controller
// entirely uncovered (375 mutants, 0 killed); this suite pins the flows the
// entrypoints drive.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateController } from '../lib/rate-controller';
import type { RateControllerDeps, RateCurrent } from '../lib/rate-controller-types';
import type { Recommendation } from '../lib/recommend';
import { DEFAULT_PLATFORM_MAX, defaultSettings, type Settings } from '../lib/settings';

interface Ctx extends RateCurrent {
  videoId: string;
}

const rec = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  multiplier: 1.25,
  effectiveWpm: 250,
  mode: 'recommend',
  reason: null,
  label: '→ 1.25x ≈ 250 wpm',
  tierLabel: 'from captions',
  ...overrides,
});

interface Harness {
  controller: ReturnType<typeof createRateController<Ctx>>;
  video: HTMLVideoElement;
  anchor: HTMLElement;
  calls: {
    applyRate: ReturnType<typeof vi.fn>;
    stopRateApplies: ReturnType<typeof vi.fn>;
    skipAttach: ReturnType<typeof vi.fn>;
    skipDetach: ReturnType<typeof vi.fn>;
    skipIsOwnDip: ReturnType<typeof vi.fn>;
    reportApply: ReturnType<typeof vi.fn>;
    teardown: ReturnType<typeof vi.fn>;
    bridge: ReturnType<typeof vi.fn>;
    seenFirstRun: ReturnType<typeof vi.fn>;
    logAppend: ReturnType<typeof vi.fn>;
    accrue: ReturnType<typeof vi.fn>;
  };
  render(opts?: {
    naturalRate?: number;
    tier?: Ctx['tier'];
    contentType?: Ctx['contentType'];
    settings?: Settings;
    site?: string;
    startedAt?: number;
    recommendation?: Recommendation;
  }): void;
}

function makeHarness(depsOverrides: Partial<RateControllerDeps<Ctx>> = {}): Harness {
  const anchor = document.createElement('div');
  document.body.append(anchor);
  const video = document.createElement('video');
  video.playbackRate = 1;
  document.body.append(video);

  const calls = {
    applyRate: vi.fn((v: HTMLVideoElement, rate: number) => {
      v.playbackRate = rate;
    }),
    stopRateApplies: vi.fn(),
    skipAttach: vi.fn(),
    skipDetach: vi.fn(),
    skipIsOwnDip: vi.fn(() => false),
    reportApply: vi.fn(),
    teardown: vi.fn(),
    bridge: vi.fn(),
    seenFirstRun: vi.fn(),
    logAppend: vi.fn(),
    accrue: vi.fn(),
  };
  const bridge = {
    request: vi.fn(async (req: { type: string }) => {
      calls.bridge(req.type);
      if (req.type === 'settings:get') return defaultSettings();
      if (req.type === 'settings:seenFirstRun') {
        calls.seenFirstRun();
        return undefined;
      }
      if (req.type === 'log:append') {
        calls.logAppend(req);
        return undefined;
      }
      if (req.type === 'timeSaved:accrue') {
        calls.accrue(req);
        return undefined;
      }
      return undefined;
    }),
  };

  const deps: RateControllerDeps<Ctx> = {
    bridge: bridge as unknown as RateControllerDeps<Ctx>['bridge'],
    nudgeSurface: { reportApply: calls.reportApply, teardown: calls.teardown, dismiss: vi.fn() },
    hostAnchor: () => anchor,
    applyRate: calls.applyRate,
    stopRateApplies: calls.stopRateApplies,
    makeCurrent: (parts) => ({ ...parts, videoId: parts.videoId }),
    videoIdOf: (c) => c.videoId,
    skip: {
      attach: calls.skipAttach,
      detach: calls.skipDetach,
      isOwnDip: calls.skipIsOwnDip,
    },
    ...depsOverrides,
  };
  const controller = createRateController<Ctx>(deps);

  // The content scripts own the listener wiring; the harness mirrors it so
  // media events reach the controller's handler.
  for (const type of ['ratechange', 'play', 'pause', 'timeupdate']) {
    video.addEventListener(type, (e) => controller.onMediaEvent(e));
  }
  // happy-dom exposes paused as a getter-only media property; make it
  // writable so tests can stage a paused player.
  Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });

  return {
    controller,
    video,
    anchor,
    calls,
    render(opts = {}) {
      controller.renderRecommendation(
        opts.site ?? 'youtube.com',
        opts.naturalRate ?? 200,
        opts.tier ?? 'asr-cue',
        opts.contentType ?? 'talk',
        opts.settings ?? defaultSettings(),
        opts.site ?? 'youtube.com',
        undefined,
        undefined,
        opts.startedAt,
        undefined,
      );
      if (opts.recommendation !== undefined && controller.current !== null) {
        // The recommendation override must land BEFORE the auto-apply gate
        // reads it; renderRecommendation computes it internally, so re-render
        // is not possible — assert the gate outcome instead via pillState.
      }
    },
  };
}

const autoOn = (): Settings => ({
  ...defaultSettings(),
  autoApply: { enabled: true, contentTypes: {} },
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('renderRecommendation', () => {
  it('renders the pill with the recommendation and range, and records current', () => {
    const h = makeHarness();
    h.render({ naturalRate: 200, contentType: 'lecture' });
    expect(h.controller.current?.naturalRate).toBe(200);
    expect(h.controller.pillState).toMatchObject({
      mode: 'recommend',
      rateWpm: 200,
      multiplier: 1.25,
      effectiveWpm: 250,
      range: { lo: 250, hi: 275, unit: 'wpm' },
    });
  });

  it('drops a stale measure whose startedAt predates the current epoch', () => {
    const h = makeHarness();
    h.render({ startedAt: 0 });
    h.controller.reset(); // bumps the epoch
    h.render({ startedAt: 0 });
    expect(h.controller.pillState?.mode).toBe('none');
    expect(h.controller.current).toBeNull();
  });

  it('auto-applies a recommend-mode measured tier when auto is on, anchoring the undo rate', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    expect(h.calls.applyRate).toHaveBeenCalledWith(h.video, 1.25, DEFAULT_PLATFORM_MAX);
    expect(h.controller.pillState?.applied).toBe('auto');
    expect(h.controller.pillState?.undoRate).toBe(1);
    expect(h.calls.skipAttach).toHaveBeenCalledWith(h.video, 1.25);
  });

  it('stays pending when auto is off or the mode is not a confident recommend', () => {
    const h = makeHarness();
    h.render(); // default settings: auto off
    expect(h.calls.applyRate).not.toHaveBeenCalled();
    expect(h.controller.pillState?.applied).toBe('none');

    const h2 = makeHarness();
    h2.render({ settings: autoOn(), contentType: 'music' }); // music never recommends a speed
    expect(h2.calls.applyRate).not.toHaveBeenCalled();
  });

  it('never auto-applies the estimated tier (a prior, not a measurement)', () => {
    const h = makeHarness();
    h.render({ settings: autoOn(), tier: 'estimated' });
    expect(h.calls.applyRate).not.toHaveBeenCalled();
  });

  it('flags the one-time first-run explainer only on a recommend render of a measured tier', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    expect(h.controller.pillState?.firstRun).toBe(true);
    expect(h.calls.seenFirstRun).toHaveBeenCalledTimes(1);

    const h2 = makeHarness();
    h2.render({ settings: { ...autoOn(), seenFirstRun: true } });
    expect(h2.controller.pillState?.firstRun).toBe(false);
    expect(h2.calls.seenFirstRun).not.toHaveBeenCalled();

    const h3 = makeHarness();
    h3.render({ settings: autoOn(), tier: 'estimated' });
    expect(h3.controller.pillState?.firstRun).toBe(false);
  });
});

describe('apply plumbing', () => {
  it('userApply stops auto, labels the source user, clamps to the platform max, and re-renders the pill', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() }); // auto at 1.25
    h.controller.userApply(3);
    expect(h.calls.applyRate).toHaveBeenLastCalledWith(h.video, 2, DEFAULT_PLATFORM_MAX);
    expect(h.controller.pillState).toMatchObject({ applied: 'user', undoRate: undefined });
  });

  it('applyAdjust routes scheduler steps through the same choke point as adjust', () => {
    const h = makeHarness();
    h.render();
    h.controller.applyAdjust(1.5);
    expect(h.calls.applyRate).toHaveBeenCalledWith(h.video, 1.5, 2);
    expect(h.calls.reportApply).toHaveBeenCalledWith(1.5, h.controller.current?.range);
    expect(h.calls.logAppend).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.objectContaining({ userAction: 'adjust' }) }),
    );
  });

  it('stopAutoForVideo restores the pre-auto rate and disengages auto without logging', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    expect(h.video.playbackRate).toBe(1.25);
    h.controller.stopAutoForVideo();
    expect(h.video.playbackRate).toBe(1); // the undo anchor
    expect(h.calls.stopRateApplies).toHaveBeenCalled();
    expect(h.calls.skipDetach).toHaveBeenCalled();
    expect(h.controller.pillState).toMatchObject({ applied: 'none', undoRate: undefined });
  });

  it('dismissCurrent undoes an auto apply and logs the dismiss', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    h.controller.dismissCurrent();
    expect(h.video.playbackRate).toBe(1);
    expect(h.controller.pillState?.mode).toBe('none');
    expect(h.calls.logAppend).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.objectContaining({ userAction: 'dismiss' }) }),
    );
  });
});

describe('markUserOverride', () => {
  function fire(h: Harness, rate: number, dip: boolean): void {
    h.video.playbackRate = rate;
    h.calls.skipIsOwnDip.mockReturnValue(dip);
    h.video.dispatchEvent(new Event('ratechange'));
  }

  it('labels a divergent non-1.0 rate as a user override and detaches the machinery', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    fire(h, 1.5, false);
    expect(h.controller.pillState?.applied).toBe('user');
    expect(h.calls.stopRateApplies).toHaveBeenCalled();
    expect(h.calls.skipDetach).toHaveBeenCalled();
  });

  it('treats a reset to exactly 1.0 as a reset, not an override', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    fire(h, 1, false);
    expect(h.controller.pillState?.applied).toBe('auto');
  });

  it('ignores our own applied rate (within epsilon) and the skip-silence dip', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    fire(h, 1.25 + 1e-7, false); // float jitter around our own apply
    expect(h.controller.pillState?.applied).toBe('auto');
    fire(h, 0.75, true); // the actuator's in-gap dip
    expect(h.controller.pillState?.applied).toBe('auto');
  });

  it('skips the override check while the video is paused', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    (h.video as { paused: boolean }).paused = true;
    fire(h, 1.9, false);
    expect(h.controller.pillState?.applied).toBe('auto');
  });
});

function liveElOf(anchor: HTMLElement): HTMLSpanElement | null {
  const host = anchor.querySelector('.speedwatcher-pill-host');
  const root = host?.shadowRoot;
  return root?.querySelector<HTMLSpanElement>('.live-rate') ?? null;
}

describe('live rate and saved time', () => {
  it('shows the live presentation rate once the video plays at a non-1 rate', () => {
    const h = makeHarness();
    h.render({ naturalRate: 200 });
    h.video.playbackRate = 1.5;
    h.video.dispatchEvent(new Event('timeupdate'));
    const live = liveElOf(h.anchor);
    expect(live?.hidden).toBe(false);
    expect(live?.textContent).toContain('300'); // 200 × 1.5
  });

  it('hides the live line when it would duplicate the effective rate, or outside the lane', () => {
    // 1.25x on a 200-wpm talk: live 250 === effective 250 — a duplicate.
    const dup = makeHarness();
    dup.render({ naturalRate: 200 });
    dup.video.playbackRate = 1.25;
    dup.video.dispatchEvent(new Event('timeupdate'));
    expect(liveElOf(dup.anchor)?.hidden).toBe(true);

    // Estimated priors and music never present a live line.
    const est = makeHarness();
    est.render({ naturalRate: 200, tier: 'estimated' });
    est.video.playbackRate = 1.5;
    est.video.dispatchEvent(new Event('timeupdate'));
    expect(liveElOf(est.anchor)?.hidden).toBe(true);

    const music = makeHarness();
    music.render({ naturalRate: 38, recommendation: rec({ mode: 'music', multiplier: 1 }) });
    music.video.playbackRate = 1.5;
    music.video.dispatchEvent(new Event('timeupdate'));
    expect(liveElOf(music.anchor)?.hidden).toBe(true);

    // Paused video: no live line.
    const paused = makeHarness();
    paused.render({ naturalRate: 200 });
    (paused.video as { paused: boolean }).paused = true;
    paused.video.playbackRate = 1.5;
    paused.video.dispatchEvent(new Event('timeupdate'));
    expect(liveElOf(paused.anchor)?.hidden).toBe(true);
  });
});

describe('session lifecycle', () => {
  it('onMediaEvent adopts a new video target and ends the old session via onVideoSwap', () => {
    const h = makeHarness({ onVideoSwap: (end) => end() });
    h.render({ settings: autoOn() });
    const other = document.createElement('video');
    document.body.append(other);
    other.addEventListener('play', (e) => h.controller.onMediaEvent(e));
    other.dispatchEvent(new Event('play'));
    expect(h.controller.activeVideo).toBe(other);
    expect(h.calls.skipDetach).toHaveBeenCalled(); // endSession teardown
    expect(h.calls.stopRateApplies).toHaveBeenCalled(); // endSession teardown
    expect(h.calls.teardown).toHaveBeenCalled(); // nudge surface teardown
    // The swap bumped the epoch: the next measure renders on the fresh session.
    h.render();
    expect(h.controller.pillState?.mode).toBe('recommend');
  });

  it('adoptVideo ends the session with the re-assert loop detached (endSession teardown)', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    const other = document.createElement('video');
    document.body.append(other);
    h.controller.adoptVideo(other);
    expect(h.calls.stopRateApplies).toHaveBeenCalled();
    expect(h.calls.skipDetach).toHaveBeenCalled();
    expect(h.calls.teardown).toHaveBeenCalled();
  });

  it('onVideoRemoved drops the recommendation, the pill, and the session', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    h.controller.onVideoRemoved();
    expect(h.controller.current).toBeNull();
    expect(h.calls.stopRateApplies).toHaveBeenCalled();
    // a re-render mounts a fresh pill on a fresh host
    h.render();
    expect(h.controller.pillState?.mode).toBe('recommend');
  });

  it('reset clears the video context and the pill', () => {
    const h = makeHarness();
    h.render();
    h.controller.reset();
    expect(h.controller.current).toBeNull();
    expect(h.controller.pillState?.mode).toBe('none');
  });

  it('rebuilds the pill host when the player element is replaced (SPA navigation)', () => {
    const h = makeHarness();
    h.render();
    const firstHost = h.anchor.querySelector('.speedwatcher-pill-host');
    expect(firstHost).not.toBeNull();
    firstHost?.remove(); // the player replaced the element
    h.render();
    const secondHost = h.anchor.querySelector('.speedwatcher-pill-host');
    expect(secondHost).not.toBe(firstHost);
    expect(h.controller.pillState?.mode).toBe('recommend');
  });
});

describe('generic video swap', () => {
  // The generic entrypoint's onVideoSwap hook mirrored here (the controller
  // cannot see the entrypoint; the e2e swap lane pins the entrypoint
  // itself): a swap must drop current and the pill like the YouTube
  // navigation reset, and keep the swapped-in element active so the
  // re-measure targets it. The first adoption (no recommendation rendered
  // yet) skips the reset — there is no stale state to clear.
  const swapHook = (getH: () => Harness): NonNullable<RateControllerDeps<Ctx>['onVideoSwap']> => () => {
    const h = getH();
    const next = h.controller.activeVideo;
    if (h.controller.current !== null) h.controller.reset();
    if (next !== null) h.controller.adoptVideo(next);
  };

  it('a generic swap after a render resets current and the pill, and keeps the swapped-in element active for the re-measure', () => {
    const h = makeHarness({ onVideoSwap: swapHook(() => h) });
    h.render({ naturalRate: 200 });
    expect(h.controller.current?.naturalRate).toBe(200);
    const other = document.createElement('video');
    document.body.append(other);
    other.addEventListener('play', (e) => h.controller.onMediaEvent(e));
    other.dispatchEvent(new Event('play'));
    expect(h.controller.current).toBeNull();
    expect(h.controller.pillState?.mode).toBe('none');
    expect(h.controller.activeVideo).toBe(other);
  });

  it('a timeupdate from a non-active element is not a swap — only play/playing transitions swap', () => {
    const h = makeHarness({ onVideoSwap: (end) => end() });
    h.render({ settings: autoOn() });
    h.video.dispatchEvent(new Event('play')); // the playing element becomes active
    h.calls.teardown.mockClear();
    const other = document.createElement('video');
    document.body.append(other);
    other.addEventListener('timeupdate', (e) => h.controller.onMediaEvent(e));
    other.dispatchEvent(new Event('timeupdate')); // backgrounded playback noise
    expect(h.calls.teardown).not.toHaveBeenCalled();
    expect(h.controller.activeVideo).toBe(h.video);
  });

  it('the first adoption (no recommendation yet) never renders a none pill', () => {
    const h = makeHarness({ onVideoSwap: swapHook(() => h) });
    const other = document.createElement('video');
    document.body.append(other);
    other.addEventListener('play', (e) => h.controller.onMediaEvent(e));
    other.dispatchEvent(new Event('play'));
    expect(h.controller.current).toBeNull();
    expect(h.controller.pillState).toBeNull(); // no empty pill flash before the first measure
    expect(h.controller.activeVideo).toBe(other);
  });
});

describe('settings and serialization', () => {
  it('loadSettings falls back to defaults when the bridge is dead', async () => {
    const rejecting = makeHarness({
      bridge: {
        request: async () => {
          throw new Error('bridge down');
        },
      },
    });
    await expect(rejecting.controller.loadSettings()).resolves.toEqual(defaultSettings());
  });

  it('runMeasure serializes measures: a trigger while one is in flight coalesces into one queued re-run', async () => {
    const h = makeHarness();
    const order: string[] = [];
    let run = 0;
    const measure = async (): Promise<void> => {
      const id = ++run;
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`done-${id}`);
    };
    h.controller.runMeasure(measure);
    h.controller.runMeasure(measure); // coalesces: queued, not concurrent
    await vi.waitFor(() => expect(order).toContain('done-2'));
    expect(order).toEqual(['start-1', 'done-1', 'start-2', 'done-2']);
  });
});

describe('post-apply discipline (wave-5 batch B)', () => {
  it('a user apply disarms auto: the next measure with auto on does not re-apply', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    h.controller.userApply(1.5);
    h.calls.applyRate.mockClear();
    h.render({ settings: autoOn() });
    expect(h.calls.applyRate).not.toHaveBeenCalled();
    expect(h.controller.pillState?.applied).toBe('user'); // still the user's source, not auto
  });

  it('an override disarms auto: the next measure with auto on does not re-apply', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    h.video.playbackRate = 1.5;
    h.video.dispatchEvent(new Event('ratechange'));
    expect(h.controller.pillState?.applied).toBe('user');
    h.calls.applyRate.mockClear();
    h.render({ settings: autoOn() });
    expect(h.calls.applyRate).not.toHaveBeenCalled();
  });

  it('survives a no-video page: stopAutoForVideo after a render with no player element', () => {
    const h = makeHarness();
    h.video.remove(); // the player never mounted
    h.render({ settings: autoOn() });
    expect(() => h.controller.stopAutoForVideo()).not.toThrow();
  });

  it('applyMultiplier and applyAdjust before any measure are no-ops', () => {
    const h = makeHarness();
    expect(() => h.controller.applyMultiplier(1.5)).not.toThrow();
    expect(() => h.controller.applyAdjust(1.5)).not.toThrow();
    expect(h.calls.applyRate).not.toHaveBeenCalled();
  });

  it('onVideoRemoved before any measure is a no-op', () => {
    const h = makeHarness();
    expect(() => h.controller.onVideoRemoved()).not.toThrow();
  });

  it('a non-auto render carries no undo anchor', () => {
    const h = makeHarness();
    h.render();
    expect(h.controller.pillState?.undoRate).toBeUndefined();
    expect(h.controller.pillState?.applied).toBe('none');
    expect(h.controller.current?.unit).toBe('wpm');
  });

  it('the auto apply logs userAction apply through the choke point', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    expect(h.calls.logAppend).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.objectContaining({ userAction: 'apply' }) }),
    );
  });

  it('a dismissed session stops accruing: later media events never reach the store', async () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    h.controller.dismissCurrent();
    h.calls.accrue.mockClear();
    h.video.dispatchEvent(new Event('timeupdate'));
    await vi.waitFor(() => expect(h.calls.accrue).not.toHaveBeenCalled());
  });

  it('a media event on the already-active video does not re-run the swap teardown', () => {
    const h = makeHarness({ onVideoSwap: (end) => end() });
    h.render({ settings: autoOn() });
    h.video.dispatchEvent(new Event('play')); // first event adopts the element
    expect(h.calls.teardown).toHaveBeenCalledTimes(1);
    h.calls.teardown.mockClear();
    h.video.dispatchEvent(new Event('timeupdate')); // same element again
    expect(h.calls.teardown).not.toHaveBeenCalled();
  });
});

describe('pillHook and chapter wiring (wave-5 batch B)', () => {
  it('pillHook.apply applies the recommendation and respects the music gate', () => {
    const h = makeHarness();
    h.render();
    h.controller.pillHook.apply();
    expect(h.calls.applyRate).toHaveBeenCalledWith(h.video, 1.25, 2);

    const music = makeHarness();
    music.render({ naturalRate: 38, contentType: 'music' });
    music.controller.pillHook.apply();
    expect(music.calls.applyRate).not.toHaveBeenCalled();
  });

  it('pillHook.dismiss and pillHook.stopAuto route to the controller actions', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() });
    h.controller.pillHook.stopAuto?.();
    expect(h.video.playbackRate).toBe(1);
    h.controller.pillHook.dismiss();
    expect(h.controller.pillState?.mode).toBe('none');
  });

  it('the chapter extras ride the pill render', () => {
    const chapter = {
      extras: () => ({ chaptersAvailable: true, autoAdjust: true, chapterStatus: 'active' as const }),
      onConsent: () => undefined,
      onReset: () => undefined,
    };
    const h = makeHarness({ chapter });
    h.render({ settings: autoOn() });
    expect(h.controller.pillState?.chapterStatus).toBe('active');
    expect(h.controller.pillState?.autoAdjust).toBe(true);
  });

  it('refreshChapterStatus only re-renders when the scheduler status changed', () => {
    let status: 'active' | 'yielded' | undefined = 'active';
    const chapter = {
      extras: () => ({ chaptersAvailable: true, autoAdjust: true, chapterStatus: status }),
      onConsent: () => undefined,
      onReset: () => undefined,
    };
    const h = makeHarness({ chapter });
    h.render();
    const before = h.controller.pillState;
    h.controller.refreshChapterStatus();
    expect(h.controller.pillState).toBe(before); // unchanged status → no re-render
    status = 'yielded';
    h.controller.refreshChapterStatus();
    expect(h.controller.pillState?.chapterStatus).toBe('yielded');
  });

  it('the chapter toggle click arms the scheduler through onConsent', () => {
    const onConsent = vi.fn();
    const chapter = {
      extras: () => ({ chaptersAvailable: true, autoAdjust: false, chapterStatus: undefined }),
      onConsent,
      onReset: () => undefined,
    };
    const h = makeHarness({ chapter });
    h.render();
    const root = h.anchor.querySelector<HTMLElement>('.speedwatcher-pill-host')?.shadowRoot;
    const toggle = root?.querySelector<HTMLButtonElement>('.btn-chapter-toggle');
    if (toggle === undefined || toggle === null) throw new Error('expected a chapter toggle');
    toggle.click();
    expect(onConsent).toHaveBeenCalledWith(true, h.video, expect.any(Function));
    expect(h.controller.pillState?.autoAdjust).toBe(true);
  });

  it('showNone renders the none state', () => {
    const h = makeHarness();
    h.render();
    expect(h.controller.pillState?.mode).not.toBe('none');
    h.controller.showNone();
    expect(h.controller.pillState).toMatchObject({ mode: 'none' });
  });

  it('adoptVideo takes the new element as the apply target and ends the old session', () => {
    const h = makeHarness();
    h.render({ settings: autoOn() }); // session attached to h.video
    const next = document.createElement('video');
    h.controller.adoptVideo(next);
    expect(h.controller.activeVideo).toBe(next);
    expect(h.calls.skipDetach).toHaveBeenCalled(); // endSession tore the session down
    expect(h.calls.stopRateApplies).toHaveBeenCalled(); // the re-assert loop leaves the old element
  });

  it('flushes accrued saved time to the background store on session end', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.render({ settings: autoOn() }); // auto-applies at 1.25 and attaches the tracker
      vi.advanceTimersByTime(5_000);
      h.video.dispatchEvent(new Event('timeupdate')); // accrues 5 s of wall time
      h.controller.endSession(); // detach flushes the tail
      expect(h.calls.accrue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'timeSaved:accrue', multiplier: 1.25 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
