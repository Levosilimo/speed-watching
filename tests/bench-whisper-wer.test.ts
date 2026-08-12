import { describe, expect, it } from 'vitest';
import {
  levenshtein,
  normalizeForWer,
  timestampSanity,
  wer,
} from '../scripts/bench-whisper-lib';

describe('normalizeForWer', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeForWer('THE FIREBALL, HALF OF IT!')).toEqual(['the', 'fireball', 'half', 'of', 'it']);
  });
});

describe('levenshtein', () => {
  it('counts substitutions', () => {
    expect(levenshtein(['a', 'b'], ['a', 'c'])).toBe(1);
  });
  it('counts insertions and deletions', () => {
    expect(levenshtein(['a', 'b'], ['a'])).toBe(1);
    expect(levenshtein([], ['a', 'b'])).toBe(2);
  });
});

describe('wer', () => {
  it('is 0 for identical transcripts', () => {
    expect(wer('THE FIREBALL HALF OF IT', 'the fireball half of it')).toBe(0);
  });
  it('is 1 for completely different text of equal length', () => {
    expect(wer('A B C', 'X Y Z')).toBe(1);
  });
});

describe('timestampSanity', () => {
  const chunks = [
    { text: 'a', start: 0.1, end: 0.5 },
    { text: 'b', start: 0.6, end: 1.1 },
    { text: 'c', start: 1.2, end: 1.8 },
  ];
  it('accepts monotonic in-bounds timestamps', () => {
    expect(timestampSanity(chunks, 2.0)).toEqual({
      monotonic: true,
      lastEndSec: 1.8,
      withinDuration: true,
    });
  });
  it('flags out-of-order timestamps', () => {
    const bad = [chunks[0]!, chunks[2]!, chunks[1]!];
    expect(timestampSanity(bad, 2.0).monotonic).toBe(false);
  });
  it('flags timestamps past the clip end', () => {
    expect(timestampSanity(chunks, 1.0).withinDuration).toBe(false);
  });
  it('handles empty output', () => {
    expect(timestampSanity([], 2.0)).toEqual({
      monotonic: true,
      lastEndSec: null,
      withinDuration: true,
    });
  });
});
