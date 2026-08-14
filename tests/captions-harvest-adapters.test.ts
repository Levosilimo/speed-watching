import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vttjs from 'vtt.js';
import {
  harvestCaptions,
  normalizeSrt,
  parseSrt,
  parseVttWords,
  type FetchLike,
  type HarvestOptions,
  type VttHost,
} from '../lib/captions-harvest';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/synthetic/${name}`, import.meta.url)), 'utf8');

const VTT_HOST: VttHost = {
  VTTCue: vttjs.VTTCue,
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
    trackSrcs: [],
    hostname: 'example.com',
    pageOrigin: 'https://example.com',
    vimeoConfig: null,
    vttHost: VTT_HOST,
    fetchImpl: stubFetch(new Map()),
    ...overrides,
  };
}

describe('parseVttWords', () => {
  it('expands Dzen word-timing runs into per-word segments with backfilled durations', () => {
    const words = parseVttWords(fixture('dzen-word.vtt'), VTT_HOST);
    expect(words.map((w) => w.text)).toEqual([
      'С',
      'самого',
      'начала',
      'вы',
      'уже',
      'знаете',
      'что',
      'такое',
      'скорость',
      'и',
      'почему',
      'она',
      'важна',
      'для',
      'восприятия',
      'речи',
    ]);
    expect(words[0]?.startSec).toBeCloseTo(19.225, 12);
    expect(words[0]?.durSec).toBeCloseTo(0, 12); // untimed lead attaches to the first timed start
    expect(words[1]?.startSec).toBeCloseTo(19.225, 12);
    expect(words[1]?.durSec).toBeCloseTo(19.786 - 19.225, 12);
    expect(words[9]?.startSec).toBeCloseTo(22.72, 12);
    expect(words.at(-1)?.durSec).toBeUndefined(); // last word has no next start
  });

  it('attaches the untimed lead word to the first timed word', () => {
    const words = parseVttWords(
      'WEBVTT\n\n00:00:19.000 --> 00:00:23.000\nС<00:00:19.225><c>самого</c><00:00:19.786><c>начала</c>\n',
      VTT_HOST,
    );
    expect(words[0]).toEqual({ text: 'С', startSec: 19.225, durSec: 0 });
  });

  it('yields fewer than two words on tag-free text (asr-word gate falls through)', () => {
    const words = parseVttWords(fixture('sample.vtt'), VTT_HOST);
    expect(words.length).toBeLessThan(2);
  });
});

describe('normalizeSrt / parseSrt', () => {
  it('normalizes a Rutube-shaped SRT: comma timestamps, dropped sequence numbers, WEBVTT header', () => {
    const normalized = normalizeSrt(fixture('rutube.srt'));
    expect(normalized).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:04.500\nЭто первая реплика\n\n' +
        '00:00:04.500 --> 00:00:08.000\nА это вторая реплика\n\n' +
        '00:00:08.000 --> 00:00:12.000\nИ третья реплика финальная',
    );
  });

  it('parses all three cues and keeps the first one', () => {
    const segments = parseSrt(fixture('rutube.srt'), VTT_HOST);
    expect(segments).toEqual([
      { text: 'Это первая реплика', startSec: 1, durSec: 3.5 },
      { text: 'А это вторая реплика', startSec: 4.5, durSec: 3.5 },
      { text: 'И третья реплика финальная', startSec: 8, durSec: 4 },
    ]);
  });

  it('returns no cues for empty text', () => {
    expect(parseSrt('', VTT_HOST)).toEqual([]);
  });
});

describe('probe #5 — track srcs', () => {
  it('harvests words and cues from a Dzen-shaped track VTT', async () => {
    const url = 'https://vd1.okcdn.ru/?type=2&subId=abc';
    const fetchImpl = stubFetch(new Map([[url, { body: fixture('dzen-word.vtt') }]]));
    const result = await harvestCaptions(
      options({
        hostname: 'dzen.ru',
        trackSrcs: [url],
        fetchImpl,
      }),
    );
    expect(result?.words.length).toBe(16);
    expect(result?.words[0]?.text).toBe('С');
    expect(result?.cues.length).toBe(2);
    // Dzen cue text is tag-joined (no spaces), so tag-stripping word-joins it;
    // the word-level parse is the primary path, cues the fallback.
    expect(result?.cues[0]?.text).toBe('Ссамогоначалавыужезнаетечтотакоескорость');
    expect(result?.cues[0]?.startSec).toBe(19);
  });

  it('harvests cue-level segments from a Rutube-shaped SRT track', async () => {
    const url = 'https://pic.rtbcdn.ru/subtitle/2026/08/hash.srt';
    const fetchImpl = stubFetch(new Map([[url, { body: fixture('rutube.srt') }]]));
    const result = await harvestCaptions(
      options({
        hostname: 'rutube.ru',
        trackSrcs: [url],
        fetchImpl,
      }),
    );
    expect(result?.words).toEqual([]);
    expect(result?.cues.length).toBe(3);
    expect(result?.cues[0]?.text).toBe('Это первая реплика');
  });

  it('falls through to the next track src when the first yields nothing', async () => {
    const fetchImpl = stubFetch(
      new Map([
        ['https://cdn.example.com/empty.vtt', { body: 'WEBVTT\n\n' }],
        ['https://cdn.example.com/real.vtt', { body: fixture('sample.vtt') }],
      ]),
    );
    const result = await harvestCaptions(
      options({
        trackSrcs: ['https://cdn.example.com/empty.vtt', 'https://cdn.example.com/real.vtt'],
        fetchImpl,
      }),
    );
    expect(result?.cues.length).toBe(4);
  });

  it('returns null when a track src fetch fails', async () => {
    const fetchImpl = stubFetch(new Map([['https://vd1.okcdn.ru/?type=2', { ok: false, body: '' }]]));
    const result = await harvestCaptions(
      options({
        trackSrcs: ['https://vd1.okcdn.ru/?type=2'],
        fetchImpl,
      }),
    );
    expect(result).toBeNull();
  });

  it('returns null when the page exposes no track srcs (author-gated videos)', async () => {
    const result = await harvestCaptions(options({}));
    expect(result).toBeNull();
  });
});
