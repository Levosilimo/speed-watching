// Chapter-shape extraction for the chapter-coverage probe. The page side
// polls window.ytInitialPlayerResponse like lib/measure-hooks.ts
// waitForPlayerResponse does (250 ms cadence, 10 s deadline) and hands
// the raw object back; the node side walks the exact spec shape with
// per-step drift reporting, so a renamed or moved field shows up as
// evidence instead of a silent miss:
//
//   playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer
//     .decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer
//     .markersMap[].value.chapters[].chapterRenderer
//     {title.simpleText, timeRangeStartMillis}
//
// readPlayerResponse runs in the page (playwright serializes it — it must
// stay self-contained); extractChapters runs in node on the returned
// object and is plain, testable TS.

export interface ChapterInfo {
  title: string;
  startMillis: number | null;
}

export interface PageExtract {
  title: string | null;
  playability: string | null;
  durationSec: number | null;
  shapeValid: boolean;
  shapeDrift: string | null;
  markersIndex: number | null;
  chapters: ChapterInfo[];
}

export function readPlayerResponse(): Promise<unknown> {
  return (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (window.ytInitialPlayerResponse !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return window.ytInitialPlayerResponse;
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

// Walk the fixed spec path; on breakage record the deepest key reached
// and the keys actually present there.
function walkShape(pr: Record<string, unknown>, result: PageExtract): boolean {
  const steps = [
    'playerOverlays',
    'playerOverlayRenderer',
    'decoratedPlayerBarRenderer',
    'decoratedPlayerBarRenderer',
    'playerBar',
    'multiMarkersPlayerBarRenderer',
    'markersMap',
  ];
  let node: unknown = pr;
  const path: string[] = [];
  for (const step of steps) {
    path.push(step);
    if (!isRecord(node) || node[step] === undefined || node[step] === null) {
      result.shapeDrift =
        `path broke at '${path.join('.')}'` +
        (isRecord(node) ? `; keys present: ${Object.keys(node).slice(0, 12).join(',')}` : '');
      return false;
    }
    node = node[step];
  }
  if (!Array.isArray(node)) {
    result.shapeDrift = `markersMap is ${typeof node}, expected array`;
    return false;
  }
  const markerKeys: string[] = [];
  for (let i = 0; i < node.length; i++) {
    const entryRecord = isRecord(node[i]) ? node[i] : undefined;
    markerKeys.push(
      entryRecord !== undefined && typeof entryRecord.key === 'string' ? entryRecord.key : '?',
    );
    const chapters = chaptersOf(node[i]);
    if (chapters === null) continue;
    result.shapeValid = true;
    result.markersIndex = i;
    result.chapters = chapters;
    return true;
  }
  // The bar exists but no marker entry carries chapters — that is the
  // duration-gated no-chapters state, not shape drift.
  result.shapeValid = true;
  result.shapeDrift =
    node.length === 0 ? 'markersMap empty' : `marker keys: ${markerKeys.join(', ')} — no chapters value`;
  return true;
}

export function extractChapters(pr: unknown): PageExtract {
  const result: PageExtract = {
    title: null,
    playability: null,
    durationSec: null,
    shapeValid: false,
    shapeDrift: null,
    markersIndex: null,
    chapters: [],
  };
  if (!isRecord(pr)) {
    result.shapeDrift = 'ytInitialPlayerResponse is not an object';
    return result;
  }
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
  walkShape(pr, result);
  return result;
}
