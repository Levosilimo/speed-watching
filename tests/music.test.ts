import { describe, expect, it } from 'vitest';
import type { Segment } from '../lib/captions';
import { parseYouTubeJson3 } from '../lib/captions';
import {
  MUSIC_MARKER_RATIO_MIN,
  MUSIC_RATE_CAP_WPM,
  containsNotes,
  detectMusic,
  markerRatio,
} from '../lib/music';
import { filteredTokensOverTrimmedSpan } from '../lib/wpm';
import { readFixture } from './fixtures/helpers';

describe('markerRatio', () => {
  it('is the fraction of bracket-marker cues', () => {
    const cues: Segment[] = [
      { text: '[Music]', startSec: 0, durSec: 2 },
      { text: 'hello', startSec: 2, durSec: 2 },
      { text: '[Applause]', startSec: 4, durSec: 2 },
      { text: 'world', startSec: 6, durSec: 2 },
    ];
    expect(markerRatio(cues)).toBe(0.5);
    expect(markerRatio([])).toBe(0);
  });
});

describe('detectMusic', () => {
  const lyricCues: Segment[] = [
    { text: '[Music]', startSec: 0, durSec: 3 },
    { text: '♪ la la ♪', startSec: 3, durSec: 4 },
    { text: '♪ never gonna give ♪', startSec: 7, durSec: 4 },
    { text: '[Applause]', startSec: 11, durSec: 2 },
  ];

  it('requires markers, notes, and a sub-90 wpm rate together', () => {
    expect(detectMusic(lyricCues, 80)).toBe(true);
    expect(detectMusic(lyricCues, MUSIC_RATE_CAP_WPM)).toBe(false);
    expect(detectMusic(lyricCues, 120)).toBe(false);
  });

  it('never fires on markers alone, even with a high marker share', () => {
    const noNotes = lyricCues.map((cue) => ({ ...cue, text: cue.text.replace(/♪/g, '') }));
    expect(detectMusic(noNotes, 80)).toBe(false);
  });

  it('requires the marker share to clear the ratio floor', () => {
    const noMarkers = lyricCues.filter((cue) => cue.text.includes('♪'));
    expect(markerRatio(noMarkers)).toBe(0);
    expect(detectMusic(noMarkers, 80)).toBe(false);
    // A TED-style talk: one intro marker drowned in speech cues.
    const talkCues: Segment[] = [
      { text: '[Music]', startSec: 0, durSec: 5 },
      ...[...Array(50)].map((_, i) => ({
        text: 'welcome back to the show',
        startSec: 5 + i * 2,
        durSec: 2,
      })),
      { text: '[Music]', startSec: 200, durSec: 5 },
    ];
    expect(markerRatio(talkCues)).toBeLessThan(MUSIC_MARKER_RATIO_MIN);
    expect(detectMusic(talkCues, 70)).toBe(false);
  });

  it('reports the real Faded fixture honestly: sparse rate, but no notes', () => {
    const { cues } = parseYouTubeJson3(readFixture('real/music.json'));
    const rate = filteredTokensOverTrimmedSpan(cues);
    if (rate === null) throw new Error('rate must be computable on the fixture');
    expect(rate).toBeLessThan(MUSIC_RATE_CAP_WPM);
    expect(markerRatio(cues)).toBe(0.3);
    expect(containsNotes(cues)).toBe(false);
    expect(detectMusic(cues, rate)).toBe(false);
  });
});
