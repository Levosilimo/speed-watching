import { errorMessage, rmsLevel } from './audio-probe';

export const LEVEL_INTERVAL_MS = 300;

interface TabAudioConstraints extends MediaTrackConstraints {
  mandatory: { chromeMediaSource: 'tab'; chromeMediaSourceId: string };
}

interface AudioCaptureEnv {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  AudioContextCtor: typeof AudioContext;
}

interface AudioCaptureHooks {
  onStarted(): void;
  onLevel(level: number): void;
  onTrackEnded(): void;
  onStopped(): void;
  onError(message: string): void;
}

/** getUserMedia for the tab stream; null on failure after hooks.onError. */
async function acquireStream(
  env: AudioCaptureEnv,
  streamId: string,
  hooks: AudioCaptureHooks,
): Promise<MediaStream | null> {
  const audio: TabAudioConstraints = {
    mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
  };
  try {
    return await env.getUserMedia({ video: false, audio });
  } catch (error) {
    hooks.onError(errorMessage(error));
    return null;
  }
}

/** AudioContext + analyser meter over the stream: samples every
 * LEVEL_INTERVAL_MS into hooks.onLevel and watches the tracks for 'ended'.
 * No destination: the analyser keeps the capture alive without re-playing
 * the tab's audio, which would be audible and could feed back. */
function buildMeter(
  env: AudioCaptureEnv,
  stream: MediaStream,
  hooks: AudioCaptureHooks,
  onTrackEnded: () => void,
): { context: AudioContext; timer: ReturnType<typeof setInterval> } {
  const context = new env.AudioContextCtor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', onTrackEnded);
  }
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    hooks.onLevel(rmsLevel(samples));
  }, LEVEL_INTERVAL_MS);
  return { context, timer };
}

export function createAudioCapture(env: AudioCaptureEnv, hooks: AudioCaptureHooks) {
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  // SEC-5: every stop() bumps the generation, so an in-flight start (its
  // getUserMedia still pending) can detect that a stop landed and must not
  // become a live capture (tab-switch race: previously the capture survived
  // the stop because stop() tore down nothing it could see).
  let generation = 0;

  async function start(streamId: string): Promise<void> {
    const startedAt = generation;
    await teardownActive();
    const acquired = await acquireStream(env, streamId, hooks);
    if (acquired === null) return;
    if (startedAt !== generation) {
      // A stop() landed while the stream was being acquired: discard it so
      // the capture cannot outlive the stop.
      for (const track of acquired.getAudioTracks()) track.stop();
      return;
    }
    stream = acquired;
    const meter = buildMeter(env, stream, hooks, handleTrackEnded);
    audioContext = meter.context;
    meterTimer = meter.timer;
    hooks.onStarted();
  }

  async function stop(): Promise<void> {
    generation += 1;
    await teardownActive();
  }

  async function handleTrackEnded(): Promise<void> {
    await teardown();
    hooks.onTrackEnded();
  }

  /** Tears down a live capture and reports stopped. start() uses it as the
   * restart cleanup (a restart must not invalidate its own token); stop()
   * calls it after bumping the generation. */
  async function teardownActive(): Promise<void> {
    const wasActive = stream !== null || audioContext !== null;
    await teardown();
    if (wasActive) hooks.onStopped();
  }

  async function teardown(): Promise<void> {
    if (meterTimer !== null) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
    if (audioContext) {
      await audioContext.close();
      audioContext = null;
    }
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.removeEventListener('ended', handleTrackEnded);
        track.stop();
      }
      stream = null;
    }
  }

  return { start, stop, getStream: () => stream };
}
