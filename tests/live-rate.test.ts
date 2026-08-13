// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPill,
  liveRateText,
  shouldRefreshLive,
  type LiveRate,
  type PillState,
} from '../ui/pill';

/** Host whose appendChild treats shadow-root attachment as a no-op — same
 * happy-dom workaround as pill.test.ts. */
function shadowHost(): HTMLElement {
  const host = document.createElement('div');
  const append = host.appendChild.bind(host);
  host.appendChild = function <T extends Node>(node: T): T {
    return node instanceof ShadowRoot ? node : append(node);
  };
  return host;
}

function rootOf(host: HTMLElement): ShadowRoot {
  const root = host.shadowRoot;
  if (root === null) throw new Error('expected an open shadow root');
  return root;
}

function state(overrides: Partial<PillState> = {}): PillState {
  return {
    mode: 'recommend',
    rateWpm: 160,
    multiplier: 1.55,
    effectiveWpm: 248,
    tierLabel: 'estimated',
    label: '→ 1.55x ≈ 248 wpm',
    ...overrides,
  };
}

const LIVE: LiveRate = { rate: 248, multiplier: 1.55, unit: 'wpm' };

function liveElOf(host: HTMLElement): HTMLSpanElement {
  const el = rootOf(host).querySelector<HTMLSpanElement>('.live-rate');
  if (el === null) throw new Error('expected a .live-rate element');
  return el;
}

describe('liveRateText', () => {
  it('formats the live line from rate, multiplier and unit', () => {
    expect(liveRateText({ rate: 248, multiplier: 1.55, unit: 'wpm' })).toBe('now ≈ 248 wpm at 1.55x');
  });

  it('rounds the rate and strips trailing zeros from the multiplier', () => {
    expect(liveRateText({ rate: 300.6, multiplier: 2, unit: 'wpm' })).toBe('now ≈ 301 wpm at 2x');
  });

  it('keeps the language unit label', () => {
    expect(liveRateText({ rate: 380, multiplier: 2, unit: 'morae/min' })).toBe('now ≈ 380 morae/min at 2x');
  });
});

describe('shouldRefreshLive (throttle gate)', () => {
  it('only refreshes when the pushed value would change the line', () => {
    expect(shouldRefreshLive(null, null)).toBe(false);
    expect(shouldRefreshLive(null, LIVE)).toBe(true);
    expect(shouldRefreshLive(LIVE, LIVE)).toBe(false);
    expect(shouldRefreshLive(LIVE, { ...LIVE, rate: 300 })).toBe(true);
    expect(shouldRefreshLive(LIVE, { ...LIVE, multiplier: 2 })).toBe(true);
    expect(shouldRefreshLive(LIVE, { ...LIVE, unit: 'cpm' })).toBe(true);
    expect(shouldRefreshLive(LIVE, null)).toBe(true);
  });
});

describe('createPill live-rate line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders the live line in recommend mode and hides it without a rate', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    pill.updateLiveRate(LIVE);

    const live = liveElOf(host);
    expect(live.hidden).toBe(false);
    expect(live.textContent).toBe('now ≈ 248 wpm at 1.55x');
  });

  it('shows the line in warning mode as well', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state({ mode: 'warning', reason: 'above-zone' }));
    pill.updateLiveRate(LIVE);

    expect(liveElOf(host).hidden).toBe(false);
  });

  it('stays hidden in music, unreachable and none modes', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state({ mode: 'music' }));
    pill.updateLiveRate(LIVE);
    expect(liveElOf(host).hidden).toBe(true);

    pill.update(state({ mode: 'unreachable' }));
    pill.updateLiveRate(LIVE);
    expect(liveElOf(host).hidden).toBe(true);

    pill.update(state({ mode: 'none', label: '' }));
    pill.updateLiveRate(LIVE);
    expect(liveElOf(host).hidden).toBe(true);
  });

  it('hides the line when a live-rate update pushes null', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    pill.updateLiveRate(LIVE);
    expect(liveElOf(host).hidden).toBe(false);

    pill.updateLiveRate(null);
    expect(liveElOf(host).hidden).toBe(true);
  });

  it('does not fight the apply flow: a full state update keeps the line', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    pill.updateLiveRate(LIVE);
    // The apply path re-renders the full state with the same mode.
    pill.update(state({ label: '→ 1.55x ≈ 248 wpm (applied)' }));

    const live = liveElOf(host);
    expect(live.hidden).toBe(false);
    expect(live.textContent).toBe('now ≈ 248 wpm at 1.55x');
  });

  it('drops the stale rate when a full update leaves recommend/warning', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    pill.updateLiveRate(LIVE);
    pill.update(state({ mode: 'none', label: '' }));
    expect(liveElOf(host).hidden).toBe(true);

    // Back to recommend without a fresh tick: the stale line must not
    // resurrect itself.
    pill.update(state());
    expect(liveElOf(host).hidden).toBe(true);
  });

  it('throttles: an equal updateLiveRate is a no-op', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    const live = liveElOf(host);

    pill.updateLiveRate(LIVE);
    pill.updateLiveRate(LIVE);
    expect(live.textContent).toBe('now ≈ 248 wpm at 1.55x');
    expect(live.hidden).toBe(false);
  });
});
