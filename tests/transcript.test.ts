// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimedtextBuffer } from '../lib/caption-capture';
import { fetchAndroidCaptions, fetchCaptions } from '../lib/caption-fetch';
import type { PlayerResponse } from '../lib/youtube';
import {
  fetchTranscriptViaEndpoint,
  getTranscriptParams,
  parseTranscriptSegments,
} from '../lib/transcript';
import { parseYouTubeJson3 } from '../lib/captions';

function panelWithParams(params: string): unknown {
  return {
    engagementPanelSectionListRenderer: {
      targetId: 'engagement-panel-searchable-transcript',
      content: {
        transcriptRenderer: {
          content: {
            transcriptSearchPanelRenderer: {
              footer: {
                transcriptFooterRenderer: {
                  primaryButton: {
                    buttonRenderer: {
                      command: { getTranscriptEndpoint: { params } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function transcriptResponse(): unknown {
  return {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [
                        {
                          transcriptSegmentRenderer: {
                            startMs: '6000',
                            snippet: { runs: [{ text: 'kilo lima' }, { text: ' mike' }] },
                          },
                        },
                        {
                          transcriptSegmentRenderer: {
                            startMs: '0',
                            snippet: { simpleText: 'alpha bravo' },
                          },
                        },
                        {
                          transcriptSegmentRenderer: {
                            startMs: '3000',
                            snippet: { runs: [{ text: 'foxtrot' }] },
                          },
                        },
                        // Untimed / textless entries must be dropped.
                        {
                          transcriptSegmentRenderer: { snippet: { runs: [{ text: 'orphan' }] } },
                        },
                        {
                          transcriptSegmentRenderer: { startMs: '9000', snippet: { runs: [] } },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}

function androidResponse(params?: string): unknown {
  return {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ baseUrl: '/api/timedtext?fmt=json3' }],
      },
    },
    ...(params === undefined ? {} : { engagementPanels: [panelWithParams(params)] }),
  };
}

/** The WEB playerResponse of a transcript-gated page: the caption track plus
 * the engagement panel carrying the getTranscriptEndpoint params — the same
 * panel shape the ANDROID response uses. */
function webResponse(params?: string): PlayerResponse {
  return {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ baseUrl: '/api/timedtext?fmt=json3' }],
      },
    },
    ...(params === undefined ? {} : { engagementPanels: [panelWithParams(params)] }),
  };
}

/** The logged-in ANDROID failure mode (asbplayer #978): the innertube
 * player POST answers LOGIN_REQUIRED with no caption tracks. */
function loginRequiredResponse(): unknown {
  return {
    playabilityStatus: {
      status: 'LOGIN_REQUIRED',
      reason: "Sign in to confirm you're not a bot",
    },
  };
}

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

const json3Payload = { events: [{ tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'hello world ' }] }] };

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { ytcfg?: unknown }).ytcfg;
});

describe('getTranscriptParams', () => {
  it('finds the params in the transcript panel footer button command', () => {
    expect(getTranscriptParams({ engagementPanels: [panelWithParams('abc123')] })).toBe('abc123');
  });

  it('extracts the params from the WEB playerResponse engagement panel (the fixture shape)', () => {
    expect(getTranscriptParams(webResponse('WEB_PARAMS'))).toBe('WEB_PARAMS');
  });

  it('bails to null without a transcript panel, empty params, or garbage', () => {
    expect(getTranscriptParams({})).toBeNull();
    expect(getTranscriptParams({ engagementPanels: [] })).toBeNull();
    expect(getTranscriptParams({ engagementPanels: [panelWithParams('')] })).toBeNull();
    expect(getTranscriptParams({ engagementPanels: [{ other: 1 }] })).toBeNull();
    expect(getTranscriptParams(null)).toBeNull();
    expect(getTranscriptParams('nope')).toBeNull();
  });
});

describe('parseTranscriptSegments', () => {
  it('parses the segment list into sorted cue-level segments (no durations)', () => {
    const segments = parseTranscriptSegments(transcriptResponse());
    expect(segments).toEqual([
      { text: 'alpha bravo', startSec: 0 },
      { text: 'foxtrot', startSec: 3 },
      { text: 'kilo lima mike', startSec: 6 },
    ]);
  });

  it('returns [] for payloads without the panel update or actions', () => {
    expect(parseTranscriptSegments({})).toEqual([]);
    expect(parseTranscriptSegments({ actions: [] })).toEqual([]);
    expect(parseTranscriptSegments({ actions: [{ updateEngagementPanelAction: { content: {} } }] })).toEqual([]);
    expect(parseTranscriptSegments(null)).toEqual([]);
    expect(parseTranscriptSegments('nope')).toEqual([]);
  });

  it('feeds the cue tier like a json3 payload through the windows shape', () => {
    const segments = parseTranscriptSegments(transcriptResponse());
    // The windows shape is what the fetch wrapper returns; parseYouTubeJson3
    // must produce the same cues the segment list does.
    const windows = {
      windows: segments.map((s) => ({ startMs: Math.round(s.startSec * 1000), text: s.text })),
    };
    const { words, cues } = parseYouTubeJson3(windows);
    expect(words).toEqual([]);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ text: 'alpha bravo', startSec: 0 });
  });
});

describe('fetchTranscriptViaEndpoint', () => {
  it('bails to null when ytcfg carries no innertube identity', async () => {
    const fetchMock = mockFetch(() => ({ ok: true, body: transcriptResponse() }));
    expect(await fetchTranscriptViaEndpoint('params')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bails when INNERTUBE_API_KEY or INNERTUBE_CONTEXT are absent', async () => {
    window.ytcfg = { get: () => undefined };
    const fetchMock = mockFetch(() => ({ ok: true, body: transcriptResponse() }));
    expect(await fetchTranscriptViaEndpoint('params')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the endpoint with key + context and converts segments to the windows shape', async () => {
    window.ytcfg = {
      get: (name: string) =>
        name === 'INNERTUBE_API_KEY'
          ? 'FIXTURE_KEY'
          : name === 'INNERTUBE_CONTEXT'
            ? { client: { clientName: 'WEB' } }
            : undefined,
    };
    const fetchMock = mockFetch(() => ({ ok: true, body: transcriptResponse() }));
    const result = (await fetchTranscriptViaEndpoint('abc123')) as { windows: unknown[] };
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('http://localhost:3000/youtubei/v1/get_transcript?key=FIXTURE_KEY');
    expect(JSON.parse(String(init.body))).toEqual({
      context: { client: { clientName: 'WEB' } },
      params: 'abc123',
    });
    expect(result.windows).toEqual([
      { startMs: 0, text: 'alpha bravo' },
      { startMs: 3000, text: 'foxtrot' },
      { startMs: 6000, text: 'kilo lima mike' },
    ]);
  });

  it('bails on a non-ok response and on an empty segment list', async () => {
    window.ytcfg = {
      get: (name: string) =>
        name === 'INNERTUBE_API_KEY' ? 'FIXTURE_KEY' : name === 'INNERTUBE_CONTEXT' ? { client: {} } : undefined,
    };
    const failing = mockFetch(() => ({ ok: false, body: {} }));
    expect(await fetchTranscriptViaEndpoint('abc123')).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
    const empty = mockFetch(() => ({ ok: true, body: { actions: [] } }));
    expect(await fetchTranscriptViaEndpoint('abc123')).toBeNull();
    expect(empty).toHaveBeenCalledTimes(1);
  });
});

describe('fetchAndroidCaptions fallback ordering', () => {
  it('lands on get_transcript when the ANDROID response carries params; the bare baseUrl fetch never fires', async () => {
    window.ytcfg = {
      get: (name: string) =>
        name === 'INNERTUBE_API_KEY' ? 'FIXTURE_KEY' : name === 'INNERTUBE_CONTEXT' ? { client: {} } : undefined,
    };
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/youtubei/v1/player') return { ok: true, body: androidResponse('abc123') };
      if (url.pathname === '/youtubei/v1/get_transcript') return { ok: true, body: transcriptResponse() };
      return { ok: true, body: json3Payload };
    });
    const result = (await fetchAndroidCaptions('vid')) as { windows: unknown[] };
    expect(result.windows).toHaveLength(3);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/youtubei/v1/player', '/youtubei/v1/get_transcript']);
    expect(paths).not.toContain('/api/timedtext');
  });

  it('falls through to the bare baseUrl fetch when the ANDROID response has no params', async () => {
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/youtubei/v1/player') return { ok: true, body: androidResponse() };
      return { ok: true, body: json3Payload };
    });
    const result = await fetchAndroidCaptions('vid');
    expect(result).toEqual(json3Payload);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/youtubei/v1/player', '/api/timedtext']);
  });

  it('falls through to the bare baseUrl fetch when get_transcript fails', async () => {
    window.ytcfg = {
      get: (name: string) =>
        name === 'INNERTUBE_API_KEY' ? 'FIXTURE_KEY' : name === 'INNERTUBE_CONTEXT' ? { client: {} } : undefined,
    };
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/youtubei/v1/player') return { ok: true, body: androidResponse('abc123') };
      if (url.pathname === '/youtubei/v1/get_transcript') return { ok: false, body: {} };
      return { ok: true, body: json3Payload };
    });
    const result = await fetchAndroidCaptions('vid');
    expect(result).toEqual(json3Payload);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/youtubei/v1/player', '/youtubei/v1/get_transcript', '/api/timedtext']);
  });

  it('returns null when the ANDROID player POST fails', async () => {
    const fetchMock = mockFetch(() => ({ ok: false, body: {} }));
    expect(await fetchAndroidCaptions('vid')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCaptions fallback chain', () => {
  const track = { baseUrl: '/api/timedtext?fmt=json3' };
  const emptyCtx = {
    buffer: new TimedtextBuffer(),
    video: null,
    playerResponse: webResponse('WEB_PARAMS'),
  };

  function innertubeYtcfg(): void {
    window.ytcfg = {
      get: (name: string) =>
        name === 'INNERTUBE_API_KEY'
          ? 'FIXTURE_KEY'
          : name === 'INNERTUBE_CONTEXT'
            ? { client: { clientName: 'WEB' } }
            : undefined,
    };
  }

  it('fires get_transcript from the WEB response params when the ANDROID POST fails', async () => {
    innertubeYtcfg();
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/api/timedtext') return { ok: false, body: {} };
      if (url.pathname === '/youtubei/v1/player') return 'throw';
      if (url.pathname === '/youtubei/v1/get_transcript') return { ok: true, body: transcriptResponse() };
      return { ok: true, body: json3Payload };
    });
    const result = await fetchCaptions(track, 'vid', emptyCtx);
    expect(result.source).toBe('android');
    expect((result.json as { windows: unknown[] }).windows).toHaveLength(3);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/api/timedtext', '/youtubei/v1/player', '/youtubei/v1/get_transcript']);
  });

  it('lands on get_transcript when the ANDROID response is LOGIN_REQUIRED-shaped', async () => {
    innertubeYtcfg();
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/api/timedtext') return { ok: false, body: {} };
      if (url.pathname === '/youtubei/v1/player') return { ok: true, body: loginRequiredResponse() };
      if (url.pathname === '/youtubei/v1/get_transcript') return { ok: true, body: transcriptResponse() };
      return { ok: true, body: json3Payload };
    });
    const result = await fetchCaptions(track, 'vid', emptyCtx);
    expect(result.source).toBe('android');
    expect((result.json as { windows: unknown[] }).windows).toHaveLength(3);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/api/timedtext', '/youtubei/v1/player', '/youtubei/v1/get_transcript']);
  });

  it('ends at none without WEB params: no get_transcript POST fires', async () => {
    innertubeYtcfg();
    const fetchMock = mockFetch((url) => {
      if (url.pathname === '/api/timedtext') return { ok: false, body: {} };
      if (url.pathname === '/youtubei/v1/player') return { ok: true, body: loginRequiredResponse() };
      return { ok: true, body: json3Payload };
    });
    const result = await fetchCaptions(track, 'vid', {
      ...emptyCtx,
      playerResponse: webResponse(),
    });
    expect(result).toEqual({ json: null, source: 'none' });
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(['/api/timedtext', '/youtubei/v1/player']);
  });
});
