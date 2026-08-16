// @vitest-environment happy-dom
// Seam specs for the pill-parts exports (ui/pill-parts.ts): watchTheme's
// prefers-color-scheme listener and bootstrapLocale's bridge round-trip,
// driven directly in the happy-dom environment. The re-render contract is
// asserted through createPill (the wiring that consumes both seams).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLocale, watchTheme } from '../ui/pill-parts';
import { createPill, type PillState } from '../ui/pill';
import { BRIDGE_CHANNEL } from '../lib/messaging';
import { defaultSettings } from '../lib/settings';

/** Controllable matchMedia stand-in: watchTheme's listener registration
 * and firing run for real against the stub — happy-dom's own MQL never
 * flips its matched value at runtime. */
function mqlStub(initial: boolean): {
  matches: boolean;
  listeners: ((e: { matches: boolean }) => void)[];
  addEventListener: (type: string, cb: (e: { matches: boolean }) => void) => void;
  removeEventListener: (type: string, cb: (e: { matches: boolean }) => void) => void;
  fire: (matches: boolean) => void;
} {
  const stub = {
    matches: initial,
    listeners: [] as ((e: { matches: boolean }) => void)[],
    addEventListener(_type: string, cb: (e: { matches: boolean }) => void): void {
      stub.listeners.push(cb);
    },
    removeEventListener(_type: string, cb: (e: { matches: boolean }) => void): void {
      stub.listeners = stub.listeners.filter((l) => l !== cb);
    },
    fire(matches: boolean): void {
      stub.matches = matches;
      for (const cb of [...stub.listeners]) cb({ matches });
    },
  };
  return stub;
}

/** Speaks the bridge wire protocol on the window: answers every
 * settings:get request with the given settings object. */
function answerBridge(win: Window, settings: Record<string, unknown>): void {
  win.addEventListener('message', (event: MessageEvent) => {
    const envelope = event.data as {
      channel?: string;
      direction?: string;
      payload?: { id?: number };
    };
    if (envelope.channel !== BRIDGE_CHANNEL || envelope.direction !== 'request') return;
    win.postMessage(
      { channel: BRIDGE_CHANNEL, direction: 'response', payload: { id: envelope.payload?.id, ok: true, result: settings } },
      '*',
    );
  });
}

// The pill's shadow root is open (accessibility: closed roots are invisible
// to assistive tech), so tests reach the surface through host.shadowRoot.
// happy-dom 20 relocates the root's children into the host instead of
// attaching it; the override keeps the root attached like real browsers.
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
    tierLabel: 'from captions',
    label: '→ 1.55x ≈ 248 wpm',
    ...overrides,
  };
}

describe('watchTheme', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('re-injects the dark stylesheet when prefers-color-scheme flips', () => {
    const mql = mqlStub(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const style = rootOf(host).querySelector('style');
    if (style === null) throw new Error('expected the pill stylesheet');
    expect(style.textContent).toContain('#212529'); // LIGHT text token
    mql.fire(true);
    expect(style.textContent).toContain('#e8eaed'); // DARK text token
    mql.fire(false);
    expect(style.textContent).toContain('#212529');
  });

  it('calls onDark on change and stops after the disposer runs', () => {
    const mql = mqlStub(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);
    const onDark = vi.fn();
    const dispose = watchTheme(document, document.createElement('style'), onDark);
    mql.fire(true);
    expect(onDark).toHaveBeenCalledWith(true);
    dispose();
    mql.fire(false);
    expect(onDark).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrapLocale', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('skips the bridge round-trip when the caller pinned a locale', () => {
    const requests: unknown[] = [];
    const listener = (event: MessageEvent): void => {
      const envelope = event.data as { channel?: string; direction?: string };
      if (envelope.channel === BRIDGE_CHANNEL && envelope.direction === 'request') {
        requests.push(envelope);
      }
    };
    window.addEventListener('message', listener);
    const onResolved = vi.fn();
    bootstrapLocale({ locale: 'en' }, document.body, onResolved);
    expect(onResolved).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    window.removeEventListener('message', listener);
  });

  it('resolves settings.uiLanguage through the bridge and reports it', async () => {
    answerBridge(window, { ...defaultSettings(), uiLanguage: 'ru' });
    const onResolved = vi.fn();
    bootstrapLocale(undefined, document.body, onResolved);
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledWith('ru'));
  });

  it('re-renders the pill in the resolved locale when it arrives late', async () => {
    answerBridge(window, { ...defaultSettings(), uiLanguage: 'ru' });
    const host = shadowHost();
    const pill = createPill(host, {}, {}); // no pinned locale → bridge round-trip
    pill.mount();
    pill.update(state());
    const label = rootOf(host).querySelector('.label');
    if (label === null) throw new Error('expected the label element');
    expect(label.textContent).toBe('→ 1.55x ≈ 248 wpm'); // browser-language seed
    await vi.waitFor(() => {
      expect(label.textContent).toBe('→ 1,55× ≈ 248 слов/мин');
    });
  });
});
