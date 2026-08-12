import { describe, expect, it, vi } from 'vitest';
import { DemandStore } from '../lib/demand';
import {
  BRIDGE_TIMEOUT_MS,
  createBridgeClient,
  handleBridgeRequest,
  type BridgeRequest,
  type EventHost,
} from '../lib/messaging';
import type { ContentType } from '../lib/music';
import { OverrideLog } from '../lib/override-log';
import { defaultSettings, SettingsStore } from '../lib/settings';
import { mockStorage } from './fixtures/helpers';

/** EventTarget-based host: the same addEventListener/dispatchEvent surface
 * the client and the isolated-world bridge share in the browser. */
function fakeWindow(): { host: EventHost; events: Event[] } {
  const target = new EventTarget();
  const events: Event[] = [];
  return {
    host: {
      addEventListener: (type, listener) => target.addEventListener(type, listener),
      dispatchEvent: (event) => {
        events.push(event);
        return target.dispatchEvent(event);
      },
    },
    events,
  };
}

function serve(host: EventHost): { settings: SettingsStore; log: OverrideLog; demand: DemandStore } {
  const deps = {
    settings: new SettingsStore(mockStorage()),
    log: new OverrideLog(mockStorage()),
    demand: new DemandStore(mockStorage()),
  };
  host.addEventListener('speedwatcher:bridge-request', (event) => {
    const detail = (event as CustomEvent<BridgeRequest & { id: number }>).detail;
    void handleBridgeRequest(detail, deps).then(
      (result) => {
        host.dispatchEvent(
          new CustomEvent('speedwatcher:bridge-response', {
            detail: { id: detail.id, ok: true, result },
          }),
        );
      },
      (error: unknown) => {
        host.dispatchEvent(
          new CustomEvent('speedwatcher:bridge-response', {
            detail: { id: detail.id, ok: false, error: String(error) },
          }),
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
    host.addEventListener('speedwatcher:bridge-request', (event) => {
      const detail = (event as CustomEvent<BridgeRequest & { id: number }>).detail;
      host.dispatchEvent(
        new CustomEvent('speedwatcher:bridge-response', {
          detail: { id: detail.id, ok: false, error: 'boom' },
        }),
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
      const { host, events } = fakeWindow();
      const client = createBridgeClient(host);
      const pending = client.request({ type: 'settings:get' });
      expect(events.length).toBe(1); // the request left the host
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
    host.dispatchEvent(
      new CustomEvent('speedwatcher:bridge-response', {
        detail: { id: 999, ok: true, result: defaultSettings() },
      }),
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
});
