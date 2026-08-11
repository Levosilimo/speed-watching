import { browser } from 'wxt/browser';
import { createAudioCapture } from '../../lib/audio-capture';
import { isOffscreenMessage, probeWasmSupport } from '../../lib/audio-probe';
import type { OffscreenEvent } from '../../lib/audio-probe';

const sendEvent = (event: OffscreenEvent): void => {
  void browser.runtime.sendMessage(event).catch(() => {
    // Events sent during background cold start are dropped; the options page
    // re-syncs state on its next poll.
  });
};

const capture = createAudioCapture(
  {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    AudioContextCtor: AudioContext,
  },
  {
    onStarted: () => sendEvent({ kind: 'offscreen-event', event: 'started' }),
    onLevel: (level) => sendEvent({ kind: 'offscreen-event', event: 'level', level }),
    onTrackEnded: () => sendEvent({ kind: 'offscreen-event', event: 'track-ended' }),
    onStopped: () => sendEvent({ kind: 'offscreen-event', event: 'stopped' }),
    onError: (error) => sendEvent({ kind: 'offscreen-event', event: 'error', error }),
  },
);

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
    }
  },
);
