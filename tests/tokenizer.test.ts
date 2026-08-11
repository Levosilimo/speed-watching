import { describe, expect, it } from 'vitest';
import { countWordTokens, hasNoteSymbol, isBracketMarker } from '../lib/tokenizer';

describe('countWordTokens', () => {
  it('counts letter/digit runs, ignoring every other character', () => {
    expect(countWordTokens('')).toBe(0);
    expect(countWordTokens('   ')).toBe(0);
    expect(countWordTokens('hello world')).toBe(2);
    expect(countWordTokens('in 2026')).toBe(2);
    expect(countWordTokens('a—b')).toBe(2);
    expect(countWordTokens("don't")).toBe(2);
  });

  it('never counts note symbols, and bracket letters only when present', () => {
    expect(countWordTokens('♪♪♪')).toBe(0);
    expect(countWordTokens('♪ La la ♪')).toBe(2);
    expect(countWordTokens('[Music]')).toBe(1);
  });

  it('treats non-Latin scripts as letter runs', () => {
    expect(countWordTokens('Привет мир')).toBe(2);
    expect(countWordTokens('olá café')).toBe(2);
    expect(countWordTokens('你好世界')).toBe(1);
  });
});

describe('isBracketMarker', () => {
  it('matches pure marker cues', () => {
    expect(isBracketMarker('[Music]')).toBe(true);
    expect(isBracketMarker('[Applause]')).toBe(true);
    expect(isBracketMarker('[♪]')).toBe(true);
    expect(isBracketMarker('[Music]\n[Applause]')).toBe(true);
  });

  it('rejects speech, notes beside brackets, and empty text', () => {
    expect(isBracketMarker('')).toBe(false);
    expect(isBracketMarker('plain text')).toBe(false);
    expect(isBracketMarker('♪ [Music]')).toBe(false);
    expect(isBracketMarker('intro [Music]')).toBe(false);
  });
});

describe('hasNoteSymbol', () => {
  it('detects music notes in either glyph', () => {
    expect(hasNoteSymbol('♪')).toBe(true);
    expect(hasNoteSymbol('la la ♫')).toBe(true);
    expect(hasNoteSymbol('no notes here')).toBe(false);
  });
});
