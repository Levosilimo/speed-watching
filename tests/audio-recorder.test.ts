import { describe, expect, it, vi } from 'vitest';
import { createAudioRecorder, RECORDER_MAX_SEC, RECORDER_PROCESSOR } from '../lib/audio-recorder';
import { isOffscreenEvent, isOffscreenMessage } from '../lib/audio-probe';
import { TARGET_RATE } from '../lib/resampler';

// Minimal AudioContext/AudioWorkletNode mock, same shape as the chrome mock
// in tests/chrome-mock.ts: the recorder's env is injected, and tests drive
// the worklet's port.onmessage handler to simulate resampled chunks.
function makeEnv() {
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    start: vi.fn(),
  };
  const node = { port, connect: vi.fn(), disconnect: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(() => source),
    close: vi.fn(async () => {}),
  };
  const env = {
    AudioContextCtor: vi.fn(() => context),
    AudioWorkletNodeCtor: vi.fn(() => node),
    workletUrl: 'blob:mock-worklet',
  };
  const hooks = { onStarted: vi.fn(), onStopped: vi.fn(), onError: vi.fn() };
  const stream = {} as MediaStream;
  return { env, port, node, source, context, hooks, stream };
}

type Env = ReturnType<typeof makeEnv>;

function recorderFrom(env: Env['env'], hooks: Env['hooks']) {
  return createAudioRecorder(
    {
      AudioContextCtor: env.AudioContextCtor as unknown as typeof AudioContext,
      AudioWorkletNodeCtor: env.AudioWorkletNodeCtor as unknown as typeof AudioWorkletNode,
      workletUrl: env.workletUrl,
    },
    hooks,
  );
}

function pushSamples(port: Env['port'], count: number): void {
  port.onmessage?.({ data: new Float32Array(count).fill(0.5) } as MessageEvent);
}

describe('createAudioRecorder', () => {
  it('builds the worklet graph at the context rate and starts', async () => {
    const { env, context, node, source, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    expect(env.AudioContextCtor).toHaveBeenCalledOnce();
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith('blob:mock-worklet');
    expect(env.AudioWorkletNodeCtor).toHaveBeenCalledWith(context, RECORDER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    expect(port.start).toHaveBeenCalledOnce();
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(hooks.onStarted).toHaveBeenCalledOnce();
    expect(hooks.onError).not.toHaveBeenCalled();
    expect(recorder.getState()).toEqual({ recording: true, bufferedSec: 0 });
  });

  it('drains exactly chunkSec seconds of 16 kHz samples from the ring', async () => {
    const { env, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    pushSamples(port, TARGET_RATE); // 1 s
    const chunk = recorder.flushChunk(0.25); // 0.25 s = 4000 samples
    expect(chunk).toHaveLength(4000);
    expect(chunk.every((sample) => sample === 0.5)).toBe(true);
    expect(recorder.flushChunk(0.25)).toHaveLength(4000);
    expect(recorder.flushChunk(0.25)).toHaveLength(4000);
    expect(recorder.flushChunk(0.25)).toHaveLength(4000); // 1 s drains as 4 × 0.25 s
    expect(recorder.flushChunk(0.25)).toHaveLength(0);
  });

  it('returns fewer samples when less than chunkSec is buffered, and drains', async () => {
    const { env, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    pushSamples(port, 1024);
    expect(recorder.flushChunk(0.5)).toHaveLength(1024);
    expect(recorder.flushChunk(0.5)).toHaveLength(0);
  });

  it('joins samples across multiple worklet messages', async () => {
    const { env, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    pushSamples(port, 1000);
    pushSamples(port, 1000);
    expect(recorder.flushChunk(0.125)).toHaveLength(2000);
    pushSamples(port, 700);
    expect(recorder.flushChunk(1)).toHaveLength(700);
  });

  it('caps the ring at the max window, dropping the oldest samples', async () => {
    const { env, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    const maxSamples = RECORDER_MAX_SEC * TARGET_RATE;
    // 61 × 1 s: the 61st push drops the oldest 1 s chunk, keeping exactly 60.
    for (let i = 0; i < RECORDER_MAX_SEC + 1; i++) pushSamples(port, TARGET_RATE);
    expect(recorder.flushChunk(RECORDER_MAX_SEC + 10)).toHaveLength(maxSamples);
    expect(recorder.getState().bufferedSec).toBe(0);
  });

  it('stop closes the context, disconnects the graph, and stops reporting', async () => {
    const { env, node, source, context, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    await recorder.stop();
    expect(port.onmessage).toBeNull();
    expect(node.disconnect).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(hooks.onStopped).toHaveBeenCalledOnce();
    expect(recorder.getState()).toEqual({ recording: false, bufferedSec: 0 });
  });

  it('stop during an in-flight start discards the fresh graph (SEC-5 race)', async () => {
    const { env, context, port, hooks, stream } = makeEnv();
    let resolveModule!: () => void;
    context.audioWorklet.addModule.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveModule = resolve;
      }),
    );
    const recorder = recorderFrom(env, hooks);
    const pendingStart = recorder.start(stream);
    await recorder.stop(); // lands while addModule is still pending
    resolveModule();
    await pendingStart;
    expect(hooks.onStarted).not.toHaveBeenCalled();
    expect(hooks.onStopped).not.toHaveBeenCalled();
    expect(port.onmessage).toBeNull();
    expect(context.close).toHaveBeenCalledOnce(); // the discarded context
    expect(recorder.getState().recording).toBe(false);
  });

  it('restart tears down the previous graph and clears the ring', async () => {
    const { env, context, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    pushSamples(port, 1000);
    await recorder.start(stream);
    expect(hooks.onStarted).toHaveBeenCalledTimes(2);
    expect(hooks.onStopped).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(recorder.flushChunk(1)).toHaveLength(0);
  });

  it('reports the error when the worklet module fails to load', async () => {
    const { env, context, hooks, stream } = makeEnv();
    context.audioWorklet.addModule.mockRejectedValue(
      new DOMException('module not found', 'InvalidStateError'),
    );
    const recorder = recorderFrom(env, hooks);
    await recorder.start(stream);
    expect(hooks.onError).toHaveBeenCalledWith('module not found');
    expect(hooks.onStarted).not.toHaveBeenCalled();
    expect(recorder.getState().recording).toBe(false);
  });

  it('tracks buffered seconds in state', async () => {
    const { env, port, hooks, stream } = makeEnv();
    const recorder = recorderFrom(env, hooks);
    expect(recorder.getState()).toEqual({ recording: false, bufferedSec: 0 });
    await recorder.start(stream);
    pushSamples(port, TARGET_RATE);
    expect(recorder.getState().bufferedSec).toBeCloseTo(1, 6);
    await recorder.stop();
    expect(recorder.getState().recording).toBe(false);
  });
});

describe('stt message protocol', () => {
  it('accepts the stt message kinds', () => {
    expect(isOffscreenMessage({ kind: 'stt:start-recording', chunkSec: 5 })).toBe(true);
    expect(isOffscreenMessage({ kind: 'stt:start-recording' })).toBe(false);
    expect(isOffscreenMessage({ kind: 'stt:stop-recording' })).toBe(true);
    expect(isOffscreenMessage({ kind: 'probe-start' })).toBe(false);
  });

  it('accepts the stt event kinds', () => {
    expect(
      isOffscreenEvent({
        kind: 'offscreen-event',
        event: 'stt:ready',
        chunkSec: 5,
        sampleRate: TARGET_RATE,
      }),
    ).toBe(true);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'stt:ready', chunkSec: 5 })).toBe(false);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'stt:stopped' })).toBe(true);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'stt:error', error: 'x' })).toBe(true);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'stt:error' })).toBe(false);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'started' })).toBe(true);
  });
});
