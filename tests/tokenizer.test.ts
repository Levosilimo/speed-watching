import { describe, expect, it } from 'vitest';
import { countHangulSyllables, countWordTokens, hasNoteSymbol, isBracketMarker } from '../lib/tokenizer';

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

describe('countWordTokens — words-marks mode', () => {
  it('keeps Devanagari matras and viramas inside the run', () => {
    // 'मैं जा रहा हूँ' = 4 words.
    expect(countWordTokens('मैं जा रहा हूँ', 'words-marks')).toBe(4);
    // 'क्या नहीं': the plain run drops matras as separators (3 tokens),
    // the marks run keeps them (2 words).
    expect(countWordTokens('क्या नहीं')).toBe(3);
    expect(countWordTokens('क्या नहीं', 'words-marks')).toBe(2);
  });
});

describe('countWordTokens — chars mode', () => {
  it('counts graphemes instead of runs', () => {
    expect(countWordTokens('日本語の字幕です', 'chars')).toBe(8);
  });

  it('excludes whitespace and punctuation', () => {
    expect(countWordTokens('こんにちは、世界！', 'chars')).toBe(7);
    expect(countWordTokens('你好，世界。', 'chars')).toBe(4);
    expect(countWordTokens('a b c', 'chars')).toBe(3);
  });

  it('merges combining marks into their base grapheme', () => {
    // Thai tone mark (U+0E49) on ร: one grapheme, two code points.
    expect(countWordTokens('\u0E23\u0E49', 'chars')).toBe(1);
    // กำลัง: ก ำ ล ั ง — 3 graphemes; SARA AM (U+0E33) clusters with its
    // consonant and the tone mark merges into ล.
    expect(countWordTokens('กำลัง', 'chars')).toBe(3);
    expect(countWordTokens('สวัสดี', 'chars')).toBe(4);
  });
});

describe('countHangulSyllables', () => {
  it('counts Hangul syllable blocks, one syllable each', () => {
    expect(countHangulSyllables('')).toBe(0);
    expect(countHangulSyllables('안녕하세요 세상')).toBe(7);
    expect(countHangulSyllables('hello 123')).toBe(0);
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
