// ANDROID innertube caption fetch: the fallback/control path for the
// POT-aware re-run. The WEB timedtext endpoint can return empty-200s from a
// blocked IP, so this POST + baseUrl fetch supplies the segs-layout control
// for the windows==segs parity assertion.

import type { Page } from 'playwright';
import { parseYouTubeJson3 } from '../lib/captions';

export const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.31',
  androidSdkVersion: 30,
  hl: 'en',
  gl: 'US',
};

export interface ExtractResult {
  json: unknown;
  kind: string;
  lang: string;
  trackCount: number;
}

export async function extractCaptionsInPage(input: {
  videoId: string;
  client: Record<string, unknown>;
  /** Preferred track language (normalized); defaults to en. */
  lang?: string;
}): Promise<ExtractResult | { error: string }> {
  const playerRes = await fetch(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: input.client },
        videoId: input.videoId,
      }),
    },
  );
  if (!playerRes.ok) {
    return { error: `android-player-http-${playerRes.status}` };
  }
  const playerJson = (await playerRes.json()) as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{
          kind?: string;
          languageCode?: string;
          baseUrl: string;
        }>;
      };
    };
  };
  const tracks =
    playerJson.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const lang = input.lang ?? 'en';
  // page-side code: normalization inlined, imports do not cross evaluate()
  const inLang = (t: { kind?: string; languageCode?: string }): boolean =>
    t.languageCode !== undefined && t.languageCode.toLowerCase().split('-')[0] === lang;
  const pick =
    tracks.find((t) => t.kind === 'asr' && inLang(t)) ??
    tracks.find((t) => t.kind !== 'asr' && inLang(t)) ??
    tracks.find((t) => t.kind === 'asr') ??
    tracks[0];
  if (!pick) return { error: 'no-caption-tracks' };
  const url = new URL(pick.baseUrl, location.href);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url);
  if (!response.ok) return { error: `caption-fetch-http-${response.status}` };
  const text = await response.text();
  if (text.length === 0) return { error: 'caption-fetch-empty' };
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { error: 'caption-fetch-not-json' };
  }
  return {
    json,
    kind: pick.kind ?? 'manual',
    lang: pick.languageCode ?? '?',
    trackCount: tracks.length,
  };
}

/** Fields androidControl mutates on the caller's record — the en harness's
 * SampleRecord and the ru corpus runner's CorpusRecord both satisfy it. */
export interface AndroidRecord {
  error: string | null;
  status: string;
  webAsrCount?: number | null;
  androidKind: string | null;
  androidLang: string | null;
  androidTrackCount: number | null;
  segsCues: number | null;
  segsWords: number | null;
}

/** ANDROID innertube control: fills segs fields, upgrades web-empty to
 * android-fallback, and flags WEB/ANDROID track-list disagreements. `lang`
 * (default 'en') is the preferred track language the control re-picks. */
export async function androidControl(
  page: Page,
  record: AndroidRecord,
  videoId: string,
  onJson: (json: unknown) => void,
  lang = 'en',
): Promise<void> {
  const extracted = await page.evaluate(extractCaptionsInPage, {
    videoId,
    client: ANDROID_CLIENT,
    lang,
  });
  if ('error' in extracted) {
    if (record.status === 'web-captured' || record.status === 'parse-failed') {
      record.error = `android-control: ${extracted.error}`;
    } else {
      record.error = [record.error, `android: ${extracted.error}`]
        .filter((e): e is string => e !== null)
        .join('; ');
    }
    return;
  }
  onJson(extracted.json);
  record.androidKind = extracted.kind;
  record.androidLang = extracted.lang;
  record.androidTrackCount = extracted.trackCount;
  const parsed = parseYouTubeJson3(extracted.json);
  record.segsCues = parsed.cues.length;
  record.segsWords = parsed.words.length;
  if (record.status === 'web-empty' && (record.webAsrCount ?? 0) > 0) {
    record.status = 'android-fallback';
  }
  const webSaysAsr = (record.webAsrCount ?? 0) > 0;
  const androidSaysAsr = extracted.kind === 'asr';
  if (androidSaysAsr !== webSaysAsr) {
    record.error = [
      record.error,
      `web-vs-android-track-disagreement (android kind: ${extracted.kind})`,
    ]
      .filter((e): e is string => e !== null)
      .join('; ');
  }
}
