import { describe, expect, it } from 'vitest';
import { parseYouTubeJson3 } from '../lib/captions';
import { readFixture } from './fixtures/helpers';

describe('parseYouTubeJson3 — synthetic word-level payload', () => {
  const { words, cues } = parseYouTubeJson3(readFixture('synthetic/word-level.json'));

  it('extracts word timings from events segs, skipping untimed segs', () => {
    expect(words.map((w) => [w.text, w.startSec])).toEqual([
      ['world', 0.5],
      ['this ', 2.5],
      ['is', 2.9],
      ['a test', 4.1],
    ]);
  });

  it('chains durSec to the next word start, last word excluded', () => {
    const durSecs = words.map((w) => w.durSec);
    [2, 0.4, 1.2].forEach((expected, i) => {
      expect(durSecs[i]).toBeCloseTo(expected, 6);
    });
    expect(durSecs[3]).toBeUndefined();
  });

  it('derives cues from events', () => {
    expect(cues).toEqual([
      { text: 'Hello world', startSec: 0, durSec: 2 },
      { text: 'this is', startSec: 2.5, durSec: 1.2 },
      { text: 'a test', startSec: 4, durSec: 2 },
    ]);
  });
});

describe('parseYouTubeJson3 — synthetic cue-level-only payload', () => {
  const parsed = parseYouTubeJson3(readFixture('synthetic/cue-level-only.json'));

  it('yields no words without per-seg timing', () => {
    expect(parsed.words).toEqual([]);
  });

  it('parses cues', () => {
    expect(parsed.cues).toEqual([
      { text: 'Welcome back', startSec: 0, durSec: 3 },
      { text: 'to the show', startSec: 5, durSec: 2 },
    ]);
  });
});

describe('parseYouTubeJson3 — edge cases', () => {
  it('returns empty structures for a payload without timing info', () => {
    expect(parseYouTubeJson3(readFixture('synthetic/empty.json'))).toEqual({
      words: [],
      cues: [],
    });
  });

  it('returns empty structures for non-object input', () => {
    expect(parseYouTubeJson3(null)).toEqual({ words: [], cues: [] });
    expect(parseYouTubeJson3('nonsense')).toEqual({ words: [], cues: [] });
  });

  it('skips non-record entries in the events and windows arrays', () => {
    const parsed = parseYouTubeJson3({
      events: ['bogus', { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: 'ok' }] }],
      windows: ['bogus'],
    });
    expect(parsed.cues).toEqual([{ text: 'ok', startSec: 0, durSec: 0.5 }]);
  });

  it('skips segs and windows missing their timing fields', () => {
    const parsed = parseYouTubeJson3({
      windows: [
        { wpWinStartMs: 1000, segs: [{ utf8: 'untimed seg' }] },
        { wpWinStartMs: 2000, segs: [{ utf8: 'timed', tOffsetMs: 100 }] },
      ],
      events: [
        { segs: [{ utf8: 'no start', tOffsetMs: 5 }] },
        { tStartMs: 0, segs: [{ utf8: 'no dur' }] },
        { windows: [{ text: 'no start', durMs: 500 }] },
      ],
    });
    expect(parsed.words).toEqual([{ text: 'timed', startSec: 2.1, durSec: undefined }]);
    expect(parsed.cues).toEqual([]);
  });

  it('filters non-record segs out of the cue text', () => {
    const parsed = parseYouTubeJson3({
      events: [{ tStartMs: 0, dDurationMs: 500, segs: ['bogus', { utf8: 'ok' }] }],
    });
    expect(parsed.cues).toEqual([{ text: 'ok', startSec: 0, durSec: 0.5 }]);
  });

  it('sorts out-of-order word timings ascending', () => {
    const { words } = parseYouTubeJson3(readFixture('synthetic/out-of-order.json'));
    expect(words.map((w) => w.startSec)).toEqual([0, 1.5, 3]);
  });

  it('keeps a single word without durSec', () => {
    const { words } = parseYouTubeJson3(readFixture('synthetic/single-word.json'));
    expect(words).toEqual([{ text: 'solo', startSec: 1, durSec: undefined }]);
  });

  it('parses music-like sparse cues', () => {
    const { words, cues } = parseYouTubeJson3(
      readFixture('synthetic/music-segments.json'),
    );
    expect(words).toHaveLength(3);
    expect(cues.map((c) => [c.text, c.durSec])).toEqual([
      ['la', 4],
      ['do do do do', 9],
      ['mi mi', 6],
    ]);
  });
});

describe('parseYouTubeJson3 — WEB windows format', () => {
  it('parses event-level windows ({startMs, durMs?, text}) into the same cues as segs', () => {
    // Format-drift sentinel: converted from the real ASR payload's
    // texts/timings into the windows shape, which no real payload has
    // used since the residential re-run. If a future format change
    // breaks this, the sentinel fails instead of silently regressing.
    const real = parseYouTubeJson3(readFixture('real/asr-word.json'));
    const windows = parseYouTubeJson3(readFixture('synthetic/windows-format.json'));
    expect(windows.cues).toEqual(real.cues);
    expect(windows.words).toEqual([]);
  });

  it('falls back to top-level windows when events carry no text', () => {
    const parsed = parseYouTubeJson3({
      events: [{ tStartMs: 0, dDurationMs: 500 }],
      windows: [{ startMs: 1000, durMs: 2000, text: 'first  cue' }],
    });
    expect(parsed.cues).toEqual([{ text: 'first cue', startSec: 1, durSec: 2 }]);
  });

  it('leaves durSec absent when a window has no durMs', () => {
    const parsed = parseYouTubeJson3({
      windows: [{ startMs: 4000, text: 'second cue' }],
    });
    expect(parsed.cues).toEqual([{ text: 'second cue', startSec: 4, durSec: undefined }]);
  });

  it('prefers event segs over event windows when both carry text', () => {
    const parsed = parseYouTubeJson3({
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1000,
          segs: [{ utf8: 'from segs' }],
          windows: [{ startMs: 0, durMs: 1000, text: 'from windows' }],
        },
      ],
    });
    expect(parsed.cues).toEqual([{ text: 'from segs', startSec: 0, durSec: 1 }]);
  });
});

describe('parseYouTubeJson3 — real captured payloads', () => {
  it('parses a real ASR payload (TED talk) into sorted timed words and cues', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/asr-word.json'));
    expect(words.length).toBeGreaterThanOrEqual(20);
    expect(cues.length).toBeGreaterThan(0);
    const starts = words.map((w) => w.startSec);
    const sorted = [...starts].sort((a, b) => a - b);
    expect(starts).toEqual(sorted);
    expect(words.some((w) => w.durSec !== undefined)).toBe(true);
  });

  it('parses a real manual payload with no word timing', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/manual-cue.json'));
    expect(words).toEqual([]);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every((c) => c.text.length > 0 && c.durSec !== undefined && c.durSec > 0)).toBe(true);
  });

  it('parses a real music-video payload with sparse word timing', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/music.json'));
    expect(words.length).toBeGreaterThan(0);
    expect(cues.length).toBeGreaterThan(0);
  });
});
