// Node environment (default): proves the core lib surface imports and runs
// without chrome.* or DOM globals — lib/{wpm,tokenizer,captions,languages,
// recommend} must not reference browser/document/window at import time
// (docs/core-library.md). One pure path per module; the measured-rate
// provider and the bridge are extension-side and live outside this surface.
import { describe, expect, it } from 'vitest';
import { parseYouTubeJson3, type Segment } from '../lib/captions';
import { LANGUAGES, resolveLanguage, UNIT_LABELS } from '../lib/languages';
import { recommend } from '../lib/recommend';
import { countWordTokens } from '../lib/tokenizer';
import { wordLevelWpm } from '../lib/wpm';

describe('core library surface (no chrome/DOM)', () => {
  it('wpm: computes a word-level rate from segments', () => {
    const words: Segment[] = [
      { text: 'one two three', startSec: 0 },
      { text: 'four', startSec: 2 },
    ];
    expect(wordLevelWpm(words)).toBeCloseTo(120, 5);
  });

  it('tokenizer: counts word tokens without a DOM', () => {
    expect(countWordTokens('hello world')).toBe(2);
    expect(countWordTokens('')).toBe(0);
  });

  it('captions: parses JSON3 caption events into cues', () => {
    const { cues } = parseYouTubeJson3({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world' }] }],
    });
    expect(cues).toEqual([{ text: 'hello world', startSec: 0, durSec: 1 }]);
  });

  it('languages: resolves codes and exposes the table as data', () => {
    expect(resolveLanguage('en-US')?.code).toBe('en');
    expect(resolveLanguage('zh-Hans')?.unit).toBe('cpm');
    expect(LANGUAGES.ja?.unit).toBe('mora');
    expect(UNIT_LABELS.wpm).toBe('wpm');
  });

  it('recommend: derives a multiplier from a measured rate', () => {
    const rec = recommend({ naturalRate: 150, tier: 'asr-word', contentType: 'lecture', platformMax: 2 });
    expect(rec.mode).toBe('recommend');
    expect(rec.multiplier).toBeGreaterThan(1);
    expect(rec.multiplier).toBeLessThanOrEqual(2);
  });
});
