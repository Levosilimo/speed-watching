// Fixture metadata shared by the fixture server (e2e/server.ts) and the
// browser-agnostic specs (e2e/shared/specs.ts).

import type { ChapterSegment } from '../../lib/youtube';

/** Fixture file → caption track kind; absent kind means a manual track. */
export const KIND_BY_FIXTURE: Record<string, string | undefined> = {
  'real/asr-word.json': 'asr',
  'synthetic/word-level.json': 'asr',
  'synthetic/music-lyrics.json': 'asr',
  'synthetic/chaptered.json': 'asr',
  'synthetic/pot-gated.json': 'asr',
  'synthetic/transcript-gated.json': 'asr',
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
 * Fixtures whose /api/timedtext route reproduces the logged-in POT failure:
 * a request WITHOUT the pot/potc proof-of-origin params gets HTTP 200 with
 * an EMPTY body (the exact response a bare captionTracks baseUrl fetch gets
 * on a signed-in page); only a signed request (pot present) is served the
 * payload. The extension's capture-first path must measure from the player's
 * signed fetch, never from a bare re-fetch.
 */
export const POT_GATED_FIXTURES = ['synthetic/pot-gated.json'];

/**
 * Fixtures whose caption payload the fixture server answers through the
 * ANDROID-tail get_transcript fallback: the bare /api/timedtext route
 * 200-empties them (POT gate), and the synthesized ANDROID player response
 * carries the transcript-panel getTranscriptEndpoint params, so the
 * extension must land on /youtubei/v1/get_transcript (lib/transcript.ts).
 * The stub CC controls stay OFF these pages — the capture path must not
 * fire, or the lane would measure from a capture instead of the transcript.
 */
export const TRANSCRIPT_GATED_FIXTURES = ['synthetic/transcript-gated.json'];

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
