// ISOLATED-world sibling of the measurement scripts (entrypoints/content.ts
// and entrypoints/generic.content.ts): hosts the chrome-backed SettingsStore
// + OverrideLog + ChannelMemory that MAIN-world scripts cannot touch
// (chrome.* is unavailable in the page world). Answers the window
// postMessage envelopes defined in lib/messaging.ts straight from
// chrome.storage.local — no service-worker round trip. Demand increments,
// the nudge messages, and time-saved accrues are the exceptions: they are
// forwarded to the
// background, the single writer (lib-11#3), so per-frame stores never
// interleave get→set pairs.
//
// World tolerance: Firefox has no isolated worlds, so the bridge may share
// the page world with the main script. Correctness never depends on world
// separation — the envelope protocol is symmetric postMessage and both
// sides talk to the same chrome.storage.local instance, so the bridge
// behaves identically whether or not the two scripts share a world (the
// firefox e2e suite exercises the single-world layout).

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { ChannelMemory } from '@/lib/channel-memory';
import { createBridgeListener, isShortcutMessage, SHORTCUT_CHANNEL } from '@/lib/messaging';
import {
  isWpmEnvelope,
  isWpmGetRequest,
  isWpmGetResponse,
  WPM_CHANNEL,
  WPM_RELAY_TIMEOUT_MS,
  type WpmGetRequest,
} from '@/lib/wpm-protocol';
import { OverrideLog } from '@/lib/override-log';
import { SettingsStore } from '@/lib/settings';
import { SkipSilenceStore } from '@/lib/skip-silence';

export default defineContentScript({
  // <all_urls> with all_frames: the generic matcher needs the bridge in
  // every frame of every page (embedded players live in cross-origin
  // iframes); the youtube script needs it on watch pages. The bridge is
  // inert unless a main script posts a request envelope.
  matches: ['<all_urls>'],
  allFrames: true,
  main() {
    const settings = new SettingsStore(browser.storage.local);
    const skip = new SkipSilenceStore(browser.storage.local);
    const log = new OverrideLog(browser.storage.local);
    const channels = new ChannelMemory(browser.storage.local);

    window.addEventListener(
      'message',
      createBridgeListener(
        {
          settings,
          skip,
          log,
          channels,
          forwardDemand: (contentType) =>
            browser.runtime.sendMessage({ type: 'demand:increment', contentType }),
          forwardJournalAppend: (entry) =>
            browser.runtime.sendMessage({ type: 'journal:append', ...entry }),
          forwardNudgeRecordApply: (multiplier) =>
            browser.runtime.sendMessage({ type: 'nudge:recordApply', multiplier }),
          forwardNudgeDismiss: (forever) =>
            browser.runtime.sendMessage({ type: 'nudge:dismiss', forever }),
          forwardAccrue: (deltaSec, multiplier) =>
            browser.runtime.sendMessage({ type: 'timeSaved:accrue', deltaSec, multiplier }),
        },
        window,
      ),
    );
    // Keyboard shortcuts (chrome.commands) arrive here, not in the MAIN
    // world: chrome.* is unavailable there (file header). The main script
    // on youtube watch pages picks the relayed envelope off the window.
    // One-way relay: no response, so return false instead of keeping the
    // message channel open for a response nobody sends. wpm:get is the
    // round-trip exception: the MAIN-world answer comes back on the same
    // window channel and is forwarded to the background's sendResponse.
    browser.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse): boolean => {
        if (isWpmGetRequest(message)) {
          relayWpmGet(message, sendResponse);
          return true;
        }
        if (!isShortcutMessage(message)) return false;
        window.postMessage({ channel: SHORTCUT_CHANNEL, message }, '*');
        return false;
      },
    );
  },
});

/** wpm:get round trip (docs/provider-integration.md): post the request
 * envelope, wait for the MAIN-world answer, forward it to sendResponse.
 * A timeout means the page has no content script (or no measurement) —
 * the answer is then no-active-video. */
function relayWpmGet(request: WpmGetRequest, sendResponse: (response?: unknown) => void): void {
  window.postMessage({ channel: WPM_CHANNEL, message: request }, '*');
  const timer = setTimeout(() => {
    window.removeEventListener('message', onEnvelope);
    sendResponse({ ok: false, error: 'no-active-video' });
  }, WPM_RELAY_TIMEOUT_MS);
  function onEnvelope(event: MessageEvent): void {
    const envelope = event.data;
    // SEC: the page world can post arbitrary JSON; validate both the
    // channel and the response shape before forwarding to the background.
    // Same-frame only (mirror of createBridgeClient's source guard): a
    // cross-frame forgery with a valid shape is dropped too.
    if (event.source !== window) return;
    if (!isWpmEnvelope(envelope) || !isWpmGetResponse(envelope.message)) return;
    clearTimeout(timer);
    window.removeEventListener('message', onEnvelope);
    sendResponse(envelope.message);
  }
  window.addEventListener('message', onEnvelope);
}
