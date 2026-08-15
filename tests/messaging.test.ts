import { describe, expect, it, vi } from 'vitest';
import { ChannelMemory } from '../lib/channel-memory';
import { DemandStore } from '../lib/demand';
import { ErrorJournal } from '../lib/error-journal';
import { NudgeStore } from '../lib/nudge';
import { TimeSavedStore } from '../lib/time-saved';
import {
  BRIDGE_CHANNEL,
  BRIDGE_TIMEOUT_MS,
  createBridgeClient,
  createBridgeListener,
  isBridgeEnvelope,
  isSettingsPayload,
  type BridgeDeps,
  type BridgeRequest,
  type EventHost,
} from '../lib/messaging';
import {
  clampWpmResponse,
  isWpmEnvelope,
  isWpmGetRequest,
  isWpmGetResponse,
  WPM_CHANNEL,
  WPM_PROTOCOL_VERSION,
  type WpmGetResponse,
} from '../lib/wpm-protocol';
import type { ContentType } from '../lib/music';
import { OverrideLog } from '../lib/override-log';
import type { OverrideLogEntry } from '../lib/override-log';
import { defaultSettings, SettingsStore } from '../lib/settings';
import { SkipSilenceStore, defaultSkipSilence } from '../lib/skip-silence';
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
    // www-normalized like a real watch page; the bridge's siteHost is
    // 'youtube.com'.
    location: { hostname: 'www.youtube.com' },
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

function serve(
  host: EventHost,
  forwardDemand: BridgeDeps['forwardDemand'] = vi.fn(),
  forwardAccrue: BridgeDeps['forwardAccrue'] = vi.fn(),
): BridgeDeps {
  const deps: BridgeDeps = {
    settings: new SettingsStore(mockStorage()),
    skip: new SkipSilenceStore(mockStorage()),
    log: new OverrideLog(mockStorage()),
    channels: new ChannelMemory(mockStorage()),
    forwardDemand,
    forwardJournalAppend: vi.fn(),
    forwardNudgeRecordApply: vi.fn(),
    forwardNudgeDismiss: vi.fn(),
    forwardAccrue,
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
        externalApiEnabled: true,
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
        autoApply: { enabled: true, contentTypes: { talk: true, music: false } },
      },
    });
    const saved = await settings.load();
    expect(saved.target).toBe(300);
    expect(saved.conservative).toBe(true);
    expect(saved.platformMax).toBe(2.5);
    expect(saved.externalApiEnabled).toBe(true);
    expect(saved.sites['youtube.com']).toEqual({
      target: 240,
      platformMax: 1.75,
      multiplierOverride: 1.3,
      contentType: 'lecture',
    });
    expect(saved.contentTypes.lecture).toEqual({ target: 235 });
    expect(saved.autoApply).toEqual({ enabled: true, contentTypes: { talk: true, music: false } });
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
      { ...defaultSettings(), sites: { 'youtube.com': { skipSilence: 'yes' } } },
      { ...defaultSettings(), contentTypes: { lecture: 'fast' } },
      { ...defaultSettings(), contentType: 'bogus' },
      { ...defaultSettings(), externalApiEnabled: 'yes' },
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

  it('accepts a site override with a boolean skipSilence flag', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    const client = createBridgeClient(host);
    await client.request({
      type: 'settings:set',
      settings: {
        ...defaultSettings(),
        sites: { 'youtube.com': { skipSilence: true } },
      },
    });
    expect((await settings.load()).sites['youtube.com']).toEqual({ skipSilence: true });
  });

  it('round-trips skip:get through the handler', async () => {
    const { host } = fakeWindow();
    const { skip } = serve(host);
    await skip.save({ ...defaultSkipSilence(), enabled: true, pauseRate: 1.2 });
    const client = createBridgeClient(host);
    expect(await client.request({ type: 'skip:get' })).toEqual({
      ...defaultSkipSilence(),
      enabled: true,
      pauseRate: 1.2,
    });
  });

  it('round-trips skip:set into the store', async () => {
    const { host } = fakeWindow();
    const { skip } = serve(host);
    const client = createBridgeClient(host);
    const prefs = { ...defaultSkipSilence(), enabled: true };
    await client.request({ type: 'skip:set', prefs });
    expect(await skip.load()).toEqual(prefs);
  });

  it('rejects forged skip:set prefs and saves nothing', async () => {
    const malformed: Array<Record<string, unknown>> = [
      { enabled: 'yes', minGapSec: 1.5, pauseRate: 1.1 },
      { enabled: true, minGapSec: 0.5, pauseRate: 1.1 },
      { enabled: true, minGapSec: 1.5, pauseRate: 2 },
      { enabled: true, minGapSec: 61, pauseRate: 1.1 },
      { enabled: true, minGapSec: 'long', pauseRate: 1.1 },
    ];
    for (const prefs of malformed) {
      const { host } = fakeWindow();
      const { skip } = serve(host);
      const client = createBridgeClient(host);
      const before = await skip.load();
      await expect(
        client.request({ type: 'skip:set', prefs } as unknown as BridgeRequest),
      ).rejects.toThrow('invalid prefs');
      expect(await skip.load()).toEqual(before);
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

  const validLogEntry: Omit<OverrideLogEntry, 'ts'> = {
    site: 'youtube.com',
    contentType: 'talk',
    naturalRate: 160.25,
    multiplier: 1.55,
    mode: 'recommend',
    userAction: 'apply',
  };

  it('accepts a log:append entry with optional fields (videoId, finalMultiplier)', async () => {
    const { host } = fakeWindow();
    const { log } = serve(host);
    const client = createBridgeClient(host);
    await client.request({
      type: 'log:append',
      entry: { ...validLogEntry, videoId: 'v1', userAction: 'adjust', finalMultiplier: 1.6 },
    });
    const entries = await log.entries();
    expect(entries[0]?.videoId).toBe('v1');
    expect(entries[0]?.finalMultiplier).toBe(1.6);
  });

  it('rejects forged log:append entries and appends nothing (SEC-3)', async () => {
    const malformed: Array<Record<string, unknown> | string> = [
      { ...validLogEntry, multiplier: Number.NaN },
      { ...validLogEntry, multiplier: 20 },
      { ...validLogEntry, naturalRate: 0 },
      { ...validLogEntry, naturalRate: 5000 },
      { ...validLogEntry, contentType: 'bogus' },
      { ...validLogEntry, userAction: 'explode' },
      { ...validLogEntry, mode: 'speedrun' },
      { ...validLogEntry, site: '' },
      { ...validLogEntry, videoId: 42 },
      { ...validLogEntry, finalMultiplier: -2 },
      'not an entry',
    ];
    for (const entry of malformed) {
      const { host } = fakeWindow();
      const { log } = serve(host);
      const client = createBridgeClient(host);
      await expect(
        client.request({ type: 'log:append', entry } as unknown as BridgeRequest),
      ).rejects.toThrow('log:append: invalid entry');
      expect(await log.entries()).toHaveLength(0);
    }
  });

  it('rejects settings:set with a sites override for a foreign host and saves nothing (SEC-1)', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    const client = createBridgeClient(host);
    await settings.save({ ...defaultSettings(), target: 240 });
    const before = await settings.load();
    await expect(
      client.request({
        type: 'settings:set',
        settings: { ...defaultSettings(), sites: { 'example.com': { target: 240 } } },
      }),
    ).rejects.toThrow('sites override for foreign host example.com');
    expect(await settings.load()).toEqual(before);
  });

  it('accepts a sites override for the requesting frame host (www-normalized) (SEC-1)', async () => {
    const { host } = fakeWindow();
    const { settings } = serve(host);
    const client = createBridgeClient(host);
    await client.request({
      type: 'settings:set',
      settings: { ...defaultSettings(), sites: { 'youtube.com': { target: 240 } } },
    });
    expect((await settings.load()).sites['youtube.com']).toEqual({ target: 240 });
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

  it('round-trips channel:put and channel:get through the bridge', async () => {
    const { host } = fakeWindow();
    serve(host);
    const client = createBridgeClient(host);
    await client.request({
      type: 'channel:put',
      channelKey: 'UC-a',
      record: { rate: 150, unit: 'wpm', language: 'en', ts: 42 },
    });
    expect(await client.request({ type: 'channel:get', channelKey: 'UC-a' })).toEqual({
      rate: 150,
      unit: 'wpm',
      language: 'en',
      ts: 42,
    });
    expect(await client.request({ type: 'channel:get', channelKey: 'UC-unknown' })).toBeNull();
  });

  it('rejects forged channel:put records and writes nothing (SEC-3)', async () => {
    const malformed: Array<Record<string, unknown>> = [
      { rate: 0, unit: 'wpm', language: 'en', ts: 1 },
      { rate: 5000, unit: 'wpm', language: 'en', ts: 1 },
      { rate: 150, unit: '', language: 'en', ts: 1 },
      { rate: 150, unit: 'wpm', language: 'en', ts: Number.NaN },
      { rate: 'fast', unit: 'wpm', language: 'en', ts: 1 },
    ];
    for (const record of malformed) {
      const { host } = fakeWindow();
      const { channels } = serve(host);
      const client = createBridgeClient(host);
      await expect(
        client.request({ type: 'channel:put', channelKey: 'UC-a', record } as unknown as BridgeRequest),
      ).rejects.toThrow('channel:put: invalid record');
      expect(await channels.load()).toEqual({});
    }
  });

  it('rejects channel:put with an empty or oversized key (SEC-3)', async () => {
    for (const channelKey of ['', 'x'.repeat(201)]) {
      const { host } = fakeWindow();
      const { channels } = serve(host);
      const client = createBridgeClient(host);
      await expect(
        client.request({
          type: 'channel:put',
          channelKey,
          record: { rate: 150, unit: 'wpm', language: 'en', ts: 1 },
        }),
      ).rejects.toThrow('channel:put: invalid record');
      expect(await channels.load()).toEqual({});
    }
  });

  it('answers channel:get with null for a malformed key', async () => {
    const { host } = fakeWindow();
    serve(host);
    const client = createBridgeClient(host);
    expect(await client.request({ type: 'channel:get', channelKey: '' })).toBeNull();
    expect(await client.request({ type: 'channel:get', channelKey: 'x'.repeat(201) })).toBeNull();
  });

  it('forwards demand:increment to the background single writer and resolves on its response (lib-11#3)', async () => {
    const { host } = fakeWindow();
    // forwardDemand is the bridge's runtime.sendMessage round trip; the
    // background's DemandStore is the single writer (entrypoints/background.ts).
    const background = new DemandStore(mockStorage());
    const forwardDemand = vi.fn((contentType: ContentType) => background.increment(contentType));
    serve(host, forwardDemand);
    const client = createBridgeClient(host);
    await client.request({ type: 'demand:increment', contentType: 'generic' });
    await client.request({ type: 'demand:increment', contentType: 'podcast' });
    expect(forwardDemand).toHaveBeenNthCalledWith(1, 'generic');
    expect(forwardDemand).toHaveBeenNthCalledWith(2, 'podcast');
    const record = await background.get();
    expect(record.estimatedCount).toBe(2);
    expect(record.byContentType).toEqual({ generic: 1, podcast: 1 });
  });

  it('serializes concurrent demand:increment requests through the background writer', async () => {
    const { host } = fakeWindow();
    const background = new DemandStore(mockStorage());
    serve(host, (contentType) => background.increment(contentType));
    const client = createBridgeClient(host);
    await Promise.all([
      client.request({ type: 'demand:increment', contentType: 'generic' }),
      client.request({ type: 'demand:increment', contentType: 'generic' }),
    ]);
    const record = await background.get();
    expect(record.estimatedCount).toBe(2);
    expect(record.byContentType.generic).toBe(2);
  });

  it('forwards journal:append to the background single writer and resolves on its response', async () => {
    const { host } = fakeWindow();
    const background = new ErrorJournal(mockStorage());
    const deps = serve(host);
    deps.forwardJournalAppend = vi.fn((entry) => background.append(entry));
    const client = createBridgeClient(host);
    await client.request({ type: 'journal:append', reason: 'no-track', videoId: 'abc' });
    await client.request({ type: 'journal:append', reason: 'fetch-failed' });
    const entries = await background.entries();
    expect(entries).toEqual([
      { ts: expect.any(Number), reason: 'no-track', videoId: 'abc' },
      { ts: expect.any(Number), reason: 'fetch-failed' },
    ]);
  });

  it('rejects journal:append with an unknown reason before forwarding (shape validation)', async () => {
    const { host } = fakeWindow();
    const forwardJournalAppend = vi.fn();
    const deps = serve(host);
    deps.forwardJournalAppend = forwardJournalAppend;
    const client = createBridgeClient(host);
    await expect(
      client.request({ type: 'journal:append', reason: 'bogus' as never }),
    ).rejects.toThrow('invalid entry');
    expect(forwardJournalAppend).not.toHaveBeenCalled();
  });

  it('rejects demand:increment with an unknown content type before forwarding (shape validation)', async () => {
    const { host } = fakeWindow();
    const forwardDemand = vi.fn();
    serve(host, forwardDemand);
    const client = createBridgeClient(host);
    await expect(
      client.request({ type: 'demand:increment', contentType: 'bogus' as ContentType }),
    ).rejects.toThrow('unknown content type');
    expect(forwardDemand).not.toHaveBeenCalled();
  });

  it('forwards nudge:recordApply to the background single writer and resolves on its response', async () => {
    const { host } = fakeWindow();
    const background = new NudgeStore(mockStorage());
    const deps = serve(host);
    deps.forwardNudgeRecordApply = vi.fn((multiplier: number) => background.recordApply(multiplier));
    const client = createBridgeClient(host);
    await client.request({ type: 'nudge:recordApply', multiplier: 1.6 });
    await client.request({ type: 'nudge:recordApply', multiplier: 1.6 });
    const show = await client.request({ type: 'nudge:recordApply', multiplier: 1.6 });
    expect(deps.forwardNudgeRecordApply).toHaveBeenCalledTimes(3);
    expect(show).toEqual({ show: true });
  });

  it('rejects nudge:recordApply with an out-of-range multiplier before forwarding', async () => {
    const { host } = fakeWindow();
    const deps = serve(host);
    const client = createBridgeClient(host);
    await expect(
      client.request({ type: 'nudge:recordApply', multiplier: 50 }),
    ).rejects.toThrow('nudge:recordApply: invalid multiplier');
    expect(deps.forwardNudgeRecordApply).not.toHaveBeenCalled();
  });

  it('forwards nudge:dismiss to the background single writer', async () => {
    const { host } = fakeWindow();
    const background = new NudgeStore(mockStorage());
    const deps = serve(host);
    deps.forwardNudgeDismiss = vi.fn((forever: boolean) => background.dismiss(forever));
    const client = createBridgeClient(host);
    await client.request({ type: 'nudge:dismiss', forever: false });
    expect(deps.forwardNudgeDismiss).toHaveBeenCalledExactlyOnceWith(false);
    const record = await background.get();
    expect(record.highApplied).toBe(0);
    expect(record.dismissedUntil).toEqual(expect.any(Number));
  });

  it('rejects nudge:dismiss with a non-boolean forever flag before forwarding', async () => {
    const { host } = fakeWindow();
    const deps = serve(host);
    const client = createBridgeClient(host);
    await expect(
      client.request({ type: 'nudge:dismiss', forever: 'yes' } as unknown as BridgeRequest),
    ).rejects.toThrow('nudge:dismiss: invalid forever flag');
    expect(deps.forwardNudgeDismiss).not.toHaveBeenCalled();
  });

  it('forwards timeSaved:accrue to the background single writer and resolves on its response', async () => {
    const { host } = fakeWindow();
    const background = new TimeSavedStore(mockStorage());
    const forwardAccrue = vi.fn((deltaSec: number, multiplier: number) =>
      background.accrue(deltaSec, multiplier),
    );
    serve(host, vi.fn(), forwardAccrue);
    const client = createBridgeClient(host);
    await client.request({ type: 'timeSaved:accrue', deltaSec: 60, multiplier: 2 });
    await client.request({ type: 'timeSaved:accrue', deltaSec: 30, multiplier: 1.5 });
    expect(forwardAccrue).toHaveBeenNthCalledWith(1, 60, 2);
    expect(forwardAccrue).toHaveBeenNthCalledWith(2, 30, 1.5);
    expect(await background.get()).toBe(30 + (30 * 0.5) / 1.5);
  });

  it('rejects timeSaved:accrue with an out-of-range multiplier before forwarding', async () => {
    const { host } = fakeWindow();
    const forwardAccrue = vi.fn();
    serve(host, vi.fn(), forwardAccrue);
    const client = createBridgeClient(host);
    await expect(
      client.request({ type: 'timeSaved:accrue', deltaSec: 60, multiplier: 99 }),
    ).rejects.toThrow('timeSaved:accrue');
    expect(forwardAccrue).not.toHaveBeenCalled();
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

describe('isSettingsPayload autoApply', () => {
  it('accepts well-formed autoApply shapes', () => {
    const base = defaultSettings();
    expect(isSettingsPayload({ ...base, autoApply: { enabled: true, contentTypes: {} } })).toBe(true);
    expect(
      isSettingsPayload({
        ...base,
        autoApply: { enabled: false, contentTypes: { talk: true, music: false, news: true } },
      }),
    ).toBe(true);
  });

  it('rejects non-boolean enabled and non-boolean map values', () => {
    const base = defaultSettings();
    expect(
      isSettingsPayload({ ...base, autoApply: { enabled: 'yes', contentTypes: {} } }),
    ).toBe(false);
    expect(
      isSettingsPayload({ ...base, autoApply: { enabled: true, contentTypes: { talk: 'yes' } } }),
    ).toBe(false);
    expect(isSettingsPayload({ ...base, autoApply: 'garbage' })).toBe(false);
  });

  it('compat: accepts a payload WITHOUT autoApply (pre-auto-apply writers)', () => {
    const legacy = { ...defaultSettings() };
    delete (legacy as Record<string, unknown>).autoApply;
    expect(isSettingsPayload(legacy)).toBe(true);
  });
});

describe('wpm:get protocol', () => {
  const okResponse: WpmGetResponse = {
    ok: true,
    version: WPM_PROTOCOL_VERSION,
    ts: 1000,
    site: 'youtube.com',
    naturalRate: 150,
    unit: 'wpm',
    language: 'en',
    tier: 'asr-word',
    contentType: 'lecture',
    platformMax: 2,
    recommendation: { target: 250, recommendedMultiplier: 1.65, mode: 'recommend' },
  };

  it('accepts a valid wpm:get request and rejects malformed ones', () => {
    expect(isWpmGetRequest({ type: 'wpm:get', version: 1 })).toBe(true);
    expect(isWpmGetRequest({ type: 'wpm:get' })).toBe(false);
    expect(isWpmGetRequest({ type: 'wpm:get', version: 2 })).toBe(false);
    expect(isWpmGetRequest({ type: 'other', version: 1 })).toBe(false);
    expect(isWpmGetRequest(null)).toBe(false);
  });

  it('recognizes the wpm window envelope', () => {
    expect(
      isWpmEnvelope({ channel: WPM_CHANNEL, message: { type: 'wpm:get', version: 1 } }),
    ).toBe(true);
    expect(isWpmEnvelope({ channel: 'speedwatcher:shortcut', message: {} })).toBe(false);
    expect(isWpmEnvelope({ channel: WPM_CHANNEL })).toBe(false);
  });

  it('validates the wpm:get response shape (SEC)', () => {
    expect(isWpmGetResponse(okResponse)).toBe(true);
    expect(isWpmGetResponse({ ...okResponse, naturalRate: 0 })).toBe(false);
    expect(isWpmGetResponse({ ...okResponse, naturalRate: 5000 })).toBe(false);
    expect(
      isWpmGetResponse({
        ...okResponse,
        recommendation: { ...okResponse.recommendation, recommendedMultiplier: 9 },
      }),
    ).toBe(false);
    expect(isWpmGetResponse({ ...okResponse, tier: 'bogus' })).toBe(false);
    expect(isWpmGetResponse({ ...okResponse, version: 2 })).toBe(false);
    expect(isWpmGetResponse({ ok: false, error: 'no-active-video' })).toBe(true);
    expect(isWpmGetResponse({ ok: false, error: '' })).toBe(false);
    expect(isWpmGetResponse({ ok: false })).toBe(false);
  });

  it('clamps numeric response fields to protocol bounds', () => {
    const now = 1_000_000;
    const clamped = clampWpmResponse(
      {
        ...okResponse,
        ts: now + 500,
        naturalRate: 5000,
        platformMax: 2,
        recommendation: { ...okResponse.recommendation, recommendedMultiplier: 9 },
      },
      now,
    );
    if (clamped.ok === false) throw new Error('expected ok response');
    expect(clamped.ts).toBe(now);
    expect(clamped.naturalRate).toBe(1000);
    expect(clamped.recommendation.recommendedMultiplier).toBe(2);
    const floored = clampWpmResponse({
      ...okResponse,
      recommendation: { ...okResponse.recommendation, recommendedMultiplier: 0.2 },
    });
    if (floored.ok === false) throw new Error('expected ok response');
    expect(floored.recommendation.recommendedMultiplier).toBe(0.5);
    // Error responses pass through untouched.
    expect(clampWpmResponse({ ok: false, error: 'rate_limited' })).toEqual({
      ok: false,
      error: 'rate_limited',
    });
  });
});
