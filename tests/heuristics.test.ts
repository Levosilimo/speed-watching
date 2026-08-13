import { describe, expect, it } from 'vitest';
import type { WpmRange } from '../lib/heuristics';
import { cueSignal, detectContentType, priorMidpoint, priorRange, type MeasuredSignal } from '../lib/heuristics';
import { LANGUAGES } from '../lib/languages';
import type { Segment } from '../lib/captions';

describe('priorRange', () => {
  it('returns the measured anchors for known content types', () => {
    const talk: WpmRange = priorRange('talk');
    expect(talk).toEqual({ min: 140, max: 206 });
    expect(priorRange('lecture')).toEqual({ min: 110, max: 188 });
    expect(priorRange('explainer')).toEqual({ min: 103, max: 191 });
    expect(priorRange('news')).toEqual({ min: 127, max: 150 });
  });

  it('falls back to defaults for unmeasured types', () => {
    expect(priorRange('podcast')).toEqual({ min: 140, max: 200 });
    expect(priorRange('generic')).toEqual({ min: 130, max: 190 });
    expect(priorRange('unknown')).toEqual({ min: 130, max: 190 });
    expect(priorRange('music')).toEqual({ min: 130, max: 190 });
  });
});

describe('priorMidpoint', () => {
  it('is the range midpoint, the estimated-tier natural rate', () => {
    expect(priorMidpoint('generic')).toBe(160);
    expect(priorMidpoint('talk')).toBe(173);
    expect(priorMidpoint('podcast')).toBe(170);
    expect(priorMidpoint('unknown')).toBe(160);
  });
});

describe('priorRange — language-aware', () => {
  it('uses the language priors for known non-English tracks', () => {
    expect(priorRange('lecture', LANGUAGES['ja'])).toEqual(LANGUAGES['ja']?.priors);
    expect(priorRange('generic', LANGUAGES['de'])).toEqual(LANGUAGES['de']?.priors);
  });

  it('resolves the ru register bands per content type', () => {
    expect(priorRange('news', LANGUAGES['ru'])).toEqual({ min: 120, max: 150 });
    expect(priorRange('lecture', LANGUAGES['ru'])).toEqual({ min: 95, max: 135 });
    expect(priorRange('podcast', LANGUAGES['ru'])).toEqual({ min: 100, max: 140 });
    expect(priorRange('generic', LANGUAGES['ru'])).toEqual({ min: 105, max: 145 });
    expect(priorRange('talk', LANGUAGES['uk'])).toEqual({ min: 100, max: 140 });
  });

  it('falls back to the language generic band for registers without a band', () => {
    expect(priorRange('music', LANGUAGES['ru'])).toEqual({ min: 105, max: 145 });
    expect(priorRange('unknown', LANGUAGES['ru'])).toEqual(LANGUAGES['ru']?.priors);
  });

  it('keeps the measured content-type anchors for English and unmapped tracks', () => {
    expect(priorRange('lecture', LANGUAGES['en'])).toEqual({ min: 110, max: 188 });
    expect(priorRange('lecture')).toEqual({ min: 110, max: 188 });
    expect(priorRange('news', LANGUAGES['en'])).toEqual({ min: 127, max: 150 });
  });
});

describe('priorMidpoint — language-aware', () => {
  it('is the language prior midpoint for non-English tracks', () => {
    const ja = LANGUAGES['ja']!;
    expect(priorMidpoint('generic', ja)).toBe((ja.priors.min + ja.priors.max) / 2);
  });

  it('is the register band midpoint when the type resolves to one', () => {
    expect(priorMidpoint('news', LANGUAGES['ru'])).toBe(135);
    expect(priorMidpoint('lecture', LANGUAGES['ru'])).toBe(115);
  });

  it('keeps the English midpoints without a language', () => {
    expect(priorMidpoint('generic')).toBe(160);
    expect(priorMidpoint('talk')).toBe(173);
  });
});

const ru = LANGUAGES['ru']!;

function signal(overrides: Partial<MeasuredSignal>): MeasuredSignal {
  return {
    naturalRate: 120,
    durationSec: 60,
    cueCount: 20,
    pauseShare: 0.25,
    language: ru,
    ...overrides,
  };
}

describe('detectContentType — ru register classification', () => {
  it('assigns lecture on the lecture band with long pauses', () => {
    expect(detectContentType(signal({ naturalRate: 115, pauseShare: 0.35 }))).toBe('lecture');
  });

  it('assigns news on the news band with short cues and tight timing', () => {
    expect(detectContentType(signal({ naturalRate: 135, pauseShare: 0.1, durationSec: 60, cueCount: 60 }))).toBe('news');
  });

  it('assigns the mid band (podcast first on a tie) with moderate pauses', () => {
    expect(detectContentType(signal({ naturalRate: 120, pauseShare: 0.3 }))).toBe('podcast');
    expect(detectContentType(signal({ naturalRate: 110, pauseShare: 0.2 }))).toBe('generic');
  });

  it('assigns the mid band just off its midpoint under the margin rule', () => {
    // 121: mid band (d 1) stays within half the generic band's distance (d 4).
    expect(detectContentType(signal({ naturalRate: 121, pauseShare: 0.3 }))).toBe('podcast');
  });
});

describe('detectContentType — confidence rejection and generic fallback', () => {
  it('rejects rates between register bands (margin rule)', () => {
    expect(detectContentType(signal({ naturalRate: 105 }))).toBe('generic');
    expect(detectContentType(signal({ naturalRate: 150 }))).toBe('generic');
    // 127.5 sits between the mid band and the generic band: not confident.
    expect(detectContentType(signal({ naturalRate: 127.5, pauseShare: 0.3 }))).toBe('generic');
  });

  it('falls back to generic when the generic band is nearest', () => {
    expect(detectContentType(signal({ naturalRate: 125 }))).toBe('generic');
  });

  it('rejects when the pause structure disagrees with the nearest band', () => {
    // Lecture rate without lecture pauses, news rate with long cues.
    expect(detectContentType(signal({ naturalRate: 115, pauseShare: 0.2 }))).toBe('generic');
    expect(
      detectContentType(signal({ naturalRate: 135, pauseShare: 0.1, durationSec: 120, cueCount: 20 })),
    ).toBe('generic');
  });

  it('rejects a duration-less signal (unknown pause structure)', () => {
    expect(detectContentType(signal({ naturalRate: 135, cueCount: 0 }))).toBe('generic');
  });

  it('never returns music — detectMusic has precedence', () => {
    const result = detectContentType(signal({ naturalRate: 120, pauseShare: 0.3 }));
    expect(result).not.toBe('music');
  });
});

describe('detectContentType — English measured bands', () => {
  it('classifies against the measured anchors without a language', () => {
    const en = signal({ language: undefined, naturalRate: 173, pauseShare: 0.2 });
    expect(detectContentType(en)).toBe('talk');
    const podcast = signal({ language: undefined, naturalRate: 170, pauseShare: 0.3 });
    expect(detectContentType(podcast)).toBe('podcast');
    const news = signal({ language: undefined, naturalRate: 138.5, pauseShare: 0.05, durationSec: 60, cueCount: 60 });
    expect(detectContentType(news)).toBe('news');
  });

  it('keeps mid-band English rates generic (overlapping anchors)', () => {
    expect(detectContentType(signal({ language: undefined, naturalRate: 160, pauseShare: 0.2 }))).toBe('generic');
  });
});

describe('cueSignal', () => {
  const cues: Segment[] = [
    { text: 'a b c', startSec: 0, durSec: 3 },
    { text: 'd e f', startSec: 10, durSec: 3 },
    { text: 'g h i', startSec: 20, durSec: 3 },
  ];

  it('derives span, pause share, and cue count from the cues', () => {
    const result = cueSignal(cues, 150, ru);
    expect(result).toEqual({
      naturalRate: 150,
      durationSec: 23,
      cueCount: 3,
      pauseShare: 1 - 9 / 23,
      language: ru,
    });
  });

  it('returns null for an empty track', () => {
    expect(cueSignal([], 150)).toBeNull();
  });
});
