import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VTTCue } from 'vtt.js';
import {
  cleanVttText,
  harvestCaptions,
  parseEdxTranscript,
  parseHlsSubtitleUris,
  parseVtt,
  type FetchLike,
  type HarvestOptions,
  type VttHost,
} from '../lib/captions-harvest';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/synthetic/${name}`, import.meta.url)), 'utf8');

const VTT_HOST: VttHost = {
  VTTCue,
  document: {
    createElement: (tagName: string) => ({ tagName, style: {}, children: [], appendChild() {}, setAttribute() {} }),
  },
};

function stubFetch(routes: Map<string, { ok?: boolean; body: string | unknown }>): (url: string) => Promise<FetchLike> {
  return async (url) => {
    const route = routes.get(url);
    if (route === undefined) return { ok: false, json: async () => null, text: async () => '' };
    return {
      ok: route.ok ?? true,
      json: async () => (typeof route.body === 'string' ? JSON.parse(route.body) : route.body),
      text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body)),
    };
  };
}

function options(overrides: Partial<HarvestOptions> = {}): HarvestOptions {
  return {
    videoSrc: null,
    resourceUrls: [],
    hostname: 'example.com',
    pageOrigin: 'https://example.com',
    vimeoConfig: null,
    vttHost: VTT_HOST,
    fetchImpl: stubFetch(new Map()),
    ...overrides,
  };
}

describe('cleanVttText', () => {
  it('strips tags and decodes entities', () => {
    expect(cleanVttText('<v Speaker>A &amp; B</v> &lt;ok&gt; &nbsp;end')).toBe('A & B <ok> end');
  });
});

describe('parseVtt', () => {
  it('parses a fixture into cue-level segments', () => {
    const segments = parseVtt(fixture('sample.vtt'), VTT_HOST);
    expect(segments).toEqual([
      { text: 'Welcome back to the show.', startSec: 0, durSec: 2.5 },
      { text: 'Second cue with markup', startSec: 2.5, durSec: 2.5 },
      { text: 'A & B, 1 < 2 > 0 now', startSec: 5, durSec: 2.25 },
      { text: 'Last line here', startSec: 7.25, durSec: 1.75 },
    ]);
  });

  it('skips empty cues', () => {
    expect(parseVtt('WEBVTT\n\n00:00.000 --> 00:01.000\n\n00:01.000 --> 00:02.000\nkept\n', VTT_HOST)).toEqual([
      { text: 'kept', startSec: 1, durSec: 1 },
    ]);
  });
});

describe('parseHlsSubtitleUris', () => {
  it('extracts SUBTITLES URIs from a master playlist fixture', () => {
    expect(parseHlsSubtitleUris(fixture('hls/master.m3u8'))).toEqual(['../sample.vtt']);
  });

  it('ignores non-subtitle media entries and dedupes', () => {
    const playlist =
      '#EXTM3U\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m4a"\n' +
      '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="a.vtt"\n' +
      '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="a.vtt"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=100\n' +
      'v.m3u8\n';
    expect(parseHlsSubtitleUris(playlist)).toEqual(['a.vtt']);
  });

  it('returns an empty list for a playlist without media tags', () => {
    expect(parseHlsSubtitleUris('#EXTM3U\n#EXTINF:10,\nseg.ts\n')).toEqual([]);
  });
});

describe('parseEdxTranscript', () => {
  it('parses parallel start/text arrays with durations', () => {
    const segments = parseEdxTranscript(JSON.parse(fixture('edx-transcript.json')));
    expect(segments.map((s) => s.text)).toEqual([
      'Welcome to the lecture.',
      'This is the second sentence.',
      'And a third.',
    ]);
    expect(segments[0]?.startSec).toBe(0.1);
    expect(segments[0]?.durSec).toBeCloseTo(2.3, 12);
    expect(segments[1]?.durSec).toBeCloseTo(1.8, 12);
    expect(segments[2]?.durSec).toBeUndefined();
  });

  it('returns an empty list on mismatched or missing arrays', () => {
    expect(parseEdxTranscript({ start: [1], text: ['a', 'b'] })).toEqual([]);
    expect(parseEdxTranscript({ start: [1] })).toEqual([]);
    expect(parseEdxTranscript(null)).toEqual([]);
  });
});

describe('harvestCaptions', () => {
  it('follows the HLS master playlist to its subtitle VTT', async () => {
    const master = fixture('hls/master.m3u8');
    const vtt = fixture('sample.vtt');
    const fetchImpl = stubFetch(
      new Map([
        ['https://cdn.example.com/hls/master.m3u8', { body: master }],
        ['https://cdn.example.com/sample.vtt', { body: vtt }],
      ]),
    );
    const result = await harvestCaptions(
      options({
        resourceUrls: ['https://cdn.example.com/hls/master.m3u8'],
        fetchImpl,
      }),
    );
    expect(result?.length).toBe(4);
    expect(result?.[0]).toEqual({ text: 'Welcome back to the show.', startSec: 0, durSec: 2.5 });
  });

  it('accepts the manifest named by the video src', async () => {
    const vtt = fixture('sample.vtt');
    const fetchImpl = stubFetch(
      new Map([
        ['https://site.example/video/master.m3u8', { body: fixture('hls/master.m3u8') }],
        ['https://site.example/sample.vtt', { body: vtt }],
      ]),
    );
    const result = await harvestCaptions(
      options({
        videoSrc: 'https://site.example/video/master.m3u8',
        fetchImpl,
      }),
    );
    expect(result?.length).toBe(4);
  });

  it('returns null when the master playlist has no subtitle entries', async () => {
    const fetchImpl = stubFetch(
      new Map([['https://cdn.example.com/hls/master.m3u8', { body: '#EXTM3U\n#EXTINF:10,\nseg.ts\n' }]]),
    );
    const result = await harvestCaptions(
      options({
        resourceUrls: ['https://cdn.example.com/hls/master.m3u8'],
        fetchImpl,
      }),
    );
    expect(result).toBeNull();
  });

  it('reads the Vimeo player config on vimeo hosts', async () => {
    const fetchImpl = stubFetch(
      new Map([
        ['https://player.vimeo.com/play/123/config?h=abc', {
          body: {
            request: {
              text_tracks: [
                { lang: 'en', url: 'https://player.vimeo.com/texttrack/1.vtt' },
                { lang: 'de', url: 'https://player.vimeo.com/texttrack/2.vtt' },
              ],
            },
          },
        }],
        ['https://player.vimeo.com/texttrack/1.vtt', { body: fixture('sample.vtt') }],
      ]),
    );
    const result = await harvestCaptions(
      options({
        hostname: 'player.vimeo.com',
        pageOrigin: 'https://player.vimeo.com',
        vimeoConfig: {
          __vimeo_player_config__: {
            player: { config_url: 'https://player.vimeo.com/play/123/config?h=abc' },
          },
        },
        fetchImpl,
      }),
    );
    expect(result?.length).toBe(4);
  });

  it('skips the Vimeo config probe on non-Vimeo hosts', async () => {
    const fetched: string[] = [];
    const fetchImpl = async (url: string): Promise<FetchLike> => {
      fetched.push(url);
      return { ok: false, json: async () => null, text: async () => '' };
    };
    const result = await harvestCaptions(
      options({
        hostname: 'example.com',
        vimeoConfig: { __vimeo_player_config__: { player: { config_url: 'https://player.vimeo.com/play/123/config' } } },
        fetchImpl,
      }),
    );
    expect(result).toBeNull();
    expect(fetched).not.toContain('https://player.vimeo.com/play/123/config');
  });

  it('parses a VTT resource entry loaded directly by the page', async () => {
    const fetchImpl = stubFetch(new Map([['https://site.example/captions.en.vtt', { body: fixture('sample.vtt') }]]));
    const result = await harvestCaptions(
      options({
        resourceUrls: ['https://site.example/captions.en.vtt'],
        fetchImpl,
      }),
    );
    expect(result?.length).toBe(4);
  });

  it('parses an edX sjson transcript from the resource timeline', async () => {
    const fetchImpl = stubFetch(
      new Map([['https://courses.example.com/api/transcripts/v1/course/video/en', { body: fixture('edx-transcript.json') }]]),
    );
    const result = await harvestCaptions(
      options({
        hostname: 'courses.example.com',
        pageOrigin: 'https://courses.example.com',
        resourceUrls: ['https://courses.example.com/api/transcripts/v1/course/video/en'],
        fetchImpl,
      }),
    );
    expect(result?.[1]?.text).toBe('This is the second sentence.');
    expect(result?.[1]?.startSec).toBe(2.4);
    expect(result?.[1]?.durSec).toBeCloseTo(1.8, 12);
  });

  it('skips cross-origin transcript endpoints', async () => {
    const fetchImpl = stubFetch(
      new Map([['https://other.example.com/api/transcripts/v1/course/video/en', { body: fixture('edx-transcript.json') }]]),
    );
    const result = await harvestCaptions(
      options({
        resourceUrls: ['https://other.example.com/api/transcripts/v1/course/video/en'],
        fetchImpl,
      }),
    );
    expect(result).toBeNull();
  });

  it('returns null when every probe fails', async () => {
    const result = await harvestCaptions(options({ resourceUrls: ['https://cdn.example.com/hls/x.m3u8'] }));
    expect(result).toBeNull();
  });
});
