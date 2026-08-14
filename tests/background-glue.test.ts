import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import backgroundModule, { ALLOWED_PROVIDER_IDS } from '../entrypoints/background';
import { chromeMock } from './chrome-mock';

const EXTENSION_ID = 'abcdefghijklmnop';
const OFFSCREEN_URL = `chrome-extension://${EXTENSION_ID}/offscreen.html`;

type BackgroundListener = (
  message: unknown,
  sender: { tab?: { id?: number } },
  sendResponse: (response?: unknown) => void,
) => boolean;

beforeEach(() => {
  vi.clearAllMocks();
  chromeMock.runtime.getURL.mockReturnValue(OFFSCREEN_URL);
  chromeMock.tabs.query.mockResolvedValue([{ id: 5 }]);
  chromeMock.tabCapture.getMediaStreamId.mockResolvedValue('stream-1');
  chromeMock.runtime.getContexts.mockResolvedValue([]);
  chromeMock.offscreen.createDocument.mockResolvedValue(undefined);
  chromeMock.storage.session.get.mockResolvedValue({});
  chromeMock.storage.session.set.mockResolvedValue(undefined);
  chromeMock.storage.session.remove.mockResolvedValue(undefined);
  chromeMock.runtime.sendMessage.mockResolvedValue({ received: true });
  // The id-guard consults hasListener; clearAllMocks resets calls but not
  // implementations, so the default must be re-established per test.
  chromeMock.contextMenus.onClicked.hasListener.mockReturnValue(false);
});

function driveMessage(listener: BackgroundListener, message: unknown, senderTabId?: number): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, { tab: senderTabId === undefined ? undefined : { id: senderTabId } }, resolve);
  });
}

function registeredListener(): BackgroundListener {
  const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]?.[0] as
    | BackgroundListener
    | undefined;
  if (!listener) throw new Error('no background listener registered');
  return listener;
}

function installLocalStorage(): Map<string, unknown> {
  const storageData = new Map<string, unknown>();
  chromeMock.storage.local.get.mockImplementation(async (key: string) => ({
    [key]: storageData.get(key),
  }));
  chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) storageData.set(key, value);
  });
  return storageData;
}

describe('background wiring', () => {
  it('registers the message listener and drives a start through the chrome APIs', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const response = await driveMessage(listener, { kind: 'probe-start' }, 3);

    expect(chromeMock.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 5 });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledWith({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: expect.any(String),
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      kind: 'offscreen-start',
      streamId: 'stream-1',
    });
    expect(response).toMatchObject({ state: 'starting', tabId: 5 });
  });

  it('leaves bounced offscreen messages unanswered', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const returned = listener({ kind: 'offscreen-start', streamId: 'x' }, { tab: { id: 1 } }, vi.fn());
    expect(returned).toBe(false);
    const also = listener({ kind: 'offscreen-stop' }, { tab: { id: 1 } }, vi.fn());
    expect(also).toBe(false);
  });

  it('routes a stop through to the offscreen document', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    await driveMessage(listener, { kind: 'probe-start' }, 3);
    const response = await driveMessage(listener, { kind: 'probe-stop' });

    expect(response).toMatchObject({ state: 'idle' });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'offscreen-stop' });
    expect(chromeMock.storage.session.remove).toHaveBeenCalledWith('probeCapture');
  });

  it('wires the action click to a capture of the clicked tab', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const click = chromeMock.action.onClicked.addListener.mock.calls[0]?.[0] as
      | ((tab: { id?: number }) => void)
      | undefined;
    if (!click) throw new Error('no action click listener registered');

    click({ id: 9 });
    await vi.waitFor(() => {
      expect(chromeMock.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 9 });
    });
    const listener = registeredListener();
    await driveMessage(listener, { kind: 'offscreen-event', event: 'started' });
    expect(await driveMessage(listener, { kind: 'probe-state' })).toMatchObject({
      state: 'capturing',
      tabId: 9,
    });
  });

  it('answers demand:increment through its single DemandStore (lib-11#3 single writer)', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const response = await driveMessage(listener, { type: 'demand:increment', contentType: 'generic' });

    expect(response).toMatchObject({ estimatedCount: 1, byContentType: { generic: 1 } });
  });

  it('serializes concurrent increments from two frames without loss', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    // Two frames (sender tabs 1 and 2) race their increments; the single
    // background-owned chain serializes them so neither get→set interleaves.
    const [a, b] = await Promise.all([
      driveMessage(listener, { type: 'demand:increment', contentType: 'generic' }, 1),
      driveMessage(listener, { type: 'demand:increment', contentType: 'talk' }, 2),
    ]);
    expect(a).toMatchObject({ estimatedCount: 1, byContentType: { generic: 1 } });
    expect(b).toMatchObject({ estimatedCount: 2, byContentType: { generic: 1, talk: 1 } });
  });

  it('answers nudge:recordApply through its single NudgeStore (lib-16 single writer)', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const first = await driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 });
    expect(first).toEqual({ show: false });
    await driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 });
    const third = await driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 });
    expect(third).toEqual({ show: true });
  });

  it('serializes concurrent nudge:recordApply from two frames without loss', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    // Three frames race their applies; the background-owned chain counts
    // them in order, so exactly the third lands the show.
    const [a, b, c] = await Promise.all([
      driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 }, 1),
      driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 }, 2),
      driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 }, 3),
    ]);
    expect(a).toEqual({ show: false });
    expect(b).toEqual({ show: false });
    expect(c).toEqual({ show: true });
  });

  it('applies a nudge:dismiss cooldown: subsequent applies do not show', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const dismissed = await driveMessage(listener, { type: 'nudge:dismiss', forever: false });
    expect(dismissed).toMatchObject({ highApplied: 0, dismissedUntil: expect.any(Number) });
    await driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 });
    await driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 });
    const third = await driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 });
    expect(third).toEqual({ show: false });
  });

  it('applies a permanent nudge:dismiss: applies never show again', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const dismissed = await driveMessage(listener, { type: 'nudge:dismiss', forever: true });
    expect(dismissed).toMatchObject({ highApplied: 0, dismissedForever: true });
    for (let i = 0; i < 3; i++) {
      const response = await driveMessage(listener, { type: 'nudge:recordApply', multiplier: 1.6 });
      expect(response).toEqual({ show: false });
    }
  });

  it('drops malformed nudge messages without answering (shape guards)', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const sendResponse = vi.fn();
    expect(listener({ type: 'nudge:recordApply', multiplier: 50 }, { tab: { id: 1 } }, sendResponse)).toBe(false);
    expect(listener({ type: 'nudge:recordApply', multiplier: 'fast' }, { tab: { id: 1 } }, sendResponse)).toBe(false);
    expect(listener({ type: 'nudge:dismiss', forever: 'yes' }, { tab: { id: 1 } }, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('answers timeSaved:accrue through its single TimeSavedStore', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const response = await driveMessage(listener, {
      type: 'timeSaved:accrue',
      deltaSec: 60,
      multiplier: 2,
    });

    expect(response).toBe(30);
  });

  it('serializes concurrent timeSaved:accrue from two frames without loss', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    // Two frames race their accrues; the single background-owned chain
    // serializes them so neither get→set interleaves.
    const [a, b] = await Promise.all([
      driveMessage(listener, { type: 'timeSaved:accrue', deltaSec: 60, multiplier: 2 }, 1),
      driveMessage(listener, { type: 'timeSaved:accrue', deltaSec: 30, multiplier: 1.5 }, 2),
    ]);
    expect(a).toBe(30);
    expect(b).toBe(30 + (30 * 0.5) / 1.5); // +10
  });

  it('ignores an action click without a tab id', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const click = chromeMock.action.onClicked.addListener.mock.calls[0]?.[0] as
      | ((tab: { id?: number }) => void)
      | undefined;
    if (!click) throw new Error('no action click listener registered');

    click({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeMock.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
  });
});

type ExternalListener = (
  message: unknown,
  sender: { id?: string },
  sendResponse: (response?: unknown) => void,
) => boolean;

function registeredExternalListener(): ExternalListener {
  const listener = chromeMock.runtime.onMessageExternal.addListener.mock.calls[0]?.[0] as
    | ExternalListener
    | undefined;
  if (!listener) throw new Error('no onMessageExternal listener registered');
  return listener;
}

function driveExternal(
  listener: ExternalListener,
  message: unknown,
  senderId?: string,
): Promise<unknown> {
  return new Promise((resolve) => {
    const returned = listener(message, { id: senderId }, resolve);
    if (returned !== true) resolve(undefined);
  });
}

const WPM_REQUEST = { type: 'wpm:get', version: 1 };

function measurement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    version: 1,
    ts: 1000,
    site: 'youtube.com',
    naturalRate: 150,
    unit: 'wpm',
    language: 'en',
    tier: 'asr-word',
    contentType: 'lecture',
    platformMax: 2,
    recommendation: { target: 250, recommendedMultiplier: 1.65, mode: 'recommend' },
    ...overrides,
  };
}

describe('measured-rate provider (onMessageExternal)', () => {
  afterEach(() => {
    ALLOWED_PROVIDER_IDS.length = 0;
  });

  it('answers a valid wpm:get through the active-tab round trip', async () => {
    const storageData = installLocalStorage();
    storageData.set('sw.settings', { externalApiEnabled: true });
    ALLOWED_PROVIDER_IDS.push('partner-1');
    chromeMock.tabs.sendMessage.mockResolvedValue(measurement());
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredExternalListener();

    const response = await driveExternal(listener, WPM_REQUEST, 'partner-1');

    expect(response).toMatchObject({ ok: true, site: 'youtube.com', naturalRate: 150 });
    expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(5, WPM_REQUEST);
  });

  it('clamps a valid but extreme response to protocol bounds', async () => {
    const storageData = installLocalStorage();
    storageData.set('sw.settings', { externalApiEnabled: true });
    ALLOWED_PROVIDER_IDS.push('partner-1');
    // In-validator-bounds but clampable: multiplier 3.5 exceeds the
    // platformMax 2, and the ts is far in the future.
    chromeMock.tabs.sendMessage.mockResolvedValue(
      measurement({ ts: 1e12, platformMax: 2, recommendation: { target: 250, recommendedMultiplier: 3.5, mode: 'recommend' } }),
    );
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredExternalListener();

    const response = (await driveExternal(listener, WPM_REQUEST, 'partner-1')) as {
      ts: number;
      recommendation: { recommendedMultiplier: number };
    };

    expect(response.recommendation.recommendedMultiplier).toBe(2);
    expect(response.ts).toBeLessThanOrEqual(Date.now());
  });

  it('refuses when the opt-in setting is off (disabled)', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredExternalListener();

    const response = await driveExternal(listener, WPM_REQUEST, 'partner-1');
    expect(response).toEqual({ ok: false, error: 'disabled' });
  });

  it('refuses senders outside the allowlist (forbidden)', async () => {
    const storageData = installLocalStorage();
    storageData.set('sw.settings', { externalApiEnabled: true });
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredExternalListener();

    expect(await driveExternal(listener, WPM_REQUEST, 'stranger')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await driveExternal(listener, WPM_REQUEST, undefined)).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('drops malformed requests without responding (shape guard)', async () => {
    const storageData = installLocalStorage();
    storageData.set('sw.settings', { externalApiEnabled: true });
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredExternalListener();

    const sendResponse = vi.fn();
    expect(listener({ type: 'wpm:get', version: 2 }, { id: 'partner-1' }, sendResponse)).toBe(false);
    expect(listener({ type: 'other', version: 1 }, { id: 'partner-1' }, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('rate-limits a provider to 10 requests per 10 s window', async () => {
    const storageData = installLocalStorage();
    storageData.set('sw.settings', { externalApiEnabled: true });
    // Fresh sender id: the limiter is per-sender, so earlier tests' hits
    // for 'partner-1' must not leak into this window.
    ALLOWED_PROVIDER_IDS.push('partner-burst');
    chromeMock.tabs.sendMessage.mockResolvedValue(measurement());
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredExternalListener();

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 10; i++) {
        expect(await driveExternal(listener, WPM_REQUEST, 'partner-burst')).toMatchObject({ ok: true });
      }
      expect(await driveExternal(listener, WPM_REQUEST, 'partner-burst')).toEqual({
        ok: false,
        error: 'rate_limited',
      });
      vi.advanceTimersByTime(10_000);
      expect(await driveExternal(listener, WPM_REQUEST, 'partner-burst')).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers internal when the settings store fails', async () => {
    installLocalStorage();
    chromeMock.storage.local.get.mockRejectedValue(new Error('storage down'));
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredExternalListener();

    const response = await driveExternal(listener, WPM_REQUEST, 'partner-1');
    expect(response).toEqual({ ok: false, error: 'internal' });
  });
});

describe('measure-link context menu', () => {
  function clickHandler(): (info: { linkUrl?: string }) => void {
    const handler = chromeMock.contextMenus.onClicked.addListener.mock.calls[0]?.[0] as
      | ((info: { linkUrl?: string }) => void)
      | undefined;
    if (!handler) throw new Error('no context menu click listener registered');
    return handler;
  }

  it('registers the menu item on link elements with the click handler', () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();

    expect(chromeMock.contextMenus.create).toHaveBeenCalledWith({
      id: 'speedwatcher-measure-link',
      title: "Measure this video's rate",
      contexts: ['link'],
    });
    expect(chromeMock.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
  });

  it('skips registration when the handler is already installed (id-guard)', () => {
    chromeMock.contextMenus.onClicked.hasListener.mockReturnValue(true);
    const main = (backgroundModule as { main: () => unknown }).main;
    main();

    expect(chromeMock.contextMenus.create).not.toHaveBeenCalled();
  });

  it('opens an http video link in a new tab (the measurement pipeline takes over)', () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();

    clickHandler()({ linkUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
  });

  it('ignores non-http and missing link URLs', () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const handler = clickHandler();

    handler({ linkUrl: 'chrome://settings' });
    handler({});
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });
});
