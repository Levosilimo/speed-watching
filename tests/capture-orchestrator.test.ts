import { describe, expect, it, vi } from 'vitest';
import { createCaptureOrchestrator } from '../lib/capture-orchestrator';

const MIRROR_KEY = 'probeCapture';
const OFFSCREEN_URL = 'chrome-extension://abc/offscreen.html';

function makeApi() {
  const activatedListeners: Array<(info: { tabId: number }) => void> = [];
  const removedListeners: Array<(tabId: number) => void> = [];
  const api = {
    tabs: {
      query: vi.fn(async (): Promise<Array<{ id?: number }>> => [{ id: 7 }]),
      onActivated: { addListener: (listener: (info: { tabId: number }) => void) => activatedListeners.push(listener) },
      onRemoved: { addListener: (listener: (tabId: number) => void) => removedListeners.push(listener) },
    },
    tabCapture: { getMediaStreamId: vi.fn(async (): Promise<string> => 'stream-1') },
    offscreen: { createDocument: vi.fn(async (): Promise<void> => {}) },
    runtime: {
      getContexts: vi.fn(async (): Promise<unknown[]> => []),
      sendMessage: vi.fn(async (): Promise<unknown> => ({ received: true })),
    },
    storage: {
      session: {
        get: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
        set: vi.fn(async (): Promise<void> => {}),
        remove: vi.fn(async (): Promise<void> => {}),
      },
    },
  };
  return { api, activatedListeners, removedListeners };
}

type Api = ReturnType<typeof makeApi>;

function makeOrchestrator(
  api: Parameters<typeof createCaptureOrchestrator>[0],
  options: { forwardRetryMs?: number; forwardMaxTries?: number } = {},
) {
  return createCaptureOrchestrator(api, { offscreenUrl: OFFSCREEN_URL, ...options });
}

function requireListener<T>(listeners: T[]): T {
  const listener = listeners[0];
  if (!listener) throw new Error('no listener registered');
  return listener;
}

async function startCapture(orch: ReturnType<typeof makeOrchestrator>, api: Api['api']) {
  await orch.handleMessage({ kind: 'probe-start' });
  await orch.handleMessage({ kind: 'offscreen-event', event: 'started' });
  expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ state: 'capturing' });
  expect(api.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'offscreen-start', streamId: 'stream-1' });
}

describe('start', () => {
  it('reports the probe as unsupported when offscreen is absent (Firefox)', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator({
      // offscreen omitted — Firefox has no offscreen API
      tabs: api.tabs,
      tabCapture: api.tabCapture,
      runtime: api.runtime,
      storage: api.storage,
    });
    const response = await orch.handleMessage({ kind: 'probe-start' });
    expect(response).toMatchObject({
      state: 'error',
      error: expect.stringContaining('not supported'),
    });
    // Nothing else ran: no stream id, no document, no forward.
    expect(api.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    expect(api.offscreen.createDocument).not.toHaveBeenCalled();
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('walks idle → starting → capturing and mirrors the state', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    const response = await orch.handleMessage({ kind: 'probe-start' });
    expect(response).toMatchObject({ state: 'starting', tabId: 7 });
    expect(api.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 7 });
    expect(api.storage.session.set).toHaveBeenCalledWith({
      [MIRROR_KEY]: { state: 'starting', tabId: 7 },
    });
    await orch.handleMessage({ kind: 'offscreen-event', event: 'started' });
    expect(api.storage.session.set).toHaveBeenLastCalledWith({
      [MIRROR_KEY]: { state: 'capturing', tabId: 7 },
    });
  });

  it('creates the offscreen document with USER_MEDIA when none exists', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await orch.handleMessage({ kind: 'probe-start' });
    expect(api.offscreen.createDocument).toHaveBeenCalledWith({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: expect.any(String),
    });
  });

  it('skips document creation when an offscreen context already exists', async () => {
    const { api } = makeApi();
    api.runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    const orch = makeOrchestrator(api);
    await orch.handleMessage({ kind: 'probe-start' });
    expect(api.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('captures an audible tab when the active tab is the sender', async () => {
    const { api } = makeApi();
    api.tabs.query.mockResolvedValueOnce([{ id: 3 }]).mockResolvedValueOnce([{ id: 9 }]);
    const orch = makeOrchestrator(api);
    await orch.handleMessage({ kind: 'probe-start' }, { tab: { id: 3 } });
    expect(api.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 9 });
  });

  it('errors when no capturable tab exists', async () => {
    const { api } = makeApi();
    api.tabs.query.mockResolvedValue([]);
    const orch = makeOrchestrator(api);
    const response = await orch.handleMessage({ kind: 'probe-start' });
    expect(response).toMatchObject({ state: 'error', error: expect.stringContaining('no tab to capture') });
    expect(api.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    expect(api.storage.session.set).not.toHaveBeenCalled();
  });

  it('errors when tabCapture rejects', async () => {
    const { api } = makeApi();
    api.tabCapture.getMediaStreamId.mockRejectedValue(new Error('no user gesture'));
    const orch = makeOrchestrator(api);
    const response = await orch.handleMessage({ kind: 'probe-start' });
    expect(response).toMatchObject({ state: 'error', error: 'tabCapture failed: no user gesture' });
  });

  it('errors when the offscreen document never acks the start message', async () => {
    const { api } = makeApi();
    api.runtime.sendMessage.mockResolvedValue(undefined);
    const orch = makeOrchestrator(api, { forwardRetryMs: 1, forwardMaxTries: 3 });
    const response = await orch.handleMessage({ kind: 'probe-start' });
    expect(response).toMatchObject({
      state: 'error',
      error: 'offscreen document did not accept the start message',
    });
    expect(api.runtime.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('retries forwarding until the offscreen document acks', async () => {
    const { api } = makeApi();
    api.runtime.sendMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ received: true });
    const orch = makeOrchestrator(api, { forwardRetryMs: 1 });
    await orch.handleMessage({ kind: 'probe-start' });
    expect(api.runtime.sendMessage).toHaveBeenNthCalledWith(1, {
      kind: 'offscreen-start',
      streamId: 'stream-1',
    });
    expect(api.runtime.sendMessage).toHaveBeenNthCalledWith(2, {
      kind: 'offscreen-start',
      streamId: 'stream-1',
    });
    expect(api.runtime.sendMessage).toHaveBeenNthCalledWith(3, {
      kind: 'offscreen-start',
      streamId: 'stream-1',
    });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ state: 'starting' });
  });

  it('stops the running capture before restarting', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    await orch.handleMessage({ kind: 'probe-start' });
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'offscreen-stop' });
    expect(api.tabCapture.getMediaStreamId).toHaveBeenCalledTimes(2);
  });
});

describe('stop', () => {
  it('transitions to idle, forwards stop, and clears the mirror', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    const response = await orch.handleMessage({ kind: 'probe-stop' });
    expect(response).toMatchObject({ state: 'idle' });
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'offscreen-stop' });
    expect(api.storage.session.remove).toHaveBeenCalledWith(MIRROR_KEY);
  });

  it('is a no-op when already idle', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    const response = await orch.handleMessage({ kind: 'probe-stop' });
    expect(response).toMatchObject({ state: 'idle' });
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores a late stopped event after a clean stop', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    await orch.handleMessage({ kind: 'probe-stop' });
    await orch.handleMessage({ kind: 'offscreen-event', event: 'stopped' });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ state: 'idle' });
  });
});

describe('degradation', () => {
  it('tab switch stops the capture and reports degraded', async () => {
    const { api, activatedListeners } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    requireListener(activatedListeners)({ tabId: 99 });
    await vi.waitFor(() => {
      expect(api.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'offscreen-stop' });
    });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({
      state: 'degraded',
      error: 'tab switched away',
    });
    expect(api.storage.session.set).toHaveBeenLastCalledWith({
      [MIRROR_KEY]: { state: 'degraded', tabId: 7, error: 'tab switched away' },
    });
  });

  it('activating the captured tab itself does not interrupt', async () => {
    const { api, activatedListeners } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    requireListener(activatedListeners)({ tabId: 7 });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ state: 'capturing' });
  });

  it('closing the captured tab reports degraded', async () => {
    const { api, removedListeners } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    requireListener(removedListeners)(7);
    await vi.waitFor(async () => {
      expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({
        state: 'degraded',
        error: 'captured tab closed',
      });
    });
  });

  it('stays degraded when the offscreen reports stopped afterwards', async () => {
    const { api, activatedListeners } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    requireListener(activatedListeners)({ tabId: 99 });
    await vi.waitFor(() => {
      expect(api.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'offscreen-stop' });
    });
    await orch.handleMessage({ kind: 'offscreen-event', event: 'stopped' });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ state: 'degraded' });
  });

  it('reports degraded when the tab audio ends', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    await orch.handleMessage({ kind: 'offscreen-event', event: 'track-ended' });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({
      state: 'degraded',
      error: 'tab audio ended',
    });
  });
});

describe('offscreen events', () => {
  it('records the error state from an offscreen error event', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    await orch.handleMessage({ kind: 'offscreen-event', event: 'error', error: 'OverconstrainedError' });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({
      state: 'error',
      error: 'OverconstrainedError',
    });
  });

  it('stores the wasm check result and returns it in probe-state', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await orch.handleMessage({
      kind: 'offscreen-event',
      event: 'wasm-check',
      wasm: { ok: true, sab: false },
    });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({
      wasm: { ok: true, sab: false },
    });
  });

  it('updates the level without rewriting the mirror', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await startCapture(orch, api);
    await orch.handleMessage({ kind: 'offscreen-event', event: 'level', level: 0.25 });
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ level: 0.25 });
    expect(api.storage.session.set).toHaveBeenCalledTimes(2);
  });

  it('ignores forwarded offscreen messages bouncing back', async () => {
    const { api } = makeApi();
    const orch = makeOrchestrator(api);
    await expect(orch.handleMessage({ kind: 'offscreen-start', streamId: 'x' })).resolves.toBeUndefined();
    await expect(orch.handleMessage({ kind: 'offscreen-stop' })).resolves.toBeUndefined();
    await expect(orch.handleMessage({ kind: 'offscreen-wasm-check' })).resolves.toBeUndefined();
  });
});

describe('init (service worker restart)', () => {
  it('adopts a mirrored capture when the offscreen document still exists', async () => {
    const { api } = makeApi();
    api.storage.session.get.mockResolvedValue({ [MIRROR_KEY]: { state: 'capturing', tabId: 7 } });
    api.runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    const orch = makeOrchestrator(api);
    await orch.init();
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ state: 'capturing', tabId: 7 });
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('marks a mirrored capture degraded when the offscreen document is gone', async () => {
    const { api } = makeApi();
    api.storage.session.get.mockResolvedValue({ [MIRROR_KEY]: { state: 'capturing', tabId: 7 } });
    const orch = makeOrchestrator(api);
    await orch.init();
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({
      state: 'degraded',
      error: 'capture lost: offscreen document gone',
    });
  });

  it('ignores a corrupt or absent mirror', async () => {
    const { api } = makeApi();
    api.storage.session.get.mockResolvedValue({ [MIRROR_KEY]: { state: 'bogus' } });
    const orch = makeOrchestrator(api);
    await orch.init();
    expect(await orch.handleMessage({ kind: 'probe-state' })).toMatchObject({ state: 'idle' });
  });
});
