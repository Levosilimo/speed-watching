// ISOLATED-world sibling of the measurement scripts (entrypoints/content.ts
// and entrypoints/generic.content.ts): hosts the chrome-backed SettingsStore
// + OverrideLog + DemandStore that MAIN-world scripts cannot touch (chrome.*
// is unavailable in the page world). Answers the window postMessage
// envelopes defined in lib/messaging.ts straight from chrome.storage.local
// — no service-worker round trip, so the background stays the audio probe
// orchestrator.
//
// World tolerance: Firefox has no isolated worlds, so the bridge may share
// the page world with the main script. Correctness never depends on world
// separation — the envelope protocol is symmetric postMessage and both
// sides talk to the same chrome.storage.local instance, so the bridge
// behaves identically whether or not the two scripts share a world (the
// firefox e2e suite exercises the single-world layout).

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { DemandStore } from '@/lib/demand';
import {
  BRIDGE_CHANNEL,
  handleBridgeRequest,
  isBridgeEnvelope,
  type BridgeRequest,
} from '@/lib/messaging';
import { OverrideLog } from '@/lib/override-log';
import { SettingsStore } from '@/lib/settings';

export default defineContentScript({
  // <all_urls> with all_frames: the generic matcher needs the bridge in
  // every frame of every page (embedded players live in cross-origin
  // iframes); the youtube script needs it on watch pages. The bridge is
  // inert unless a main script posts a request envelope.
  matches: ['<all_urls>'],
  allFrames: true,
  main() {
    const settings = new SettingsStore(browser.storage.local);
    const log = new OverrideLog(browser.storage.local);
    const demand = new DemandStore(browser.storage.local);

    window.addEventListener('message', (event) => {
      const envelope = event.data;
      if (!isBridgeEnvelope(envelope) || envelope.direction !== 'request') return;
      const detail = envelope.payload as BridgeRequest & { id: number };
      void handleBridgeRequest(detail, { settings, log, demand }).then(
        (result) => {
          window.postMessage(
            {
              channel: BRIDGE_CHANNEL,
              direction: 'response',
              payload: { id: detail.id, ok: true, result },
            },
            '*',
          );
        },
        (error: unknown) => {
          window.postMessage(
            {
              channel: BRIDGE_CHANNEL,
              direction: 'response',
              payload: { id: detail.id, ok: false, error: String(error) },
            },
            '*',
          );
        },
      );
    });
  },
});
