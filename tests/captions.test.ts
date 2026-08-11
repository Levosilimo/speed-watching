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
    expect(cues.every((c) => c.text.length > 0 && c.durSec > 0)).toBe(true);
  });

  it('parses a real music-video payload with sparse word timing', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/music.json'));
    expect(words.length).toBeGreaterThan(0);
    expect(cues.length).toBeGreaterThan(0);
  });
});
