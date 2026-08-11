import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioCapture, LEVEL_INTERVAL_MS } from '../lib/audio-capture';

function makeEnv() {
  const analyser = {
    fftSize: 2048,
    getFloatTimeDomainData: vi.fn(),
  };
  const source = { connect: vi.fn() };
  const context = {
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
    close: vi.fn(async () => {}),
  };
  const track = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  };
  const stream = { getAudioTracks: vi.fn(() => [track]) };
  const env = {
    getUserMedia: vi.fn(async () => stream as unknown as MediaStream),
    AudioContextCtor: vi.fn(() => context),
  };
  const hooks = {
    onStarted: vi.fn(),
    onLevel: vi.fn(),
    onTrackEnded: vi.fn(),
    onStopped: vi.fn(),
    onError: vi.fn(),
  };
  return { env, analyser, source, context, track, stream, hooks };
}

type Env = ReturnType<typeof makeEnv>;

function captureFrom(env: Env['env'], hooks: Env['hooks']) {
  return createAudioCapture(
    {
      getUserMedia: env.getUserMedia,
      AudioContextCtor: env.AudioContextCtor as unknown as typeof AudioContext,
    },
    hooks,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAudioCapture', () => {
  it('requests tab audio with the stream id and connects the graph', async () => {
    const { env, analyser, source, hooks } = makeEnv();
    const capture = captureFrom(env, hooks);
    await capture.start('sid-1');
    expect(env.getUserMedia).toHaveBeenCalledWith({
      video: false,
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'sid-1' } },
    });
    expect(analyser.fftSize).toBe(2048);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(hooks.onStarted).toHaveBeenCalledOnce();
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it('reports rms level on the meter interval', async () => {
    const { env, analyser, hooks } = makeEnv();
    analyser.getFloatTimeDomainData.mockImplementation((samples: Float32Array) => samples.fill(0.5));
    const capture = captureFrom(env, hooks);
    await capture.start('sid-1');
    vi.advanceTimersByTime(LEVEL_INTERVAL_MS);
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalled();
    expect(hooks.onLevel).toHaveBeenCalledWith(0.5);
  });

  it('reports the error when getUserMedia rejects', async () => {
    const { env, hooks } = makeEnv();
    env.getUserMedia.mockRejectedValue(new DOMException('permission denied', 'NotAllowedError'));
    const capture = captureFrom(env, hooks);
    await capture.start('sid-1');
    expect(hooks.onError).toHaveBeenCalledWith('permission denied');
    expect(hooks.onStarted).not.toHaveBeenCalled();
  });

  it('stop tears down tracks, the context, and the meter', async () => {
    const { env, context, track, hooks } = makeEnv();
    const capture = captureFrom(env, hooks);
    await capture.start('sid-1');
    await capture.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(context.close).toHaveBeenCalledOnce();
    expect(hooks.onStopped).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(LEVEL_INTERVAL_MS * 3);
    expect(hooks.onLevel).not.toHaveBeenCalled();
  });

  it('track ended tears down and reports track-ended, not stopped', async () => {
    const { env, context, track, hooks } = makeEnv();
    const capture = captureFrom(env, hooks);
    await capture.start('sid-1');
    const endedHandler = track.addEventListener.mock.calls.find(([event]) => event === 'ended')?.[1] as () => Promise<void>;
    await endedHandler();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(hooks.onTrackEnded).toHaveBeenCalledOnce();
    expect(hooks.onStopped).not.toHaveBeenCalled();
  });

  it('restart stops the previous capture before acquiring a new stream', async () => {
    const { env, track, hooks } = makeEnv();
    const capture = captureFrom(env, hooks);
    await capture.start('sid-1');
    await capture.start('sid-2');
    expect(env.getUserMedia).toHaveBeenCalledTimes(2);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(hooks.onStarted).toHaveBeenCalledTimes(2);
  });
});
