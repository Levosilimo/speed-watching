// Selection-time ASR verification for the captionless-reach batch
// (spec: .slim/deepwork/specs/batch-b.md). Probes candidate video IDs via
// the ANDROID innertube player — the sr lesson: reject candidates without
// the target <lang>:asr track before they ever enter the manifest — then
// emits scripts/data/corpus-b.json with per-video provenance (ar dialect,
// hi script) and per-register fallback pools (verified candidates that did
// not make the primary list).
//
// Run: bun run scripts/batch-select.ts [--candidates=corpus-b-candidates.json]
//      bun run scripts/batch-select.ts --probe=VIDEOID [--lang=hi]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_CLIENT } from './captions-android';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_CANDIDATES = 'corpus-b-candidates.json';
const OUT_MANIFEST = join(ROOT, 'data', 'corpus-b.json');

interface ProbeQuery {
  query: string;
  /** es-419-style provenance for videos found by this query. */
  provenance: string;
}

type CandidatesFile = Record<string, Record<string, ProbeQuery[]>>;

interface VerifiedVideo {
  videoId: string;
  title: string;
  channel: string;
  provenance: string;
}

/** Videos-only search filter param for the ANDROID search endpoint. */
const VIDEOS_ONLY = 'EgIQAQ%3D%3D';

async function innertube(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/${path}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}-http-${res.status}`);
  return res.json() as Promise<unknown>;
}

/** Recursively collect videoRenderers (videoId + title + owner) from the
 * search response tree. */
function collectVideos(node: unknown, out: Array<{ videoId: string; title: string; channel: string }>): void {
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  const renderer = record.videoRenderer;
  if (typeof renderer === 'object' && renderer !== null) {
    const v = renderer as Record<string, unknown>;
    if (typeof v.videoId === 'string' && v.videoId !== '') {
      const titleRuns = (v.title as { runs?: Array<{ text?: string }> })?.runs;
      const ownerRuns = (v.ownerText as { runs?: Array<{ text?: string }> })?.runs;
      out.push({
        videoId: v.videoId,
        title: titleRuns?.map((r) => r.text ?? '').join('') ?? '',
        channel: ownerRuns?.map((r) => r.text ?? '').join('') ?? '',
      });
    }
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) collectVideos(item, out);
    } else {
      collectVideos(value, out);
    }
  }
}

async function searchVideos(query: string): Promise<Array<{ videoId: string; title: string; channel: string }>> {
  // WEB client: the ANDROID search now serves the elements architecture
  // (no videoRenderer); WEB still returns the classic renderer tree.
  const json = (await innertube('search', {
    context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
    query,
    params: VIDEOS_ONLY,
  })) as Record<string, unknown>;
  const out: Array<{ videoId: string; title: string; channel: string }> = [];
  collectVideos(json, out);
  return out;
}

interface TrackInfo {
  kind: string | undefined;
  languageCode: string | undefined;
}

interface ProbeResult {
  playable: boolean;
  tracks: TrackInfo[];
}

async function probeVideo(videoId: string): Promise<ProbeResult> {
  const json = (await innertube('player', {
    context: { client: ANDROID_CLIENT },
    videoId,
  })) as Record<string, unknown>;
  const playable = (json.playabilityStatus as Record<string, unknown> | undefined)?.status === 'OK';
  const tracks =
    (json.captions as Record<string, unknown> | undefined)?.playerCaptionsTracklistRenderer as
      | Record<string, unknown>
      | undefined;
  const captionTracks = Array.isArray(tracks?.captionTracks) ? (tracks.captionTracks as TrackInfo[]) : [];
  return { playable, tracks: captionTracks };
}

/** The target ASR check: hi requires the exact 'hi' code (Devanagari —
 * 'hi-Latn' tracks are romanized and reject at the analysis layer too);
 * ar/id/vi match the prefix. */
function hasTargetAsr(tracks: TrackInfo[], lang: string): boolean {
  return tracks.some(
    (t) =>
      t.kind === 'asr' &&
      t.languageCode !== undefined &&
      (lang === 'hi' ? t.languageCode.toLowerCase() === 'hi' : t.languageCode.toLowerCase().startsWith(lang)),
  );
}

async function probeOne(videoId: string, lang: string): Promise<void> {
  const { playable, tracks } = await probeVideo(videoId);
  const asrLangs = tracks.filter((t) => t.kind === 'asr').map((t) => t.languageCode ?? '?');
  console.log(
    `${videoId}: playable=${playable} asrTracks=[${asrLangs.join(', ')}] target=${hasTargetAsr(tracks, lang)}`,
  );
}

interface RegisterSelection {
  videos: VerifiedVideo[];
  fallbacks: string[];
}

async function selectRegister(
  lang: string,
  register: string,
  queries: ProbeQuery[],
  need: number,
): Promise<RegisterSelection> {
  const seen = new Set<string>();
  const verified: VerifiedVideo[] = [];
  const rejected: Array<{ videoId: string; reason: string }> = [];
  for (const { query, provenance } of queries) {
    let found: Array<{ videoId: string; title: string; channel: string }> = [];
    try {
      found = (await searchVideos(query)).slice(0, 8);
    } catch (err) {
      console.warn(`  search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const video of found) {
      if (seen.has(video.videoId)) continue;
      seen.add(video.videoId);
      const { playable, tracks } = await probeVideo(video.videoId);
      if (!playable) {
        rejected.push({ videoId: video.videoId, reason: 'geo-block' });
      } else if (tracks.length === 0) {
        rejected.push({ videoId: video.videoId, reason: 'no-caption-tracks' });
      } else if (!hasTargetAsr(tracks, lang)) {
        const asrLangs = tracks.filter((t) => t.kind === 'asr').map((t) => t.languageCode ?? '?');
        rejected.push({ videoId: video.videoId, reason: `no-${lang}-asr (asr=[${asrLangs.join(',')}])` });
      } else {
        verified.push({ videoId: video.videoId, title: video.title, channel: video.channel, provenance });
        if (verified.length >= need) break;
      }
    }
    if (verified.length >= need) break;
  }
  const fallbacks = verified.slice(3).map((v) => v.videoId);
  console.log(
    `  ${lang}:${register}: verified=${verified.length}/${need} rejected=${rejected.length}` +
      (rejected.length > 0 ? ` (${rejected.slice(0, 6).map((r) => `${r.videoId}:${r.reason}`).join(', ')})` : ''),
  );
  return { videos: verified.slice(0, 3), fallbacks };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const probeArg = args.find((a) => a.startsWith('--probe='))?.slice('--probe='.length);
  const langArg = args.find((a) => a.startsWith('--lang='))?.slice('--lang='.length) ?? 'hi';
  if (probeArg !== undefined) {
    await probeOne(probeArg, langArg);
    return;
  }
  const candidatesArg = args.find((a) => a.startsWith('--candidates='))?.slice('--candidates='.length);
  const candidatesPath = join(ROOT, 'data', candidatesArg ?? DEFAULT_CANDIDATES);
  const candidates = JSON.parse(readFileSync(candidatesPath, 'utf8')) as CandidatesFile;

  const videos: Array<Record<string, string>> = [];
  const fallbacks: Record<string, string[]> = {};
  for (const [lang, registers] of Object.entries(candidates)) {
    for (const [register, queries] of Object.entries(registers)) {
      const { videos: picked, fallbacks: pool } = await selectRegister(lang, register, queries, 4);
      for (const v of picked.slice(0, 3)) {
        videos.push({
          videoId: v.videoId,
          register,
          title: `${v.channel} — ${v.title}`.slice(0, 120),
          language: lang,
          provenance: v.provenance,
        });
      }
      if (pool.length > 0) fallbacks[`${lang}:${register}`] = pool;
    }
  }
  writeFileSync(OUT_MANIFEST, JSON.stringify({ videos, fallbacks }, null, 2) + '\n', 'utf8');
  console.log(`manifest -> ${OUT_MANIFEST} (${videos.length} videos)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
