import { describe, expect, it } from 'vitest';
import { countDevanagariSyllables, countHangulSyllables, countMorae, countTurkishVowels, countVowelNuclei, countWordTokens, hasNoteSymbol, isBracketMarker } from '../lib/tokenizer';

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

describe('countMorae', () => {
  it('counts each kana code point as one mora, incl. ー and っ', () => {
    expect(countMorae('こんにちは')).toBe(5);
    expect(countMorae('スーパー')).toBe(4); // ス ー パ ー
    expect(countMorae('がっこう')).toBe(4); // が っ こ う
  });

  it('counts kanji at 1.85 morae each', () => {
    expect(countMorae('漢字')).toBeCloseTo(3.7, 6);
    expect(countMorae('日本')).toBeCloseTo(3.7, 6);
  });

  it('hand-computed mixed kanji+kana string', () => {
    // 日本語の字幕です: 5 kanji × 1.85 + 3 kana = 12.25 morae (8 graphemes
    // understate this ~53% — the chars-mode error the estimator fixes).
    expect(countMorae('日本語の字幕です')).toBeCloseTo(12.25, 6);
  });

  it('skips punctuation, whitespace, symbols, Latin, digits', () => {
    expect(countMorae('こんにちは、世界！')).toBeCloseTo(8.7, 6); // 5 kana + 2 kanji
    expect(countMorae('♪ 123 ABC')).toBe(0);
    expect(countMorae('')).toBe(0);
  });
});

describe('countTurkishVowels', () => {
  it('counts vowel letters, both cases', () => {
    expect(countTurkishVowels('merhaba dünya')).toBe(5); // e a a ü a
    expect(countTurkishVowels('Türkçe')).toBe(2); // ü e
    expect(countTurkishVowels('İstanbul')).toBe(3); // İ a u
  });

  it('returns zero without vowels', () => {
    expect(countTurkishVowels('krk 123!')).toBe(0);
    expect(countTurkishVowels('')).toBe(0);
  });
});

describe('countDevanagariSyllables', () => {
  it('counts consonants-with-vowel and standalone vowel letters', () => {
    expect(countDevanagariSyllables('मैं जा रहा हूँ')).toBe(5); // 1 1 2 1
    expect(countDevanagariSyllables('वह ठीक है')).toBe(3); // vah ṭhīk hai — final schwas dropped
    expect(countDevanagariSyllables('अच्छा')).toBe(2); // अ + च्छा
    expect(countDevanagariSyllables('हिन्दी')).toBe(2); // हिन् + दी
  });

  it('halant removes the preceding consonant\'s vowel', () => {
    expect(countDevanagariSyllables('क्या')).toBe(1); // क् + या
    expect(countDevanagariSyllables('कर्म')).toBe(1); // karm — क + र्म्
  });

  it('counts halant clusters by the orthographic rule', () => {
    // नमस्ते (न + म् + स् + ते, escapes pin the halants): 2 counted vs
    // 3 spoken (epenthetic schwa) — the documented deviation, inside ±10%.
    expect(countDevanagariSyllables('\u0928\u092E\u094D\u0938\u094D\u0924\u0947')).toBe(2);
  });

  it('skips matras, marks, punctuation, and non-Devanagari text', () => {
    expect(countDevanagariSyllables('')).toBe(0);
    expect(countDevanagariSyllables('123!')).toBe(0);
    expect(countDevanagariSyllables('hello world')).toBe(0);
  });
});

describe('countVowelNuclei', () => {
  it('dispatches on the language code', () => {
    expect(countVowelNuclei('merhaba', 'tr')).toBe(3);
    expect(countVowelNuclei('राम', 'hi')).toBe(1);
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
