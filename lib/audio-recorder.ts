// 16 kHz mono recorder over a MediaStream (the offscreen document's
// tab-capture stream). A default AudioContext runs at the device rate;
// the resampler worklet (lib/recorder-worklet.ts) decimates it to
// TARGET_RATE and posts 16 kHz mono chunks over its port into the ring
// buffer here. No chrome imports — safe to import from any context and
// from vitest.
import { errorMessage } from './audio-probe';
import { TARGET_RATE } from './resampler';

// Processor name shared with lib/recorder-worklet.ts (registered there).
export const RECORDER_PROCESSOR = 'speed-watcher-resampler';

// Ring-buffer cap: protects the offscreen document from unbounded growth
// if the future STT consumer stalls. 60 s at 16 kHz f32 is ~3.8 MiB.
export const RECORDER_MAX_SEC = 60;

// Fixed-length f32 ring of 16 kHz mono samples. Push appends worklet
// chunks; flush drains up to `seconds`, dropping the oldest samples first
// when the cap is exceeded.
class RingBuffer {
  private readonly chunks: Float32Array[] = [];
  private total = 0;
  private readonly maxSamples: number;

  constructor(maxSec: number) {
    this.maxSamples = maxSec * TARGET_RATE;
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.chunks.push(samples);
    this.total += samples.length;
    while (this.total > this.maxSamples && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped === undefined) break;
      this.total -= dropped.length;
    }
  }

  flush(seconds: number): Float32Array {
    const take = Math.min(Math.round(seconds * TARGET_RATE), this.total);
    if (take === 0) return new Float32Array(0);
    const out = new Float32Array(take);
    let written = 0;
    while (written < take) {
      const head = this.chunks.shift();
      if (head === undefined) break; // total > 0 guarantees a non-empty ring
      const part = Math.min(head.length, take - written);
      out.set(head.subarray(0, part), written);
      written += part;
      if (part < head.length) this.chunks.unshift(head.subarray(part));
    }
    this.total -= take;
    return out;
  }

  get bufferedSec(): number {
    return this.total / TARGET_RATE;
  }

  clear(): void {
    this.chunks.length = 0;
    this.total = 0;
  }
}

interface AudioRecorderEnv {
  AudioContextCtor: typeof AudioContext;
  AudioWorkletNodeCtor: typeof AudioWorkletNode;
  workletUrl: string;
}

interface AudioRecorderHooks {
  onStarted(): void;
  onStopped(): void;
  onError(message: string): void;
}

export interface AudioRecorderState {
  recording: boolean;
  bufferedSec: number;
}

/** Tears down a graph that never became live (a stop landed during setup). */
async function discardGraph(
  context: AudioContext,
  node: AudioWorkletNode,
  source: MediaStreamAudioSourceNode,
): Promise<void> {
  node.port.onmessage = null;
  node.disconnect();
  source.disconnect();
  await context.close();
}

/** Builds the resampler graph over the stream: worklet module, node with
 * forced stereo input, source→node connection. Throws on setup failure. */
async function buildGraph(
  env: AudioRecorderEnv,
  stream: MediaStream,
): Promise<{ context: AudioContext; node: AudioWorkletNode; source: MediaStreamAudioSourceNode }> {
  const context = new env.AudioContextCtor();
  await context.audioWorklet.addModule(env.workletUrl);
  const node = new env.AudioWorkletNodeCtor(context, RECORDER_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    // 'explicit' + 2: the worklet always sees stereo input (mono
    // sources are up-mixed by duplication), so the processor only
    // handles the stereo case.
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  const source = context.createMediaStreamSource(stream);
  source.connect(node);
  return { context, node, source };
}

/** Wires the worklet port: pushes posted Float32Array chunks into the ring
 * and starts the port. */
function wireWorklet(node: AudioWorkletNode, ring: RingBuffer): void {
  node.port.onmessage = (event: MessageEvent) => {
    // The worklet posts only Float32Arrays; anything else is not ours.
    if (event.data instanceof Float32Array) ring.push(event.data);
  };
  node.port.start();
}

export function createAudioRecorder(env: AudioRecorderEnv, hooks: AudioRecorderHooks) {
  // Same stop-race discipline as lib/audio-capture.ts (SEC-5): every stop()
  // bumps the generation, so an in-flight start whose async setup is still
  // pending can detect that a stop landed and must not become a live
  // recording.
  let generation = 0;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let recording = false;
  const ring = new RingBuffer(RECORDER_MAX_SEC);

  async function start(stream: MediaStream): Promise<void> {
    const startedAt = generation;
    await teardownActive();
    // A fresh recording starts with an empty ring; a stale one must not
    // bleed into the next chunk stream.
    ring.clear();
    try {
      const { context, node, source } = await buildGraph(env, stream);
      wireWorklet(node, ring);
      if (startedAt !== generation) {
        // A stop() landed during setup: discard the fresh graph so the
        // recorder cannot outlive the stop (tab-switch race).
        await discardGraph(context, node, source);
        return;
      }
      audioContext = context;
      workletNode = node;
      sourceNode = source;
      recording = true;
      hooks.onStarted();
    } catch (error) {
      hooks.onError(errorMessage(error));
    }
  }

  async function stop(): Promise<void> {
    generation += 1;
    await teardownActive();
  }

  /** Drains up to `seconds` of 16 kHz mono audio from the ring (fewer when
   * less is buffered). The returned buffer is detached from the ring. */
  function flushChunk(seconds: number): Float32Array {
    return ring.flush(seconds);
  }

  async function teardownActive(): Promise<void> {
    const wasActive = recording;
    await teardown();
    if (wasActive) hooks.onStopped();
  }

  async function teardown(): Promise<void> {
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
      workletNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (audioContext) {
      await audioContext.close();
      audioContext = null;
    }
    recording = false;
  }

  function getState(): AudioRecorderState {
    return { recording, bufferedSec: ring.bufferedSec };
  }

  return { start, stop, flushChunk, getState };
}
