import { browser } from 'wxt/browser';
import { createAudioCapture } from '../../lib/audio-capture';
import { createAudioRecorder } from '../../lib/audio-recorder';
import { isOffscreenMessage, probeWasmSupport } from '../../lib/audio-probe';
import type { OffscreenEvent } from '../../lib/audio-probe';
import { TARGET_RATE } from '../../lib/resampler';
import workletUrl from '../../lib/recorder-worklet.ts?worker&url';

const sendEvent = (event: OffscreenEvent): void => {
  void browser.runtime.sendMessage(event).catch(() => {
    // Events sent during background cold start are dropped; the options page
    // re-syncs state on its next poll.
  });
};

// Chunk length the future STT flow wants, echoed back in 'stt:ready'. Set
// by 'stt:start-recording' before the recorder starts, so the started event
// can report it.
let sttChunkSec = 0;

const recorder = createAudioRecorder(
  {
    AudioContextCtor: AudioContext,
    AudioWorkletNodeCtor: AudioWorkletNode,
    workletUrl,
  },
  {
    onStarted: () =>
      sendEvent({
        kind: 'offscreen-event',
        event: 'stt:ready',
        chunkSec: sttChunkSec,
        sampleRate: TARGET_RATE,
      }),
    onStopped: () => sendEvent({ kind: 'offscreen-event', event: 'stt:stopped' }),
    onError: (error) => sendEvent({ kind: 'offscreen-event', event: 'stt:error', error }),
  },
);

const capture = createAudioCapture(
  {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    AudioContextCtor: AudioContext,
  },
  {
    onStarted: () => sendEvent({ kind: 'offscreen-event', event: 'started' }),
    onLevel: (level) => sendEvent({ kind: 'offscreen-event', event: 'level', level }),
    onTrackEnded: () => {
      sendEvent({ kind: 'offscreen-event', event: 'track-ended' });
      // The captured stream is gone; a recorder on it would record silence.
      void recorder.stop();
    },
    onStopped: () => {
      sendEvent({ kind: 'offscreen-event', event: 'stopped' });
      void recorder.stop();
    },
    onError: (error) => sendEvent({ kind: 'offscreen-event', event: 'error', error }),
  },
);

async function startSttRecording(): Promise<void> {
  const stream = capture.getStream();
  if (stream === null) {
    sendEvent({ kind: 'offscreen-event', event: 'stt:error', error: 'no active capture' });
    return;
  }
  await recorder.start(stream);
}

browser.runtime.onMessage.addListener(
  (message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    if (!isOffscreenMessage(message)) return false;
    switch (message.kind) {
      case 'offscreen-start':
        void capture.start(message.streamId).then(() => sendResponse({ received: true }));
        return true;
      case 'offscreen-stop':
        void capture.stop().then(() => sendResponse({ received: true }));
        return true;
      case 'offscreen-wasm-check':
        void probeWasmSupport().then((wasm) => {
          sendEvent({ kind: 'offscreen-event', event: 'wasm-check', wasm });
          sendResponse({ received: true });
        });
        return true;
      case 'stt:start-recording':
        sttChunkSec = message.chunkSec;
        void startSttRecording().then(() => sendResponse({ received: true }));
        return true;
      case 'stt:stop-recording':
        void recorder.stop().then(() => sendResponse({ received: true }));
        return true;
    }
  },
);
