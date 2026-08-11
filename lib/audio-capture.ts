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

export function createAudioCapture(env: AudioCaptureEnv, hooks: AudioCaptureHooks) {
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let meterTimer: ReturnType<typeof setInterval> | null = null;

  async function start(streamId: string): Promise<void> {
    await stop();
    let acquired: MediaStream;
    try {
      const audio: TabAudioConstraints = {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      };
      acquired = await env.getUserMedia({ video: false, audio });
    } catch (error) {
      hooks.onError(errorMessage(error));
      return;
    }
    stream = acquired;
    audioContext = new env.AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    // No destination: the analyser keeps the capture alive without re-playing
    // the tab's audio, which would be audible and could feed back.
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', handleTrackEnded);
    }
    meterTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      hooks.onLevel(rmsLevel(samples));
    }, LEVEL_INTERVAL_MS);
    hooks.onStarted();
  }

  async function stop(): Promise<void> {
    const wasActive = stream !== null || audioContext !== null;
    await teardown();
    if (wasActive) hooks.onStopped();
  }

  async function handleTrackEnded(): Promise<void> {
    await teardown();
    hooks.onTrackEnded();
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

  return { start, stop };
}
