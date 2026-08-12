// ISOLATED-world sibling of entrypoints/content.ts: hosts the chrome-backed
// SettingsStore + OverrideLog + DemandStore that the MAIN-world measurement
// script cannot touch (chrome.* is unavailable in the page world). Answers
// the window CustomEvents defined in lib/messaging.ts straight from
// chrome.storage.local — no service-worker round trip, so the background
// stays the audio probe orchestrator.

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { DemandStore } from '@/lib/demand';
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
  matches: ['*://*.youtube.com/*'],
  main() {
    const settings = new SettingsStore(browser.storage.local);
    const log = new OverrideLog(browser.storage.local);
    const demand = new DemandStore(browser.storage.local);

    window.addEventListener(BRIDGE_REQUEST_EVENT, (event) => {
      const detail = (event as CustomEvent<BridgeRequest & { id: number }>).detail;
      void handleBridgeRequest(detail, { settings, log, demand }).then(
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
