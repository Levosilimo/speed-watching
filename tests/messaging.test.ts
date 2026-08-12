import { describe, expect, it, vi } from 'vitest';
import { DemandStore } from '../lib/demand';
import {
  BRIDGE_CHANNEL,
  BRIDGE_TIMEOUT_MS,
  createBridgeClient,
  createBridgeListener,
  isBridgeEnvelope,
  type BridgeDeps,
  type BridgeRequest,
  type EventHost,
} from '../lib/messaging';
import type { ContentType } from '../lib/music';
import { OverrideLog } from '../lib/override-log';
import { defaultSettings, SettingsStore } from '../lib/settings';
import { mockStorage } from './fixtures/helpers';

/** postMessage-based host: the same surface the client and the bridge
 * share in the browser. Messages posted from the host are delivered to
 * listeners with source === host (same-frame), matching the real bridge's
 * source guard; dispatch() delivers a caller-supplied event verbatim. */
function fakeWindow(): {
  host: EventHost;
  messages: unknown[];
  dispatch: (event: MessageEvent) => void;
} {
  const listeners = new Set<(event: MessageEvent) => void>();
  const messages: unknown[] = [];
  const host = {
    postMessage: (message: unknown) => {
      messages.push(message);
      for (const listener of listeners) {
        listener({ data: message, source: host } as MessageEvent);
      }
    },
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.add(listener);
    },
  };
  return {
    host,
    messages,
    dispatch: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function serve(host: EventHost): BridgeDeps {
  const deps: BridgeDeps = {
    settings: new SettingsStore(mockStorage()),
    log: new OverrideLog(mockStorage()),
    demand: new DemandStore(mockStorage()),
  };
  host.addEventListener('message', createBridgeListener(deps, host as unknown as Window));
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

  it('saves a fully-shaped settings:set payload', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    const client = createBridgeClient(host);
    await client.request({
      type: 'settings:set',
      settings: {
        target: 300,
        conservative: true,
        platformMax: 2.5,
        contentType: 'talk',
        sites: {
          'youtube.com': {
            target: 240,
            platformMax: 1.75,
            multiplierOverride: 1.3,
            contentType: 'lecture',
          },
        },
        contentTypes: { lecture: { target: 235 } },
      },
    });
    const saved = await settings.load();
    expect(saved.target).toBe(300);
    expect(saved.conservative).toBe(true);
    expect(saved.platformMax).toBe(2.5);
    expect(saved.sites['youtube.com']).toEqual({
      target: 240,
      platformMax: 1.75,
      multiplierOverride: 1.3,
      contentType: 'lecture',
    });
    expect(saved.contentTypes.lecture).toEqual({ target: 235 });
  });

  it('rejects forged settings:set with out-of-range target and saves nothing', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    const client = createBridgeClient(host);
    await settings.save({ ...defaultSettings(), target: 240 });
    const before = await settings.load();
    await expect(
      client.request({
        type: 'settings:set',
        settings: { ...defaultSettings(), target: 500 },
      }),
    ).rejects.toThrow('invalid settings payload');
    expect(await settings.load()).toEqual(before);
  });

  it('rejects forged settings:set with platformMax 10 and saves nothing', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    const client = createBridgeClient(host);
    await settings.save({ ...defaultSettings(), target: 240 });
    const before = await settings.load();
    await expect(
      client.request({
        type: 'settings:set',
        settings: { ...defaultSettings(), platformMax: 10 },
      }),
    ).rejects.toThrow('invalid settings payload');
    expect(await settings.load()).toEqual(before);
  });

  it('rejects malformed settings:set shapes and saves nothing', async () => {
    const malformed: Array<Record<string, unknown>> = [
      { ...defaultSettings(), conservative: 'yes' },
      { ...defaultSettings(), sites: 'garbage' },
      { ...defaultSettings(), sites: { 'youtube.com': { target: 900 } } },
      { ...defaultSettings(), contentTypes: { lecture: 'fast' } },
      { ...defaultSettings(), contentType: 'bogus' },
    ];
    for (const settings of malformed) {
      const { host } = fakeWindow();
      const { settings: store } = serve(host);
      const client = createBridgeClient(host);
      await store.save({ ...defaultSettings(), target: 240 });
      const before = await store.load();
      await expect(
        client.request({
          type: 'settings:set',
          settings,
        } as unknown as BridgeRequest),
      ).rejects.toThrow('invalid settings payload');
      expect(await store.load()).toEqual(before);
    }
  });

  it('ignores requests whose source is not the bridge frame window', async () => {
    const { host, dispatch, messages } = fakeWindow();
    const { settings } = serve(host);
    await settings.save({ ...defaultSettings(), target: 240 });
    const before = await settings.load();
    // A cross-frame forgery: the event arrives with a foreign source, so the
    // bridge must not answer it at all (no response, no save).
    dispatch({
      data: {
        channel: BRIDGE_CHANNEL,
        direction: 'request',
        payload: { id: 7, type: 'settings:set', settings: { ...defaultSettings(), target: 500 } },
      },
      source: { foreign: true },
    } as unknown as MessageEvent);
    expect(messages).toHaveLength(0);
    expect(await settings.load()).toEqual(before);
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

  it('round-trips demand:increment into the DemandStore', async () => {
    const { host } = fakeWindow();
    const { demand } = serve(host);
    const client = createBridgeClient(host);
    await client.request({ type: 'demand:increment', contentType: 'generic' });
    await client.request({ type: 'demand:increment', contentType: 'podcast' });
    const record = await demand.get();
    expect(record.estimatedCount).toBe(2);
    expect(record.byContentType).toEqual({ generic: 1, podcast: 1 });
  });

  it('rejects demand:increment with an unknown content type (shape validation)', async () => {
    const { host } = fakeWindow();
    const { demand } = serve(host);
    const client = createBridgeClient(host);
    await expect(
      client.request({ type: 'demand:increment', contentType: 'bogus' as ContentType }),
    ).rejects.toThrow('unknown content type');
    expect((await demand.get()).estimatedCount).toBe(0);
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
