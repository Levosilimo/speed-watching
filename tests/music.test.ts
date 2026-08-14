import { describe, expect, it } from 'vitest';
import type { Segment } from '../lib/captions';
import { parseYouTubeJson3 } from '../lib/captions';
import {
  MUSIC_MARKER_RATIO_MIN,
  MUSIC_RATE_CAP_BY_UNIT,
  MUSIC_RATE_CAP_WPM,
  containsNotes,
  detectMusic,
  markerRatio,
} from '../lib/music';
import { LANGUAGES } from '../lib/languages';
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

  it('pins the per-unit caps', () => {
    expect(MUSIC_RATE_CAP_BY_UNIT).toEqual({ wpm: 90, mora: 150, syl: 90, cpm: 250 });
  });

  it('trips the cpm cap on the th lyric control band (158.0/219.1 cpm)', () => {
    // 20 cues × 4 Thai graphemes ('♪ สวัสดี ♪'; ♪ is a symbol, excluded)
    // over a 22.8 s span ≈ 210 cpm — inside the corpus's th lyric control
    // band. Under the old flat 90 wpm floor these never tripped; the
    // unit-aware cpm cap (250) catches them, the wpm default does not.
    const thCues: Segment[] = [...Array(20)].map((_, i) => ({
      text: '♪ สวัสดี ♪',
      startSec: i * 1.2,
      durSec: 1.2,
    }));
    const rate = filteredTokensOverTrimmedSpan(thCues, LANGUAGES['th']);
    if (rate === null) throw new Error('rate must be computable on the th cues');
    expect(rate).toBeGreaterThan(MUSIC_RATE_CAP_BY_UNIT.wpm);
    expect(rate).toBeLessThan(MUSIC_RATE_CAP_BY_UNIT.cpm);
    expect(detectMusic(thCues, rate, 'cpm')).toBe(true);
    expect(detectMusic(thCues, rate)).toBe(false); // the unit-blind bug
  });

  it('trips the mora cap on the ja lyric control band (89.3/115.3 morae/min)', () => {
    // 20 cues × 4 kana ('♪ ララララ ♪') over a 34.2 s span ≈ 140
    // morae/min — between the ja lyric controls and the 150 cap; ja
    // speech never measures below ~291 morae/min, so the cap is safe.
    const jaCues: Segment[] = [...Array(20)].map((_, i) => ({
      text: '♪ ララララ ♪',
      startSec: i * 1.8,
      durSec: 1.8,
    }));
    const rate = filteredTokensOverTrimmedSpan(jaCues, LANGUAGES['ja']);
    if (rate === null) throw new Error('rate must be computable on the ja cues');
    expect(rate).toBeGreaterThan(MUSIC_RATE_CAP_BY_UNIT.wpm);
    expect(rate).toBeLessThan(MUSIC_RATE_CAP_BY_UNIT.mora);
    expect(detectMusic(jaCues, rate, 'mora')).toBe(true);
    expect(detectMusic(jaCues, rate)).toBe(false); // the unit-blind bug
  });
});
