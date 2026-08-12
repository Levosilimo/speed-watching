import { describe, expect, it } from 'vitest';
import {
  articulatoryWpm,
  correctedCueLevelWpm,
  countWords,
  cueLevelWpm,
  cueSpanSec,
  estimateSpeechDurationSec,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  speechDurationSec,
  totalWords,
  wordLevelWpm,
} from '../lib/wpm';
import { parseYouTubeJson3 } from '../lib/captions';
import { LANGUAGES } from '../lib/languages';
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

describe('speechDurationSec (per-word inter-start spans)', () => {
  it('sums inter-start spans, excluding gaps ≥ 1 s', () => {
    const words = [
      { text: 'a', startSec: 0 },
      { text: 'b', startSec: 0.4 },
      { text: 'c', startSec: 0.7 },
      { text: 'd', startSec: 1.7 }, // gap 1.0 → cue-boundary pause, excluded
      { text: 'e', startSec: 2.4 },
    ];
    expect(speechDurationSec(words)).toBeCloseTo(0.4 + 0.3 + 0.7, 6);
  });

  it('skips non-positive deltas (out-of-order timings)', () => {
    const words = [
      { text: 'a', startSec: 1.0 },
      { text: 'b', startSec: 1.5 },
      { text: 'c', startSec: 1.2 }, // rewind → skipped
      { text: 'd', startSec: 2.0 },
    ];
    expect(speechDurationSec(words)).toBeCloseTo(0.5 + 0.8, 6);
  });

  it('returns null for empty, single-word, and all-gap input', () => {
    expect(speechDurationSec([])).toBeNull();
    expect(speechDurationSec([{ text: 'a', startSec: 0 }])).toBeNull();
    // every gap ≥ 1 s: nothing left to measure
    expect(
      speechDurationSec([
        { text: 'a', startSec: 0 },
        { text: 'b', startSec: 2 },
      ]),
    ).toBeNull();
  });
});

describe('articulatoryWpm', () => {
  it('divides the token count by the pause-excluded speech duration', () => {
    expect(articulatoryWpm(60, 10)).toBeCloseTo(360, 6);
    expect(articulatoryWpm(0, 10)).toBe(0);
  });
});

describe('speech duration on real fixtures', () => {
  it('measures pause-excluded speech duration on the iG9CE55wbtY opening', () => {
    // Same video opening in both layouts; the WEB fixture and the ANDROID
    // asr-word fixture must yield the same word timing.
    const web = parseYouTubeJson3(readFixture('real/windows-asr-iG9CE55wbtY-trunc.json'));
    const android = parseYouTubeJson3(readFixture('real/asr-word.json'));
    const webDur = speechDurationSec(web.words);
    const androidDur = speechDurationSec(android.words);
    if (webDur === null || androidDur === null) {
      throw new Error('speech duration must be measurable on the fixture');
    }
    expect(androidDur).toBeCloseTo(webDur, 6);
    expect(webDur).toBeGreaterThan(0);
  });

  it('excludes the ≥1 s gap on the Ks-_Mh1QhMc opening', () => {
    const { words } = parseYouTubeJson3(readFixture('real/windows-asr-Ks-_Mh1QhMc-trunc.json'));
    const dur = speechDurationSec(words);
    const raw = words.at(-1)!.startSec - words[0]!.startSec;
    if (dur === null) throw new Error('speech duration must be measurable on the fixture');
    expect(dur).toBeLessThan(raw);
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

describe('language-aware token units', () => {
  it('ja: counts graphemes per minute over the trimmed span (cpm)', () => {
    const cues = [
      { text: 'こんにちは世界', startSec: 0, durSec: 3 }, // 7 graphemes
      { text: '元気ですか', startSec: 2, durSec: 2 }, // 5 graphemes
    ];
    // 12 chars over a 2 s span → 360 cpm; word runs would say 2.
    expect(filteredTokensOverTrimmedSpan(cues, LANGUAGES['ja'])).toBeCloseTo(360, 6);
    expect(filteredTokensOverTrimmedSpan(cues)).toBeCloseTo(60, 6);
  });

  it('hi: converts words-marks tokens to syllables', () => {
    const cues = [
      { text: 'मैं जा रहा हूँ', startSec: 0, durSec: 2 }, // 4 words × 1.5 = 6 syl
      { text: 'मैं ठीक हूँ', startSec: 1, durSec: 1 }, // 3 words × 1.5 = 4.5 syl
    ];
    // 10.5 syl over a 1 s span → 630 syl/min.
    expect(filteredTokensOverTrimmedSpan(cues, LANGUAGES['hi'])).toBeCloseTo(630, 6);
  });

  it('ko: counts Hangul syllable blocks instead of the factor', () => {
    const cues = [
      { text: '안녕하세요', startSec: 0, durSec: 3 }, // 5 blocks
      { text: '세상', startSec: 1, durSec: 2 }, // 2 blocks
    ];
    // 7 blocks over a 1 s span → 420 syl/min.
    expect(filteredTokensOverTrimmedSpan(cues, LANGUAGES['ko'])).toBeCloseTo(420, 6);
  });

  it('es: word runs stay words per minute', () => {
    const cues = [
      { text: 'hola mundo', startSec: 0, durSec: 3 },
      { text: 'buenos días', startSec: 1, durSec: 2 },
    ];
    // 4 words over a 1 s span → 240 wpm; accents stay inside the run.
    expect(filteredTokensOverTrimmedSpan(cues, LANGUAGES['es'])).toBeCloseTo(240, 6);
  });
});
