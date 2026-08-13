// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import contentModule from '../entrypoints/content';
import bridgeModule from '../entrypoints/bridge.content';
import { parseYouTubeJson3 } from '../lib/captions';
import type { BridgeEnvelope } from '../lib/messaging';
import { priorMidpoint } from '../lib/heuristics';
import { recommend } from '../lib/recommend';
import { defaultSettings, resolveContentType, resolvePlatformMax, resolveTarget } from '../lib/settings';
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
    videoDetails: { videoId: 'e2e-fixture', title: `unit fixture: ${fixture}` },
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

function pillMode(): string | null {
  return pillHost()?.querySelector('.pill')?.getAttribute('data-mode') ?? null;
}

function liveLine(): HTMLElement | null {
  return pillHost()?.querySelector('.live-rate') ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  const happyDom = window as unknown as { happyDOM: { setURL(url: string): void } };
  happyDom.happyDOM.setURL(WATCH_URL);
  (window as unknown as Record<string, unknown>).ytInitialPlayerResponse = {};

  const video = document.createElement('video');
  // A playing video: happy-dom's default `paused` is true.
  Object.defineProperty(video, 'paused', { get: () => false, configurable: true });
  document.body.appendChild(video);

  // In-process bridge: answer settings:get the way the isolated bridge would.
  const onBridge = (event: MessageEvent): void => {
    const envelope = event.data as BridgeEnvelope | undefined;
    if (envelope?.channel !== 'speedwatcher:bridge' || envelope.direction !== 'request') return;
    const payload = envelope.payload as { id: number };
    window.postMessage(
      {
        channel: 'speedwatcher:bridge',
        direction: 'response',
        payload: { id: payload.id, ok: true, result: defaultSettings() },
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
      userTarget: resolveTarget(settings, site, resolveContentType(settings, site, 'generic')),
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

    const fmt = (m: number): string => String(Math.round(m * 100) / 100);
    expect(liveLine()?.textContent).toBe(
      `now ≈ ${Math.round(naturalRate * rec.multiplier)} wpm at ${fmt(rec.multiplier)}x`,
    );
    expect(liveLine()?.hidden).toBe(false);

    if (video === null) throw new Error('video missing');
    video.playbackRate = 2;
    video.dispatchEvent(new Event('ratechange'));
    await vi.waitFor(() => {
      expect(liveLine()?.textContent).toBe(`now ≈ ${Math.round(naturalRate * 2)} wpm at 2x`);
    });
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

afterEach(() => {
  vi.unstubAllGlobals();
});
