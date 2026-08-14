// Chapter-shape extraction for the chapter-coverage probe. The page side
// polls the watch page's two data roots — window.ytInitialPlayerResponse
// (player endpoint) and window.ytInitialData (next endpoint) — like
// lib/measure-hooks.ts waitForPlayerResponse does (250 ms cadence, 10 s
// deadline) and hands them back; the node side walks the exact spec
// shape at each root with per-step drift reporting, so a renamed or
// moved field shows up as evidence instead of a silent miss:
//
//   <root>.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer
//     .decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer
//     .markersMap[].value.chapters[].chapterRenderer
//     {title.simpleText, timeRangeStartMillis}
//
// readPageData runs in the page (playwright serializes it — it must stay
// self-contained); extractChapters runs in node on the returned object
// and is plain, testable TS.

declare global {
  interface Window {
    ytInitialData?: unknown;
  }
}

export interface ChapterInfo {
  title: string;
  startMillis: number | null;
}

export interface PageData {
  playerResponse: unknown;
  initialData: unknown;
}

export interface PageExtract {
  title: string | null;
  playability: string | null;
  durationSec: number | null;
  /** The spec shape resolved end to end at either root. */
  shapeValid: boolean;
  /** Breakage notes per root (deepest key + keys present there). */
  shapeDrift: string | null;
  /** Which root carried the chapters used; null when none did. */
  sourceRoot: 'playerResponse' | 'initialData' | null;
  markersIndex: number | null;
  chapters: ChapterInfo[];
}

export function readPageData(): Promise<PageData> {
  return (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (
        window.ytInitialPlayerResponse !== undefined &&
        window.ytInitialData !== undefined
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      playerResponse: window.ytInitialPlayerResponse,
      initialData: window.ytInitialData,
    };
  })();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Chapters of one markersMap entry; null when the entry carries none.
function chaptersOf(entry: unknown): ChapterInfo[] | null {
  const value = isRecord(entry) ? entry.value : undefined;
  const list = isRecord(value) ? value.chapters : undefined;
  if (!Array.isArray(list)) return null;
  return list.map((chapter) => {
    const renderer = isRecord(chapter) ? chapter.chapterRenderer : undefined;
    const titleNode = isRecord(renderer) ? renderer.title : undefined;
    let title = '';
    if (isRecord(titleNode) && typeof titleNode.simpleText === 'string') {
      title = titleNode.simpleText;
    } else if (isRecord(titleNode) && Array.isArray(titleNode.runs)) {
      title = titleNode.runs
        .map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : ''))
        .join('');
    }
    const start = isRecord(renderer) ? renderer.timeRangeStartMillis : undefined;
    return { title, startMillis: typeof start === 'number' ? start : null };
  });
}

// Chapters carried by the first markersMap entry that has them.
function chaptersOfMap(markersMap: unknown[]): { chapters: ChapterInfo[] | null; index: number; note: string } {
  const markerKeys: string[] = [];
  for (let i = 0; i < markersMap.length; i++) {
    const entry = markersMap[i];
    const entryRecord = isRecord(entry) ? entry : undefined;
    markerKeys.push(
      entryRecord !== undefined && typeof entryRecord.key === 'string' ? entryRecord.key : '?',
    );
    const chapters = chaptersOf(entry);
    if (chapters !== null) return { chapters, index: i, note: '' };
  }
  return {
    chapters: null,
    index: -1,
    note:
      markersMap.length === 0
        ? 'markersMap empty'
        : `marker keys: ${markerKeys.join(', ')} — no chapters value`,
  };
}

// Walk the fixed spec path under one root; on breakage record the
// deepest key reached and the keys actually present there. Returns the
// markersMap array, or undefined when the path broke.
function walkRoot(root: unknown, rootName: string): unknown[] | string {
  const steps = [
    'playerOverlays',
    'playerOverlayRenderer',
    'decoratedPlayerBarRenderer',
    'decoratedPlayerBarRenderer',
    'playerBar',
    'multiMarkersPlayerBarRenderer',
    'markersMap',
  ];
  let node: unknown = root;
  const path: string[] = [];
  for (const step of steps) {
    path.push(step);
    if (!isRecord(node) || node[step] === undefined || node[step] === null) {
      return (
        `${rootName}: path broke at '${path.join('.')}'` +
        (isRecord(node) ? `; keys present: ${Object.keys(node).slice(0, 12).join(',')}` : '')
      );
    }
    node = node[step];
  }
  if (!Array.isArray(node)) return `${rootName}: markersMap is ${typeof node}, expected array`;
  return node;
}

export function extractChapters(data: PageData): PageExtract {
  const result: PageExtract = {
    title: null,
    playability: null,
    durationSec: null,
    shapeValid: false,
    shapeDrift: null,
    markersIndex: null,
    sourceRoot: null,
    chapters: [],
  };
  const pr = data.playerResponse;
  if (isRecord(pr)) {
    const playability = pr.playabilityStatus;
    if (isRecord(playability) && typeof playability.status === 'string') {
      result.playability = playability.status;
    }
    const details = pr.videoDetails;
    if (isRecord(details)) {
      if (typeof details.title === 'string') result.title = details.title;
      const length = details.lengthSeconds;
      if (typeof length === 'string') result.durationSec = Number(length);
      else if (typeof length === 'number') result.durationSec = length;
    }
  }
  // The spec path under each root. Modern watch pages carry the chapter
  // bar in ytInitialData; the player endpoint response stopped shipping
  // playerOverlays — both are walked so the drift is measured, not
  // assumed, and either root's chapters count as coverage.
  const prWalk = walkRoot(pr, 'playerResponse');
  const dataWalk = walkRoot(data.initialData, 'initialData');
  const prMap = typeof prWalk === 'string' ? undefined : prWalk;
  const dataMap = typeof dataWalk === 'string' ? undefined : dataWalk;

  let chapters: ChapterInfo[] | null = null;
  let sourceRoot: PageExtract['sourceRoot'] = null;
  let markersIndex: number | null = null;
  if (prMap !== undefined) {
    const found = chaptersOfMap(prMap);
    if (found.chapters !== null) {
      chapters = found.chapters;
      sourceRoot = 'playerResponse';
      markersIndex = found.index;
    }
  }
  if (chapters === null && dataMap !== undefined) {
    const found = chaptersOfMap(dataMap);
    if (found.chapters !== null) {
      chapters = found.chapters;
      sourceRoot = 'initialData';
      markersIndex = found.index;
    }
  }
  if (chapters !== null) {
    result.shapeValid = true;
    result.markersIndex = markersIndex;
    const notes = [prWalk, dataWalk].filter((n): n is string => typeof n === 'string');
    if (notes.length > 0) result.shapeDrift = notes.join('; ');
  } else {
    const notes = [prWalk, dataWalk].filter((n): n is string => typeof n === 'string');
    if (prMap !== undefined) notes.push(`playerResponse: ${chaptersOfMap(prMap).note}`);
    if (dataMap !== undefined) notes.push(`initialData: ${chaptersOfMap(dataMap).note}`);
    result.shapeDrift = notes.join('; ');
  }
  result.chapters = chapters ?? [];
  result.sourceRoot = sourceRoot;
  return result;
}
