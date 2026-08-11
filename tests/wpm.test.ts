import { describe, expect, it } from 'vitest';
import {
  correctedCueLevelWpm,
  countWords,
  cueLevelWpm,
  cueSpanSec,
  estimateSpeechDurationSec,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  totalWords,
  wordLevelWpm,
} from '../lib/wpm';
import { parseYouTubeJson3 } from '../lib/captions';
import { readFixture } from './fixtures/helpers';

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('hello')).toBe(1);
    expect(countWords('hello world')).toBe(2);
    expect(countWords('a  b\nc\td')).toBe(4);
  });
});

describe('wordLevelWpm', () => {
  it('computes words per minute over the first-to-last word span', () => {
    const words = [
      { text: 'a', startSec: 0 },
      { text: 'b c', startSec: 1 },
      { text: 'd', startSec: 2 },
      { text: 'e', startSec: 3 },
    ];
    // 5 tokens over a 3 s span
    expect(wordLevelWpm(words)).toBeCloseTo(100, 6);
  });

  it('returns null for fewer than two words', () => {
    expect(wordLevelWpm([])).toBeNull();
    expect(wordLevelWpm([{ text: 'a', startSec: 0 }])).toBeNull();
  });

  it('returns null when all words share a start', () => {
    const words = [
      { text: 'a', startSec: 1 },
      { text: 'b', startSec: 1 },
    ];
    expect(wordLevelWpm(words)).toBeNull();
  });
});

describe('cue-level wpm and silence correction', () => {
  const cues = [
    { text: 'one two', startSec: 0, durSec: 3 },
    { text: 'three four five', startSec: 5, durSec: 2 },
  ];

  it('computes cueSpanSec from first cue start to last cue end', () => {
    expect(cueSpanSec(cues)).toBe(7);
    expect(cueSpanSec([])).toBeNull();
  });

  it('naive cue wpm includes inter-cue gaps', () => {
    // 5 words over a 7 s span
    expect(cueLevelWpm(cues)).toBeCloseTo((5 / 7) * 60, 6);
  });

  it('corrected wpm divides by the summed cue durations', () => {
    expect(estimateSpeechDurationSec(cues)).toBe(5);
    expect(correctedCueLevelWpm(cues)).toBeCloseTo((5 / 5) * 60, 6);
  });

  it('caps the speech estimate at the cue span for overlapping cues', () => {
    const overlapping = [
      { text: 'a', startSec: 0, durSec: 10 },
      { text: 'b', startSec: 2, durSec: 10 },
    ];
    expect(estimateSpeechDurationSec(overlapping)).toBe(12);
  });

  it('returns null for empty or zero-duration input', () => {
    expect(cueLevelWpm([])).toBeNull();
    expect(correctedCueLevelWpm([])).toBeNull();
    expect(correctedCueLevelWpm([{ text: 'a', startSec: 0, durSec: 0 }])).toBeNull();
  });
});

describe('wpm across the synthetic fixture pipeline', () => {
  it('word-level beats cue-level on the same payload when gaps exist', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('synthetic/word-level.json'));
    const wpm = wordLevelWpm(words);
    const naive = cueLevelWpm(cues);
    const corrected = correctedCueLevelWpm(cues);
    if (wpm === null || naive === null || corrected === null) {
      throw new Error('wpm must be computable on the fixture');
    }
    expect(wpm - naive).toBeGreaterThan(0);
    expect(corrected - naive).toBeGreaterThan(0);
  });

  it('reports the silence bias on the cue-level-only fixture', () => {
    const { cues } = parseYouTubeJson3(readFixture('synthetic/cue-level-only.json'));
    const naive = cueLevelWpm(cues);
    const corrected = correctedCueLevelWpm(cues);
    expect(naive).toBeCloseTo((5 / 7) * 60, 6);
    expect(corrected).toBeCloseTo(60, 6);
  });
});

describe('filteredTokensOverTrimmedSpan (unified ASR rule)', () => {
  it('counts letter/digit tokens over the first-to-last non-bracket span', () => {
    const cues = [
      { text: '[Music]', startSec: 0, durSec: 5 },
      { text: 'hello world', startSec: 10, durSec: 2 },
      { text: '[Applause]', startSec: 15, durSec: 5 },
      { text: 'goodbye now', startSec: 20, durSec: 3 },
    ];
    // 4 tokens over the 10 s span from 10 to 20; the markers add nothing.
    expect(filteredTokensOverTrimmedSpan(cues)).toBeCloseTo(24, 6);
  });

  it('returns null without two spaced non-bracket cues', () => {
    expect(filteredTokensOverTrimmedSpan([])).toBeNull();
    expect(
      filteredTokensOverTrimmedSpan([{ text: '[Music]', startSec: 0, durSec: 5 }]),
    ).toBeNull();
    expect(
      filteredTokensOverTrimmedSpan([
        { text: 'hello', startSec: 10, durSec: 2 },
        { text: 'world', startSec: 10, durSec: 2 },
      ]),
    ).toBeNull();
  });
});

describe('unified rule on real fixtures', () => {
  it('runs above word-level on the ASR fixture — the naive path undercounts', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/asr-word.json'));
    const unified = filteredTokensOverTrimmedSpan(cues);
    const word = wordLevelWpm(words);
    if (unified === null || word === null) {
      throw new Error('wpm must be computable on the fixture');
    }
    expect(unified).toBeGreaterThan(word);
    expect(unified).toBeCloseTo(160.25, 2);
  });

  it('beats the raw cue rate by excluding the leading marker from the span', () => {
    const { cues } = parseYouTubeJson3(readFixture('real/asr-word.json'));
    const unified = filteredTokensOverTrimmedSpan(cues);
    const raw = cueLevelWpm(cues);
    if (unified === null || raw === null) {
      throw new Error('wpm must be computable on the fixture');
    }
    expect(unified).toBeGreaterThan(raw);
  });
});

describe('manualCueRate (silence-corrected manual tier)', () => {
  it('applies the silence correction on the manual fixture', () => {
    const { cues } = parseYouTubeJson3(readFixture('real/manual-cue.json'));
    const rate = manualCueRate(cues);
    const naive = cueLevelWpm(cues);
    if (rate === null || naive === null) {
      throw new Error('wpm must be computable on the fixture');
    }
    expect(rate).toBeGreaterThan(naive);
    expect(rate).toBeCloseTo(181.76, 2);
  });

  it('ignores bracket-marker cues in tokens and speech estimate', () => {
    const cues = [
      { text: '[Music]', startSec: 0, durSec: 10 },
      { text: 'hello world', startSec: 10, durSec: 2 },
      { text: 'goodbye now', startSec: 20, durSec: 3 },
    ];
    // 4 tokens over 5 s of speech; the marker's 10 s adds nothing.
    expect(manualCueRate(cues)).toBeCloseTo(48, 6);
  });

  it('returns null when no speech duration is measurable', () => {
    expect(manualCueRate([])).toBeNull();
    expect(manualCueRate([{ text: 'a', startSec: 0, durSec: 0 }])).toBeNull();
  });
});

describe('duration-less cues (windows without durMs)', () => {
  it('treats missing durations as zero in span and speech estimates', () => {
    const cues = [
      { text: 'a', startSec: 0, durSec: 2 },
      { text: 'b', startSec: 5 },
    ];
    expect(cueSpanSec(cues)).toBe(5);
    expect(estimateSpeechDurationSec(cues)).toBe(2);
    expect(correctedCueLevelWpm(cues)).toBeCloseTo(60, 6);
  });
});

describe('totalWords', () => {
  it('counts tokens across mixed word and cue items', () => {
    expect(
      totalWords([
        { text: 'a b', startSec: 0 },
        { text: 'c', startSec: 0, durSec: 1 },
      ]),
    ).toBe(3);
  });
});
