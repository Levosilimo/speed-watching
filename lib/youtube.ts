// Page-side YouTube structures shared by the content script and the
// sampling harness. Declares window.ytInitialPlayerResponse so both can
// read the player response without type assertions.

export interface CaptionTrack {
  baseUrl: string;
  kind?: string;
  languageCode?: string;
}

export interface PlayerResponse {
  playabilityStatus?: {
    status?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    /** Canonical per-channel key (UC-id); absent on some embeds. */
    channelId?: string;
    /** Display name; the channel-memory fallback key when channelId is
     * missing (names are not unique, so the memory namespaces them). */
    author?: string;
  };
}

declare global {
  interface Window {
    ytInitialPlayerResponse?: PlayerResponse;
  }
}

/** Stable per-channel memory key from the player response: the channelId
 * when present, else the author name (namespaced — names are not unique). */
export function channelKeyOf(videoDetails: PlayerResponse['videoDetails']): string | undefined {
  const id = videoDetails?.channelId;
  if (id !== undefined && id !== '') return id;
  const author = videoDetails?.author;
  return author !== undefined && author !== '' ? `author:${author}` : undefined;
}

/** One chapter: title plus the wall-clock span it covers. The last chapter's
 * endSec stays 0 — the caller fills it from the video duration. */
export interface ChapterSegment {
  title: string;
  startSec: number;
  endSec: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function dig(value: unknown, ...keys: string[]): unknown {
  let cur = value;
  for (const key of keys) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Seconds from a watch URL t= query: bare seconds (t=1234) or the
 * h/m/s form (t=1h2m3s, t=45s). Null when absent or unparseable. */
function tSeconds(value: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
  if (m === null) return null;
  const total = (m[1] === undefined ? 0 : Number(m[1]) * 3600) +
    (m[2] === undefined ? 0 : Number(m[2]) * 60) +
    (m[3] === undefined ? 0 : Number(m[3]));
  return total > 0 ? total : null;
}

function watchUrlStartSec(url: unknown): number | null {
  if (typeof url !== 'string') return null;
  const param = url.split(/[?&]/).find((part) => part.startsWith('t='));
  return param === undefined ? null : tSeconds(param.slice(2));
}

function finalizeChapters(chapters: ChapterSegment[]): ChapterSegment[] | null {
  const valid = chapters
    .filter((c) => Number.isFinite(c.startSec) && c.startSec >= 0)
    .sort((a, b) => a.startSec - b.startSec);
  if (valid.length === 0) return null;
  for (let i = 0; i < valid.length - 1; i++) valid[i]!.endSec = valid[i + 1]!.startSec;
  return valid;
}

/** Chapters from the playerOverlays markersMap path. */
function chaptersFromMarkersMap(data: unknown): ChapterSegment[] | null {
  const markersMap = dig(
    data,
    'playerOverlays',
    'playerOverlayRenderer',
    'decoratedPlayerBarRenderer',
    'decoratedPlayerBarRenderer',
    'playerBar',
    'multiMarkersPlayerBarRenderer',
    'markersMap',
  );
  if (!Array.isArray(markersMap)) return null;
  const chapters = dig(markersMap[0], 'value', 'chapters');
  if (!Array.isArray(chapters)) return null;
  const out: ChapterSegment[] = [];
  for (const entry of chapters) {
    const renderer = isRecord(entry) ? entry.chapterRenderer : undefined;
    if (!isRecord(renderer)) continue;
    const title = dig(renderer, 'title', 'simpleText');
    const millis = renderer.timeRangeStartMillis;
    if (typeof title !== 'string' || typeof millis !== 'number' || !Number.isFinite(millis) || millis < 0) {
      continue;
    }
    out.push({ title, startSec: millis / 1000, endSec: 0 });
  }
  return finalizeChapters(out);
}

/** Chapters from the engagementPanels macroMarkersList path; the panel
 * items carry no millis, so the start comes from the onTap watch URL's
 * t= query. */
function chaptersFromEngagementPanels(data: unknown): ChapterSegment[] | null {
  const panels = isRecord(data) ? data.engagementPanels : undefined;
  if (!Array.isArray(panels)) return null;
  const out: ChapterSegment[] = [];
  for (const panel of panels) {
    const contents = dig(
      panel,
      'engagementPanelSectionListRenderer',
      'content',
      'macroMarkersListRenderer',
      'contents',
    );
    if (!Array.isArray(contents)) continue;
    for (const entry of contents) {
      const renderer = isRecord(entry) ? entry.macroMarkersListItemRenderer : undefined;
      if (!isRecord(renderer)) continue;
      const title = dig(renderer, 'title', 'simpleText');
      const startSec = watchUrlStartSec(dig(renderer, 'onTap', 'watchEndpoint', 'url'));
      if (typeof title !== 'string' || startSec === null) continue;
      out.push({ title, startSec, endSec: 0 });
    }
  }
  return finalizeChapters(out);
}

/** Chapters from a ytInitialData payload, markersMap first and the
 * engagement-panel list as fallback. Null when the payload carries no
 * usable chapters — the caller's absence signal. */
export function chaptersOf(data: unknown): ChapterSegment[] | null {
  return chaptersFromMarkersMap(data) ?? chaptersFromEngagementPanels(data);
}
