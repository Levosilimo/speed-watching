// @vitest-environment happy-dom
// Leaf-level caption-fetch unit tests (lib/caption-fetch.ts): fetchJson3's
// fmt parameter handling, the ANDROID player POST contract (client identity
// in the body), and the fetchCaptions all-fail tail. The chain-model suite
// (tests/chain-model.test.ts) drives the whole fallback chain including the
// capture fast path; these pin the request shapes the chain's coarse stubs
// leave unasserted — the wave-5 mutation run found 30 surviving mutants in
// this file, most of them in the request-building leaves.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimedtextBuffer } from '../lib/caption-capture';
import { fetchAndroidCaptions, fetchCaptions, fetchJson3 } from '../lib/caption-fetch';
import type { CaptionTrack } from '../lib/youtube';

function mockFetch(byUrl: (url: URL) => { ok: boolean; body: unknown } | 'throw'): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const answer = byUrl(url);
    if (answer === 'throw') throw new Error('network down');
    return { ok: answer.ok, json: async () => answer.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json3Payload = { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello ' }] }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchJson3', () => {
  it('appends fmt=json3 when the base URL carries no fmt, and keeps an existing one', async () => {
    const fetchMock = mockFetch(() => ({ ok: true, body: json3Payload }));
    await fetchJson3('/api/timedtext?lang=en');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('fmt=json3');
    await fetchJson3('/api/timedtext?fmt=vtt&lang=en');
    const second = String(fetchMock.mock.calls[1]?.[0]);
    expect(second).toContain('fmt=vtt');
    expect(second).not.toContain('fmt=json3');
  });

  it('returns null on a non-ok response and on a payload that fails to parse', async () => {
    const failing = mockFetch(() => ({ ok: false, body: {} }));
    expect(await fetchJson3('/api/timedtext')).toBeNull();
    const throwing = mockFetch(() => 'throw');
    expect(await fetchJson3('/api/timedtext')).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});

describe('fetchAndroidCaptions', () => {
  it('POSTs the innertube player endpoint with the ANDROID client identity', async () => {
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/youtubei/v1/player') return { ok: true, body: { captions: {} } };
      return { ok: true, body: json3Payload };
    });
    await fetchAndroidCaptions('vid');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/youtubei/v1/player');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.31' } },
      videoId: 'vid',
    });
  });

  it('returns null when the player response carries no caption tracks', async () => {
    const fetchMock = mockFetch(() => ({ ok: true, body: { captions: {} } }));
    expect(await fetchAndroidCaptions('vid')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCaptions all-fail tail', () => {
  const track: CaptionTrack = { baseUrl: '/api/timedtext?fmt=json3' };

  it('ends at none when every fallback fails and the response carries no transcript params', async () => {
    const buffer = new TimedtextBuffer();
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/youtubei/v1/player') return { ok: true, body: { captions: {} } };
      return { ok: false, body: {} };
    });
    const result = await fetchCaptions(track, 'vid', { buffer, video: null, playerResponse: null });
    expect(result).toEqual({ json: null, source: 'none' });
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/api/timedtext', '/youtubei/v1/player']);
  });
});
