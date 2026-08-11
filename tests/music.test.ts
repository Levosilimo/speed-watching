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

  it('fires on markers or notes when the rate is sub-90 wpm', () => {
    expect(detectMusic(lyricCues, 80)).toBe(true);
    // ♪ notes with zero bracket markers: measured lyric tracks (Happy,
    // Despacito, Blinding Lights) carry no markers at all.
    const notesOnly = lyricCues.filter((cue) => cue.text.includes('♪'));
    expect(markerRatio(notesOnly)).toBe(0);
    expect(detectMusic(notesOnly, 80)).toBe(true);
    // Bracket markers alone, no notes: Faded-style lyric track.
    const markersOnly = lyricCues.map((cue) => ({ ...cue, text: cue.text.replace(/♪/g, '') }));
    expect(detectMusic(markersOnly, 80)).toBe(true);
  });

  it('never fires at speech rate, even with notes and markers', () => {
    expect(detectMusic(lyricCues, MUSIC_RATE_CAP_WPM)).toBe(false);
    expect(detectMusic(lyricCues, 120)).toBe(false);
    const notesOnly = lyricCues.filter((cue) => cue.text.includes('♪'));
    expect(detectMusic(notesOnly, 120)).toBe(false);
  });

  it('requires the marker share to clear the ratio floor when there are no notes', () => {
    // A TED-style talk: one intro marker drowned in speech cues, no notes.
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

  it('reports the real Faded fixture as music: sparse rate plus markers', () => {
    const { cues } = parseYouTubeJson3(readFixture('real/music.json'));
    const rate = filteredTokensOverTrimmedSpan(cues);
    if (rate === null) throw new Error('rate must be computable on the fixture');
    expect(rate).toBeLessThan(MUSIC_RATE_CAP_WPM);
    expect(markerRatio(cues)).toBe(0.3);
    expect(containsNotes(cues)).toBe(false);
    expect(detectMusic(cues, rate)).toBe(true);
  });
});
