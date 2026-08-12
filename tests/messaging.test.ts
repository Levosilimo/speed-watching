import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_CHANNEL,
  BRIDGE_TIMEOUT_MS,
  createBridgeClient,
  handleBridgeRequest,
  isBridgeEnvelope,
  type BridgeRequest,
  type EventHost,
} from '../lib/messaging';
import { OverrideLog } from '../lib/override-log';
import { defaultSettings, SettingsStore } from '../lib/settings';
import { mockStorage } from './fixtures/helpers';

/** postMessage-based host: the same surface the client and the bridge
 * share in the browser (message events delivered synchronously). */
function fakeWindow(): { host: EventHost; messages: unknown[] } {
  const listeners = new Set<(event: MessageEvent) => void>();
  const messages: unknown[] = [];
  return {
    host: {
      postMessage: (message) => {
        messages.push(message);
        for (const listener of listeners) listener({ data: message } as MessageEvent);
      },
      addEventListener: (type, listener) => {
        if (type === 'message') listeners.add(listener);
      },
    },
    messages,
  };
}

function serve(host: EventHost): { settings: SettingsStore; log: OverrideLog } {
  const deps = {
    settings: new SettingsStore(mockStorage()),
    log: new OverrideLog(mockStorage()),
  };
  host.addEventListener('message', (event) => {
    const envelope = event.data;
    if (!isBridgeEnvelope(envelope) || envelope.direction !== 'request') return;
    const detail = envelope.payload as BridgeRequest & { id: number };
    void handleBridgeRequest(detail, deps).then(
      (result) => {
        host.postMessage(
          { channel: BRIDGE_CHANNEL, direction: 'response', payload: { id: detail.id, ok: true, result } },
          '*',
        );
      },
      (error: unknown) => {
        host.postMessage(
          { channel: BRIDGE_CHANNEL, direction: 'response', payload: { id: detail.id, ok: false, error: String(error) } },
          '*',
        );
      },
    );
  });
  return deps;
}

describe('messaging bridge', () => {
  it('round-trips settings:get through the handler', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    await settings.update((s) => ({ ...s, target: 240 }));
    const client = createBridgeClient(host);
    const loaded = await client.request({ type: 'settings:get' });
    expect(loaded.target).toBe(240);
  });

  it('round-trips settings:set into the store', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    const client = createBridgeClient(host);
    const next = { ...(await settings.load()), target: 300 };
    await client.request({ type: 'settings:set', settings: next });
    expect((await settings.load()).target).toBe(300);
  });

  it('round-trips log:append into the OverrideLog', async () => {
    const { host } = fakeWindow();
    const { log } = serve(host);
    const client = createBridgeClient(host);
    await client.request({
      type: 'log:append',
      entry: {
        site: 'youtube.com',
        contentType: 'talk',
        naturalRate: 160.25,
        multiplier: 1.55,
        mode: 'recommend',
        userAction: 'apply',
      },
    });
    const entries = await log.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.multiplier).toBe(1.55);
    expect(entry.userAction).toBe('apply');
  });

  it('rejects with the handler error when the response is not ok', async () => {
    const { host } = fakeWindow();
    host.addEventListener('message', (event) => {
      const envelope = event.data;
      if (!isBridgeEnvelope(envelope) || envelope.direction !== 'request') return;
      const detail = envelope.payload;
      host.postMessage(
        {
          channel: BRIDGE_CHANNEL,
          direction: 'response',
          payload: { id: detail.id, ok: false, error: 'boom' },
        },
        '*',
      );
    });
    const client = createBridgeClient(host);
    await expect(client.request({ type: 'settings:get' })).rejects.toThrow('boom');
  });

  it('times out when no response arrives', async () => {
    vi.useFakeTimers();
    try {
      const { host, messages } = fakeWindow();
      const client = createBridgeClient(host);
      const pending = client.request({ type: 'settings:get' });
      expect(messages.length).toBe(1); // the request left the host
      const assertion = expect(pending).rejects.toThrow('bridge timeout');
      vi.advanceTimersByTime(BRIDGE_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores responses with unknown ids', async () => {
    const { host } = fakeWindow();
    const client = createBridgeClient(host);
    host.postMessage(
      {
        channel: BRIDGE_CHANNEL,
        direction: 'response',
        payload: { id: 999, ok: true, result: defaultSettings() },
      },
      '*',
    );
    // The stray response must not settle the pending request; it still times out.
    vi.useFakeTimers();
    try {
      const pending = client.request({ type: 'settings:get' });
      const assertion = expect(pending).rejects.toThrow('bridge timeout');
      vi.advanceTimersByTime(BRIDGE_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores non-bridge messages on the window', async () => {
    const { host } = fakeWindow();
    const client = createBridgeClient(host);
    host.postMessage({ channel: 'other-app', direction: 'request', payload: {} }, '*');
    host.postMessage('plain string', '*');
    vi.useFakeTimers();
    try {
      const pending = client.request({ type: 'settings:get' });
      const assertion = expect(pending).rejects.toThrow('bridge timeout');
      vi.advanceTimersByTime(BRIDGE_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
