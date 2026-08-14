// Fixture metadata shared by the fixture server (e2e/server.ts) and the
// browser-agnostic specs (e2e/shared/specs.ts).

import type { ChapterSegment } from '../../lib/youtube';

/** Fixture file → caption track kind; absent kind means a manual track. */
export const KIND_BY_FIXTURE: Record<string, string | undefined> = {
  'real/asr-word.json': 'asr',
  'synthetic/word-level.json': 'asr',
  'synthetic/music-lyrics.json': 'asr',
  'synthetic/chaptered.json': 'asr',
  'real/manual-cue.json': undefined,
  'synthetic/cue-level-only.json': undefined,
  'synthetic/ja-captions.json': 'asr',
};

/**
 * Fixture file → caption-track languageCode; absent means 'en'. The ja
 * fixture exercises the language-resolution chain (resolveLanguage →
 * recommend → unit label) end-to-end in both browser suites.
 */
export const LANG_BY_FIXTURE: Record<string, string | undefined> = {
  'synthetic/ja-captions.json': 'ja',
};

/**
 * Fixtures whose caption payload the server refuses (403). The content
 * script's WEB fetch fails and the ANDROID innertube fallback must fire;
 * the file itself never needs to exist.
 */
export const BLOCKED_FIXTURES = ['synthetic/web-blocked.json'];

/**
 * Fixtures served as a watch page with no caption tracks at all — the
 * content script must fall back to the 'estimated' heuristic tier.
 */
export const NO_TRACK_FIXTURES = ['synthetic/no-tracks.json'];

/**
 * Fixture → chapter markers injected into the page's ytInitialData (the
 * markersMap shape). The chaptered fixture's cue timeline splits into three
 * 30 s spans — fast speech, lyrics (music), slower speech — so the per-chapter
 * plan diverges from the whole-video recommendation and includes a 1× music
 * segment. endSec is chained by chaptersOf; the sentinel 0 means "to the end".
 */
export const CHAPTERED_FIXTURES: Record<string, ChapterSegment[]> = {
  'synthetic/chaptered.json': [
    { title: 'Intro', startSec: 0, endSec: 30 },
    { title: 'Music break', startSec: 30, endSec: 60 },
    { title: 'Outro', startSec: 60, endSec: 0 },
  ],
};

/**
 * The ytInitialData payload the fixture server injects for a chaptered
 * fixture — the exact markersMap nesting chaptersOf() walks. Null for
 * fixtures without chapters (the absence signal).
 */
export function chapteredInitialData(fixture: string): unknown {
  const chapters = CHAPTERED_FIXTURES[fixture];
  if (chapters === undefined) return null;
  return {
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: [
                  {
                    value: {
                      chapters: chapters.map((chapter) => ({
                        chapterRenderer: {
                          title: { simpleText: chapter.title },
                          timeRangeStartMillis: Math.round(chapter.startSec * 1000),
                        },
                      })),
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}
