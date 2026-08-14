// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import contentModule from '../entrypoints/content';
import bridgeModule from '../entrypoints/bridge.content';
import type { ChannelRecord } from '../lib/channel-memory';
import { parseYouTubeJson3 } from '../lib/captions';
import type { BridgeEnvelope } from '../lib/messaging';
import type { WpmGetResponseOk } from '../lib/wpm-protocol';
import { priorMidpoint } from '../lib/heuristics';
import { recommend } from '../lib/recommend';
import { defaultSettings, resolveContentType, resolvePlatformMax, resolveUserTarget } from '../lib/settings';
import { manualCueRate } from '../lib/wpm';
import { chromeMock } from './chrome-mock';

// readFixture (fixtures/helpers.ts) builds its path with the global URL
// constructor, which the happy-dom environment replaces; load the payload
// with plain path joins instead.
const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real', 'manual-cue.json'), 'utf8'),
) as unknown;

// Drives the real entrypoints the way background-glue.test.ts drives the
// background: invoke main() against a fake page, then exercise the message
// path. The youtube script runs in the MAIN world where chrome.* is
// unavailable, so shortcuts travel background → bridge (runtime message) →
// window envelope → this script; the tests post the window envelope
// directly and drive the bridge's runtime listener for the relay half.
// happy-dom delivers postMessage asynchronously, so every envelope needs a
// macrotask before its effect is asserted.

type MessageListener = (message: unknown) => boolean;

const WATCH_URL = 'https://www.youtube.com/watch?v=e2e-fixture';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/** Player response whose caption track serves the given fixture (mirror of
 * e2e/server.ts). Absent kind means a manual track, like the fixture map. */
function playerResponseWithCaptions(fixture: string, kind: string | undefined): unknown {
  return {
    videoDetails: {
      videoId: 'e2e-fixture',
      title: `unit fixture: ${fixture}`,
      channelId: 'UC-e2e-fixture',
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: `/api/timedtext?fixture=${fixture}`, ...(kind === undefined ? {} : { kind }), languageCode: 'en' },
        ],
      },
    },
  };
}

function sendShortcut(message: unknown): void {
  window.postMessage({ channel: 'speedwatcher:shortcut', message }, '*');
}

function pillHost(): HTMLElement | null {
  return document.querySelector('.speedwatcher-pill-host');
}

/** The pill's DOM lives in the host's open shadow root (real browsers never
 * render a shadow host's light-DOM children). */
function pillRoot(): ShadowRoot | null {
  return pillHost()?.shadowRoot ?? null;
}

function pillMode(): string | null {
  return pillRoot()?.querySelector('.pill')?.getAttribute('data-mode') ?? null;
}

function liveLine(): HTMLElement | null {
  return pillRoot()?.querySelector('.live-rate') ?? null;
}

function pillLabel(): string | null {
  return pillRoot()?.querySelector('.label')?.textContent ?? null;
}

function pillTier(): string | null {
  return pillRoot()?.querySelector('.tier')?.textContent ?? null;
}

/** Channel-memory records the in-process bridge serves back on channel:get
 * and captures on channel:put (mirror of lib/channel-memory storage). */
const channelRates = new Map<string, ChannelRecord>();

beforeEach(() => {
  vi.clearAllMocks();
  channelRates.clear();
  document.body.innerHTML = '';
  const happyDom = window as unknown as { happyDOM: { setURL(url: string): void } };
  happyDom.happyDOM.setURL(WATCH_URL);
  (window as unknown as Record<string, unknown>).ytInitialPlayerResponse = {};

  const video = document.createElement('video');
  // A playing video: happy-dom's default `paused` is true.
  Object.defineProperty(video, 'paused', { get: () => false, configurable: true });
  document.body.appendChild(video);

  // In-process bridge: answer settings:get, channel:get, and channel:put the
  // way the isolated bridge would.
  const onBridge = (event: MessageEvent): void => {
    const envelope = event.data as BridgeEnvelope | undefined;
    if (envelope?.channel !== 'speedwatcher:bridge' || envelope.direction !== 'request') return;
    const payload = envelope.payload as { id: number; type: string; channelKey?: string; record?: ChannelRecord };
    let result: unknown;
    if (payload.type === 'settings:get') result = defaultSettings();
    else if (payload.type === 'channel:get') result = channelRates.get(payload.channelKey ?? '') ?? null;
    else if (payload.type === 'channel:put' && payload.channelKey !== undefined) {
      channelRates.set(payload.channelKey, payload.record as ChannelRecord);
    }
    window.postMessage(
      {
        channel: 'speedwatcher:bridge',
        direction: 'response',
        payload: { id: payload.id, ok: true, result },
      },
      '*',
    );
  };
  window.addEventListener('message', onBridge);

  const main = (contentModule as { main: () => void }).main;
  main();
});

describe('bridge shortcut relay (background → MAIN world)', () => {
  it('forwards runtime shortcut messages to the window channel', async () => {
    const main = (bridgeModule as { main: () => void }).main;
    main();
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | MessageListener
      | undefined;
    if (!listener) throw new Error('no bridge runtime listener registered');

    const captured: unknown[] = [];
    window.addEventListener('message', (event) => {
      captured.push(event.data);
    });

    expect(listener({ type: 'speedwatcher:apply-shortcut' })).toBe(false);
    expect(listener({ type: 'speedwatcher:dismiss-shortcut' })).toBe(false);
    expect(listener({ type: 'something:else' })).toBe(false);
    await tick();
    // The measure chain also posts bridge envelopes on the same window; only
    // the shortcut channel is this relay's output.
    const shortcuts = captured.filter(
      (entry) => (entry as { channel?: string }).channel === 'speedwatcher:shortcut',
    );
    expect(shortcuts).toEqual([
      { channel: 'speedwatcher:shortcut', message: { type: 'speedwatcher:apply-shortcut' } },
      { channel: 'speedwatcher:shortcut', message: { type: 'speedwatcher:dismiss-shortcut' } },
    ]);
  });
});

describe('content shortcut envelope handling', () => {
  it('apply-shortcut applies the rate but keeps the live line hidden on the estimated tier', async () => {
    // The beforeEach player response has no caption tracks, so the measure
    // chain renders the estimated heuristic tier.
    const settings = defaultSettings();
    const site = 'youtube.com';
    const rec = recommend({
      naturalRate: priorMidpoint('generic'),
      tier: 'estimated',
      contentType: resolveContentType(settings, site, 'generic'),
      platformMax: resolvePlatformMax(settings, site),
      userTarget: resolveUserTarget(settings, site, resolveContentType(settings, site, 'generic')),
    });
    expect(rec.mode).toBe('recommend');

    // Pill renders after the measure chain resolves (bridge answered in-process).
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });

    sendShortcut({ type: 'speedwatcher:apply-shortcut' });

    const video = document.querySelector('video');
    await vi.waitFor(() => {
      expect(video?.playbackRate).toBe(rec.multiplier);
    });
    // Estimated-tier rates are priors, not measurements: the live line must
    // not present the heuristic as the video's measured rate.
    const live = liveLine();
    expect(live?.textContent).toBe('');
    expect(live?.hidden).toBe(true);
  });

  it('ratechange cannot resurrect the live line on the estimated tier', async () => {
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });
    sendShortcut({ type: 'speedwatcher:apply-shortcut' });

    const video = document.querySelector('video');
    await vi.waitFor(() => {
      expect(video?.playbackRate).not.toBe(1);
    });

    if (video === null) throw new Error('video missing');
    video.playbackRate = 2;
    video.dispatchEvent(new Event('ratechange'));
    await tick();
    expect(liveLine()?.textContent).toBe('');
    expect(liveLine()?.hidden).toBe(true);
  });

  it('measured-tier pill shows the live line after apply and follows ratechange', async () => {
    // Point the player response at a real caption fixture and stub the
    // timedtext fetch so the pipeline renders a measured (manual-cue) pill.
    const payload = fixture;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));
    (window as unknown as Record<string, unknown>).ytInitialPlayerResponse = playerResponseWithCaptions(
      'real/manual-cue.json',
      undefined,
    );
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));

    const { cues } = parseYouTubeJson3(payload);
    const naturalRate = manualCueRate(cues);
    if (naturalRate === null) throw new Error('manual-cue fixture: no natural rate');
    const rec = recommend({ naturalRate, tier: 'manual-cue', contentType: 'generic', platformMax: 2 });
    expect(rec.mode).toBe('recommend');

    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });

    sendShortcut({ type: 'speedwatcher:apply-shortcut' });
    const video = document.querySelector('video');
    await vi.waitFor(() => {
      expect(video?.playbackRate).toBe(rec.multiplier);
    });

    // P2b: at the applied multiplier the live rate duplicates the label's
    // effective rate — the line stays hidden; a divergent rate shows it.
    expect(liveLine()?.textContent).toBe('');
    expect(liveLine()?.hidden).toBe(true);

    if (video === null) throw new Error('video missing');
    video.playbackRate = 2;
    video.dispatchEvent(new Event('ratechange'));
    await vi.waitFor(() => {
      expect(liveLine()?.textContent).toBe(`now ≈ ${Math.round(naturalRate * 2)} wpm at 2x`);
    });
    expect(liveLine()?.hidden).toBe(false);
  });

  it('dismiss-shortcut hides the pill and later applies become no-ops', async () => {
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });
    const video = document.querySelector('video');

    sendShortcut({ type: 'speedwatcher:dismiss-shortcut' });
    await vi.waitFor(() => {
      expect(pillMode()).toBe('hidden');
    });

    // The recommendation is gone: apply-shortcut must not touch playbackRate.
    sendShortcut({ type: 'speedwatcher:apply-shortcut' });
    await tick();
    expect(video?.playbackRate).toBe(1);
  });

  it('ignores non-shortcut envelopes', async () => {
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });
    const video = document.querySelector('video');

    window.postMessage({ channel: 'something:else', message: { type: 'speedwatcher:apply-shortcut' } }, '*');
    window.postMessage({ channel: 'speedwatcher:shortcut', message: { type: 'bogus' } }, '*');
    await tick();
    expect(video?.playbackRate).toBe(1);
    expect(pillMode()).toBe('recommend');
  });
});

describe('channel rate memory wiring', () => {
  /** Measured render: stub the timedtext fetch with the manual-cue fixture
   * and re-run the measure chain (mirror of the measured-tier test above). */
  async function renderMeasured(): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fixture })));
    (window as unknown as Record<string, unknown>).ytInitialPlayerResponse = playerResponseWithCaptions(
      'real/manual-cue.json',
      undefined,
    );
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });
    await tick();
  }

  /** Estimated render with a known en track: stub the fetch to fail so the
   * pipeline falls to the estimated tier with language en. */
  async function renderEstimatedWithLanguage(): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async () => null));
    (window as unknown as Record<string, unknown>).ytInitialPlayerResponse = playerResponseWithCaptions(
      'real/manual-cue.json',
      undefined,
    );
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });
  }

  it('remembers the measured rate on a measured recommendation', async () => {
    await renderMeasured();
    const { cues } = parseYouTubeJson3(fixture);
    const naturalRate = manualCueRate(cues);
    if (naturalRate === null) throw new Error('manual-cue fixture: no natural rate');
    expect(channelRates.get('UC-e2e-fixture')).toEqual({
      rate: naturalRate,
      unit: 'wpm',
      language: 'en',
      ts: expect.any(Number),
    });
  });

  it('seeds the estimated tier from the channel memory in the same language', async () => {
    channelRates.set('UC-e2e-fixture', { rate: 150, unit: 'wpm', language: 'en', ts: 1 });
    await renderEstimatedWithLanguage();
    // The pill renders the seeded rate's recommendation, still labeled
    // estimated — the prior got smarter, the tier did not.
    const seeded = recommend({ naturalRate: 150, tier: 'estimated', contentType: 'generic', platformMax: 2 });
    expect(pillLabel()).toBe(seeded.label);
    expect(pillTier()).toBe('estimated');
  });

  it('ignores channel memory measured in another language', async () => {
    channelRates.set('UC-e2e-fixture', { rate: 150, unit: 'wpm', language: 'ru', ts: 1 });
    await renderEstimatedWithLanguage();
    const fallback = recommend({
      naturalRate: priorMidpoint('generic'),
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
    });
    expect(pillLabel()).toBe(fallback.label);
    expect(pillTier()).toBe('estimated');
  });

  it('does not remember a rate without a stable channel key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fixture })));
    (window as unknown as Record<string, unknown>).ytInitialPlayerResponse = {
      videoDetails: { videoId: 'e2e-fixture' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: '/api/timedtext', languageCode: 'en' }],
        },
      },
    };
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });
    await tick();
    expect(channelRates.size).toBe(0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wpm:get measured-rate answer', () => {
  /** Captures response envelopes on the wpm channel (the test's own request
   * posting arrives on the same channel first). */
  function captureWpmAnswers(): { answers: unknown[]; detach: () => void } {
    const answers: unknown[] = [];
    const onWindow = (event: MessageEvent): void => {
      const envelope = event.data as { channel?: string; message?: unknown };
      if (envelope.channel === 'speedwatcher:wpm' && typeof envelope.message === 'object' && envelope.message !== null && 'ok' in envelope.message) {
        answers.push(event.data);
      }
    };
    window.addEventListener('message', onWindow);
    return { answers, detach: () => window.removeEventListener('message', onWindow) };
  }

  it('answers from the measurement context without the videoId', async () => {
    // Estimated tier: the beforeEach player response has no caption tracks.
    const settings = defaultSettings();
    const site = 'youtube.com';
    const contentType = resolveContentType(settings, site, 'generic');
    const rec = recommend({
      naturalRate: priorMidpoint('generic'),
      tier: 'estimated',
      contentType,
      platformMax: resolvePlatformMax(settings, site),
      userTarget: resolveUserTarget(settings, site, contentType),
    });
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });

    const { answers, detach } = captureWpmAnswers();
    window.postMessage({ channel: 'speedwatcher:wpm', message: { type: 'wpm:get', version: 1 } }, '*');
    await tick();
    detach();

    // main() ran once per test in this file, so every content-script
    // instance answers the same channel; the last answer is authoritative.
    expect(answers.length).toBeGreaterThan(0);
    const answer = (answers.at(-1) as { message: WpmGetResponseOk }).message;
    expect(answer).toMatchObject({
      ok: true,
      version: 1,
      site: 'youtube.com',
      unit: 'wpm',
      language: null,
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
      recommendation: { target: 250, mode: 'recommend' },
    });
    expect(answer.naturalRate).toBeCloseTo(priorMidpoint('generic'), 5);
    expect(answer.recommendation.recommendedMultiplier).toBeCloseTo(rec.multiplier, 5);
    expect(JSON.stringify(answer)).not.toContain('videoId');
  });

  it('reports no-active-video when no measurement exists', async () => {
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });
    // SPA navigation invalidates the previous video's measurement.
    document.dispatchEvent(new Event('yt-navigate-start'));

    const { answers, detach } = captureWpmAnswers();
    window.postMessage({ channel: 'speedwatcher:wpm', message: { type: 'wpm:get', version: 1 } }, '*');
    await tick();
    detach();

    expect(answers.length).toBeGreaterThan(0);
    expect((answers.at(-1) as { message: unknown }).message).toEqual({
      ok: false,
      error: 'no-active-video',
    });
  });

  it('ignores malformed envelopes on the channel', async () => {
    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });

    const { answers, detach } = captureWpmAnswers();
    window.postMessage({ channel: 'speedwatcher:wpm', message: { type: 'bogus' } }, '*');
    window.postMessage({ channel: 'speedwatcher:shortcut', message: { type: 'wpm:get', version: 1 } }, '*');
    await tick();
    detach();

    expect(answers).toHaveLength(0);
  });
});

describe('bridge wpm:get relay (background → window → sendResponse)', () => {
  it('round-trips the runtime request through the window answer', async () => {
    const main = (bridgeModule as { main: () => void }).main;
    main();
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean)
      | undefined;
    if (!listener) throw new Error('no bridge runtime listener registered');

    await vi.waitFor(() => {
      expect(pillMode()).toBe('recommend');
    });

    const response = await new Promise<unknown>((resolve) => {
      const returned = listener({ type: 'wpm:get', version: 1 }, {}, resolve);
      expect(returned).toBe(true);
    });
    expect(response).toMatchObject({ ok: true, version: 1, site: 'youtube.com', tier: 'estimated' });
  });

  it('keeps the shortcut relay one-way (no response)', async () => {
    const main = (bridgeModule as { main: () => void }).main;
    main();
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean)
      | undefined;
    if (!listener) throw new Error('no bridge runtime listener registered');

    expect(listener({ type: 'speedwatcher:apply-shortcut' }, {}, vi.fn())).toBe(false);
  });
});
