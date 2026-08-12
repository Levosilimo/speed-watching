// Phase-0 STT battery — data acquisition: downloads the whisper models, the
// YouTube-ASR caption payloads and the lecture audio for the phase-0 corpus,
// then slices the per-video clip windows. The V1 model-lock and V2 chunk-seam
// measurements live in scripts/stt-battery-analysis.ts; the fixture origin +
// runner in scripts/stt-battery-lib.ts.
//
// Audio + references come from the ANDROID innertube player response (the
// harness's established path): captionTracks baseUrl (fmt=json3) for the
// reference, streamingData audio URL for the audio. YouTube now enforces a
// Proof-of-Origin check on googlevideo: without a PO token only the first
// ~256 KB of a stream is fetchable (bounded range from offset 0; open-ended
// or nonzero-offset ranges 403). Measured on this corpus, that capped fetch
// is NOT trustworthy: for 3 of 5 videos the first 256 KB decoded to audio
// with zero correlation against the real video (different content entirely;
// only iG9CE55wbtY and Ks-_Mh1QhMc matched, correlation 0.38/0.22). The
// battery therefore pulls the audio with yt-dlp (itag 139, full file, no PO
// token needed) and slices the ~66 s window locally.
//
//   bun run scripts/stt-battery.ts --models   # download tiny.en + base.en q8
//   bun run scripts/stt-battery.ts --fetch    # json3 refs + audio per video
//   bun run scripts/stt-battery.ts --clips    # slice windows + reference rates
//   bun run scripts/stt-battery.ts --transcribe   (analysis file)
//   bun run scripts/stt-battery.ts --seam         (analysis file)
//
// Committed outputs: scripts/data/stt-battery/{meta,results-v1,results-v2}.jsonl
// (numbers only). Audio, f32 clips and caption payloads live in gitignored
// subdirectories — full transcripts are not committed (repo fixture policy).
// Exit 1 only on harness errors; measured failures are data.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseYouTubeJson3, type ParsedCaptions } from '../lib/captions';
import { ANDROID_CLIENT } from './captions-android';
import { MODEL_FILES, MODELS_DIR } from './bench-whisper-lib';
import {
  AUDIO_DIR,
  BATTERY_DIR,
  BATTERY_MODELS,
  BATTERY_VIDEOS,
  CLIPS_DIR,
  REFS_DIR,
  type ClipRef,
  type BatteryModel,
} from './stt-battery-lib';
import { seamStep, smokeStep, transcribeStep } from './stt-battery-analysis';

// ---------------------------------------------------------------------------
// Model download (q8 onnx, same file set as the bench harness).

async function downloadModels(): Promise<void> {
  for (const model of BATTERY_MODELS) {
    const modelDir = join(MODELS_DIR, model);
    await mkdir(join(modelDir, 'onnx'), { recursive: true });
    for (const file of MODEL_FILES) {
      const target = join(modelDir, file);
      if (existsSync(target)) continue;
      const url = `https://huggingface.co/${model}/resolve/main/${file}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`model download failed ${model}/${file}: ${res.status}`);
      await writeFile(target, Buffer.from(await res.arrayBuffer()));
      console.log(`[models] ${model}/${file} (${(await stat(target)).size} bytes)`);
    }
  }
}

// ---------------------------------------------------------------------------
// V1 fetch step: ANDROID innertube player response -> caption json3 + audio.

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{ kind?: string; languageCode?: string; baseUrl: string }>;
    };
  };
  streamingData?: {
    formats?: Array<{ itag?: number; url?: string; mimeType?: string; bitrate?: number }>;
    adaptiveFormats?: Array<{ itag?: number; url?: string; mimeType?: string; bitrate?: number }>;
  };
  videoDetails?: { title?: string; lengthSeconds?: string };
}

async function playerResponse(videoId: string): Promise<PlayerResponse> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
  });
  if (!res.ok) throw new Error(`player http ${res.status}`);
  return (await res.json()) as PlayerResponse;
}

// Audio acquisition: yt-dlp itag 139, full file (no PO token needed). The
// earlier POT-capped stream range fetch served unrelated audio for 3 of 5
// corpus videos and is gone; see the header for the measured evidence.
const YTDLP_ITAG = '139';
const CLIP_SLICE_SEC = 66;

async function fetchStep(): Promise<void> {
  await mkdir(AUDIO_DIR, { recursive: true });
  await mkdir(REFS_DIR, { recursive: true });
  const meta: string[] = [];
  for (const video of BATTERY_VIDEOS) {
    const json3Path = join(REFS_DIR, `${video.id}.json3`);
    const audioPath = join(AUDIO_DIR, `${video.id}.raw`);
    const f32Path = join(AUDIO_DIR, `${video.id}.f32`);
    const record: Record<string, unknown> = { videoId: video.id, category: video.category };
    if (existsSync(json3Path) && existsSync(f32Path)) {
      console.log(`[fetch] ${video.id}: cached`);
      meta.push(JSON.stringify(record));
      continue;
    }
    try {
      const player = await playerResponse(video.id);
      record.title = player.videoDetails?.title ?? null;
      record.durationSec = player.videoDetails?.lengthSeconds
        ? Number(player.videoDetails.lengthSeconds)
        : null;
      const track =
        player.captions?.playerCaptionsTracklistRenderer?.captionTracks?.find(
          (t) => t.kind === 'asr' && t.languageCode === 'en',
        ) ??
        player.captions?.playerCaptionsTracklistRenderer?.captionTracks?.find(
          (t) => t.kind === 'asr',
        );
      if (!track) {
        record.error = 'no-asr-track';
      } else {
        const url = new URL(track.baseUrl);
        url.searchParams.set('fmt', 'json3');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`caption http ${res.status}`);
        await writeFile(json3Path, Buffer.from(await res.arrayBuffer()));
        record.json3Bytes = (await stat(json3Path)).size;
      }
      try {
        execFileSync(
          'yt-dlp',
          ['-f', YTDLP_ITAG, '-o', audioPath, '--no-part', '--quiet', `https://www.youtube.com/watch?v=${video.id}`],
          { timeout: 600_000 },
        );
        record.itag = Number(YTDLP_ITAG);
        record.audioSource = 'yt-dlp';
        record.audioBytes = (await stat(audioPath)).size;
        execFileSync('ffmpeg', [
          '-v', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 'f32le', f32Path,
        ]);
        record.decodedBytes = (await stat(f32Path)).size;
      } catch (e) {
        record.audioError = e instanceof Error ? e.message : String(e);
      }
    } catch (e) {
      record.error = e instanceof Error ? e.message : String(e);
    }
    console.log(`[fetch] ${video.id}: ${record.error ?? record.audioError ?? 'ok'}`);
    meta.push(JSON.stringify(record));
  }
  await writeFile(join(BATTERY_DIR, 'meta.jsonl'), meta.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Clip step: slice the f32 window + slice the reference words/cues to it.

function sliceF32(all: Float32Array, startSec: number, durSec: number): Buffer {
  const start = Math.floor(startSec * 16000);
  const len = Math.floor(durSec * 16000);
  const win = all.subarray(start, start + len);
  return Buffer.from(win.buffer, win.byteOffset, win.byteLength);
}

function windowedParsed(parsed: ParsedCaptions, startSec: number, endSec: number): ParsedCaptions {
  return {
    words: parsed.words.filter((w) => w.startSec >= startSec && w.startSec < endSec),
    cues: parsed.cues.filter((c) => c.startSec >= startSec && c.startSec < endSec),
  };
}

async function clipStep(): Promise<void> {
  await mkdir(CLIPS_DIR, { recursive: true });
  const clips: ClipRef[] = [];
  for (const video of BATTERY_VIDEOS) {
    const f32Path = join(AUDIO_DIR, `${video.id}.f32`);
    const json3Path = join(REFS_DIR, `${video.id}.json3`);
    if (!existsSync(f32Path) || !existsSync(json3Path)) {
      console.warn(`[clips] ${video.id}: missing audio/ref, run --fetch first`);
      continue;
    }
    const buf = await readFile(f32Path);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const decodedSec = all.length / 16000;
    const window = { startSec: 0, durSec: Math.min(Math.max(decodedSec - 1, 0), CLIP_SLICE_SEC) };
    const clip = sliceF32(all, window.startSec, window.durSec);
    await writeFile(join(CLIPS_DIR, `${video.id}.f32`), clip);
    const parsed = parseYouTubeJson3(JSON.parse(await readFile(json3Path, 'utf8')));
    const windowed = windowedParsed(parsed, window.startSec, window.startSec + window.durSec);
    clips.push({ videoId: video.id, category: video.category, window, ...windowed });
    console.log(
      `[clips] ${video.id}: ${window.durSec.toFixed(1)}s window, ` +
        `${windowed.words.length} ref words, ${windowed.cues.length} cues`,
    );
  }
  // Reference rates + transcript strings live in the gitignored refs dir.
  for (const clip of clips) {
    await writeFile(join(REFS_DIR, `${clip.videoId}.clip.json`), JSON.stringify(clip, null, 1));
  }
}


// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  await mkdir(BATTERY_DIR, { recursive: true });
  if (args.includes('--models')) {
    await downloadModels();
    console.log('[models] done');
  }
  if (args.includes('--fetch')) await fetchStep();
  if (args.includes('--clips')) await clipStep();
  if (args.includes('--transcribe')) await transcribeStep();
  if (args.includes('--seam')) await seamStep();
  if (args.includes('--smoke')) {
    const i = args.indexOf('--smoke');
    const clipId = args[i + 1] ?? BATTERY_VIDEOS[0].id;
    const model = (args[i + 2] as BatteryModel) ?? 'Xenova/whisper-tiny.en';
    if (!BATTERY_MODELS.includes(model)) {
      throw new Error(`unknown model ${model} (expected ${BATTERY_MODELS.join(' or ')})`);
    }
    await smokeStep(clipId, model);
  }
}

await main();
