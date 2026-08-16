// @vitest-environment happy-dom
// Userscript measure-lane spec (userscript/src/main.ts): drives the real
// entry through the E2E pill hook. The player-response wait and the caption
// fetch are gated so the test decides when a measure completes; the
// wpm/recommend math is real, fed by tests/fixtures/real/manual-cue.json (a
// captured payload — 20 cues, 0 words, 181.8 wpm, recommend 1.4x).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeasureEventDetail } from '../lib/measure-hooks';
import type { PlayerResponse } from '../lib/youtube';

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real', 'manual-cue.json'), 'utf8'),
) as unknown;

interface Gate<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const h = vi.hoisted(() => {
  function makeGate<T>(): Gate<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const state = { gates: [] as Gate<PlayerResponse>[] };
  return {
    gates: state.gates,
    makeGate,
    waitForPlayerResponse: vi.fn(() => state.gates.shift()?.promise ?? Promise.resolve(undefined)),
    fetchCaptions: vi.fn(async () => ({ json: fixture, source: 'web' as const })),
    installCaptionCapture: vi.fn(),
  };
});

vi.mock('@/lib/measure-hooks', () => ({ waitForPlayerResponse: h.waitForPlayerResponse }));
vi.mock('@/lib/caption-fetch', () => ({ fetchCaptions: h.fetchCaptions }));
vi.mock('@/lib/caption-capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/caption-capture')>();
  return { ...actual, installCaptionCapture: h.installCaptionCapture };
});

function responseFor(videoId: string): PlayerResponse {
  return {
    videoDetails: { videoId, channelId: 'UCsmoke', author: 'Smoke Channel', lengthSeconds: '300' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`, kind: 'manual', languageCode: 'en' },
        ],
      },
    },
  };
}

/** Resolves with the measure line of the given video — the point where the
 * measure is about to render (logMeasure precedes renderRecommendation). */
function nextMeasure(videoId: string): Promise<MeasureEventDetail> {
  return new Promise((resolve) => {
    window.addEventListener(
      'speedwatcher:measure',
      (event) => {
        const detail = (event as CustomEvent<MeasureEventDetail>).detail;
        if (detail.videoId === videoId) resolve(detail);
      },
      { once: true },
    );
  });
}

let initialGate: Gate<PlayerResponse>;

beforeAll(async () => {
  window.__speedwatcherE2E = true;
  window.location.href = 'https://www.youtube.com/watch?v=AAA';
  initialGate = h.makeGate<PlayerResponse>();
  h.gates.push(initialGate);
  // The import runs main(): the initial-load measure is now in flight.
  await import('../userscript/src/main');
});

beforeEach(() => {
  h.gates.length = 0;
});

describe('mid-measure navigation', () => {
  it('drops the stale render when navigation lands while the measure is in flight', async () => {
    const stale = nextMeasure('AAA');
    document.dispatchEvent(new Event('yt-navigate-start'));
    initialGate.resolve(responseFor('AAA'));
    const detail = await stale;
    // The old measure ran to completion — it must not render on the new video.
    expect(detail.videoId).toBe('AAA');
    await vi.waitFor(() => {
      expect(window.__speedwatcherPill?.state?.mode).toBe('none');
      expect(window.__speedwatcherPill?.state?.rateWpm).toBe(0);
    });
  });

  it('renders a measure taken after the navigation', async () => {
    const fresh = nextMeasure('BBB');
    const gate = h.makeGate<PlayerResponse>();
    h.gates.push(gate);
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    gate.resolve(responseFor('BBB'));
    const detail = await fresh;
    expect(detail.videoId).toBe('BBB');
    await vi.waitFor(() => {
      const state = window.__speedwatcherPill?.state;
      expect(state?.mode).toBe('recommend');
      expect(state?.rateWpm).toBeCloseTo(181.8, 0);
      expect(state?.effectiveWpm).toBeCloseTo(254.5, 0);
    });
  });
});
