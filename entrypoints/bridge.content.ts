// ISOLATED-world sibling of the measurement scripts (entrypoints/content.ts
// and entrypoints/generic.content.ts): hosts the chrome-backed SettingsStore
// + OverrideLog that MAIN-world scripts cannot touch (chrome.* is unavailable
// in the page world). Answers the window CustomEvents defined in
// lib/messaging.ts straight from chrome.storage.local — no service-worker
// round trip, so the background stays the audio probe orchestrator.
//
// World tolerance: Firefox has no isolated worlds, so the bridge may share
// the page world with the main script. Correctness never depends on world
// separation — the request/response protocol is symmetric window events and
// both sides talk to the same chrome.storage.local instance, so the bridge
// behaves identically whether or not the two scripts share a world (the
// firefox e2e suite exercises the single-world layout).

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  BRIDGE_REQUEST_EVENT,
  BRIDGE_RESPONSE_EVENT,
  handleBridgeRequest,
  type BridgeErrorResponse,
  type BridgeRequest,
  type BridgeResponse,
} from '@/lib/messaging';
import { OverrideLog } from '@/lib/override-log';
import { SettingsStore } from '@/lib/settings';

export default defineContentScript({
  // <all_urls> with all_frames: the generic matcher needs the bridge in
  // every frame of every page (embedded players live in cross-origin
  // iframes); the youtube script needs it on watch pages. The bridge is
  // inert unless a main script dispatches a request event.
  matches: ['<all_urls>'],
  allFrames: true,
  main() {
    const settings = new SettingsStore(browser.storage.local);
    const log = new OverrideLog(browser.storage.local);

    window.addEventListener(BRIDGE_REQUEST_EVENT, (event) => {
      const detail = (event as CustomEvent<BridgeRequest & { id: number }>).detail;
      void handleBridgeRequest(detail, { settings, log }).then(
        (result) => {
          window.dispatchEvent(
            new CustomEvent<BridgeResponse>(BRIDGE_RESPONSE_EVENT, {
              detail: { id: detail.id, ok: true, result },
            }),
          );
        },
        (error: unknown) => {
          window.dispatchEvent(
            new CustomEvent<BridgeErrorResponse>(BRIDGE_RESPONSE_EVENT, {
              detail: { id: detail.id, ok: false, error: String(error) },
            }),
          );
        },
      );
    });
  },
});
