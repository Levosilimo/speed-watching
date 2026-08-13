# Phase 2 Lane B: STT recorder plumbing — design and contract

Dormant-but-wired stage of the on-device STT tier (lib-10 plan,
`docs/phase2-whisper-benchmark.md`): the offscreen document can now record
the live tab-capture stream as 16 kHz mono f32 and drain it in fixed-size
chunks. Nothing drives it yet — the message kinds are accepted and echoed,
the graph is built only when `stt:start-recording` arrives.

## Recorder design

```
tab-capture MediaStream
  → AudioContext (default = device rate; worklet reads its sampleRate)
  → MediaStreamAudioSourceNode
  → AudioWorkletNode('speed-watcher-resampler', channelCount 2 explicit)
       └─ lib/recorder-worklet.ts: Resampler (lib/resampler.ts) decimates
          native rate → 16 kHz mono; posts 1024-sample chunks (transferred,
          zero-copy) over the node port
  → lib/audio-recorder.ts: main-thread ring buffer (60 s cap, ~3.8 MiB)
  → flushChunk(seconds) → Float32Array at 16000 Hz
```

- **Resampling is pure math** (`lib/resampler.ts`): linear interpolation at
  fractional input positions, stereo→mono downmix, arbitrary native rate.
  Stream position, total frames, and the previous block's last frame carry
  across calls, so blocks of any length resample exactly like one continuous
  buffer — no drift (unit-proven: 100 × 441-frame blocks at 44.1 kHz yield
  exactly 16 000 samples, and block-split output is bit-identical to a
  single buffer).
- **Why AudioWorklet, not ScriptProcessor**: `ScriptProcessorNode` is
  deprecated in the Web Audio API spec (MDN: "use AudioWorklet instead") —
  it runs its callback on the main thread, so the render quantum blocks the
  UI (and the offscreen document's message loop). AudioWorklet runs the
  processor on the audio rendering thread and is the pattern the Suki AI
  engineering blog documented for its in-browser voice assistant: real-time
  capture → on-device speech processing without main-thread jank. Same
  constraint as the rest of this project: it must not interfere with the
  probe meter's 300 ms event cadence.
- **Why the worklet resamples instead of an OfflineAudioContext per chunk**:
  the offline path would render each chunk in a fresh graph (allocation
  churn per chunk, no continuity guarantees), while the worklet keeps one
  stateful `Resampler` for the whole recording and streams chunks over the
  port.
- **The recorder never touches the stream's tracks** — the capture
  (`lib/audio-capture.ts`) owns them. `main.ts` stops the recorder when the
  capture reports `stopped`/`track-ended`, so it cannot record silence on a
  dead stream.
- **Generation-token discipline** (same shape as `lib/audio-capture.ts`,
  SEC-5): `stop()` bumps a token; an in-flight `start()` whose `addModule`
  is still pending detects the bump after setup and discards its fresh graph
  (closes the context, clears the port handler) instead of becoming a live
  recording. Unit-tested with a deferred `addModule`.

## Integration contract

Message kinds (guards in `lib/audio-probe.ts`; all travel the existing
background ↔ offscreen channels — the background's orchestrator already
forwards/echoes them, the STT flow just reads the events):

| direction | kind | payload |
|---|---|---|
| background → offscreen | `stt:start-recording` | `chunkSec: number` — the chunk length the STT flow wants |
| background → offscreen | `stt:stop-recording` | — |
| offscreen → background | `offscreen-event` / `stt:ready` | `chunkSec`, `sampleRate` (= 16000) |
| offscreen → background | `offscreen-event` / `stt:stopped` | — |
| offscreen → background | `offscreen-event` / `stt:error` | `error: string` |

`stt:ready` fires only when the recorder actually started; `stt:stopped`
fires on explicit stop and when the capture dies under it. `stt:start-recording`
with no active capture reports `stt:error: 'no active capture'` without
starting.

The recorder itself is pull-based: the future STT flow calls
`flushChunk(chunkSec)` on the recorder instance in the offscreen document.
`chunkSec` is carried through the messages so the flow's chunk size is
visible in the protocol and echoed in `stt:ready`.

## What remains for the STT build

1. Chunk transport: get 16 kHz chunks out of the offscreen document — the
   Whisper pipeline lives there too (benchmark verdict, CSP and 64 MiB
   messaging limits: `docs/phase2-whisper-benchmark.md`), so
   `flushChunk` likely feeds the model directly; if background-side ASR is
   ever chosen, chunks cross via `runtime.sendMessage` (64 MiB cap) or a
   shared buffer.
2. The transcription loop: `stt:start-recording` → drain chunks at
   `chunkSec` cadence → `transformers.js` Whisper (`Xenova/whisper-base` q8,
   per the benchmark) → word timestamps → the `'asr-audio'` evidence tier
   (one union member + one `TIER_LABELS` entry + one routing branch).
3. Lifecycle policy: what stops a recording (capture stop is wired; a
   per-recording duration cap and a demand-gate are flow decisions).
4. e2e coverage for the stt messages once the flow exists (the capture
   chain itself stays under `e2e/chromium/offscreen.spec.ts`).
