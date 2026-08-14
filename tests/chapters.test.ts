import { describe, expect, it } from 'vitest';
import { chaptersOf } from '../lib/youtube';

/** Real-shaped ytInitialData playerOverlays tree (markersMap path). */
function markersData(chapters: unknown[]): Record<string, unknown> {
  return {
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: [{ key: 'chapters', value: { chapters } }],
              },
            },
          },
        },
      },
    },
  };
}

function chapter(title: string, timeRangeStartMillis: number): unknown {
  return { chapterRenderer: { title: { simpleText: title }, timeRangeStartMillis } };
}

function panelsData(items: unknown[]): Record<string, unknown> {
  return {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            macroMarkersListRenderer: { contents: items },
          },
        },
      },
    ],
  };
}

function panelItem(title: string, url: string): unknown {
  return {
    macroMarkersListItemRenderer: {
      title: { simpleText: title },
      onTap: { watchEndpoint: { url } },
    },
  };
}

describe('chaptersOf', () => {
  it('reads chapters from the markersMap path with millis → seconds', () => {
    const data = markersData([
      chapter('Intro', 0),
      chapter('Setup', 123_000),
      chapter('Results', 456_789),
    ]);
    expect(chaptersOf(data)).toEqual([
      { title: 'Intro', startSec: 0, endSec: 123 },
      { title: 'Setup', startSec: 123, endSec: 456.789 },
      { title: 'Results', startSec: 456.789, endSec: 0 },
    ]);
  });

  it('sorts chapters by start and chains endSec to the next start', () => {
    const data = markersData([
      chapter('Late', 300_000),
      chapter('Early', 0),
      chapter('Middle', 100_000),
    ]);
    expect(chaptersOf(data)).toEqual([
      { title: 'Early', startSec: 0, endSec: 100 },
      { title: 'Middle', startSec: 100, endSec: 300 },
      { title: 'Late', startSec: 300, endSec: 0 },
    ]);
  });

  it('drops entries with missing titles or non-finite negative millis', () => {
    const data = markersData([
      { chapterRenderer: { timeRangeStartMillis: 0 } },
      { chapterRenderer: { title: { simpleText: 'Bad NaN' }, timeRangeStartMillis: Number.NaN } },
      { chapterRenderer: { title: { simpleText: 'Bad neg' }, timeRangeStartMillis: -5 } },
      chapter('Kept', 2000),
    ]);
    expect(chaptersOf(data)).toEqual([{ title: 'Kept', startSec: 2, endSec: 0 }]);
  });

  it('falls back to the engagement panels with t= parsed from the onTap URL', () => {
    const data = panelsData([
      panelItem('Part 1', '/watch?v=abc&t=1234s'),
      panelItem('Part 2', '/watch?v=abc?t=90'),
      panelItem('Part 3', '/watch?v=abc&t=1h2m3s'),
    ]);
    expect(chaptersOf(data)).toEqual([
      { title: 'Part 2', startSec: 90, endSec: 1234 },
      { title: 'Part 1', startSec: 1234, endSec: 3723 },
      { title: 'Part 3', startSec: 3723, endSec: 0 },
    ]);
  });

  it('prefers the markersMap path and only consults panels when it is unusable', () => {
    const data = { ...markersData([chapter('Bar', 5000)]), ...panelsData([panelItem('Panel', '/watch?v=x&t=10')]) };
    expect(chaptersOf(data)).toEqual([{ title: 'Bar', startSec: 5, endSec: 0 }]);

    const unusable = { ...markersData([{ chapterRenderer: {} }]), ...panelsData([panelItem('Panel', '/watch?v=x&t=10')]) };
    expect(chaptersOf(unusable)).toEqual([{ title: 'Panel', startSec: 10, endSec: 0 }]);
  });

  it('returns null for absent, empty, and all-invalid payloads', () => {
    expect(chaptersOf(undefined)).toBeNull();
    expect(chaptersOf({})).toBeNull();
    expect(chaptersOf(markersData([]))).toBeNull();
    expect(chaptersOf(panelsData([]))).toBeNull();
    expect(chaptersOf(markersData([{ chapterRenderer: {} }]))).toBeNull();
    expect(chaptersOf(panelsData([panelItem('No t', '/watch?v=abc')]))).toBeNull();
    expect(chaptersOf(panelsData([panelItem('Bad t', '/watch?v=abc&t=xyz')]))).toBeNull();
  });
});
