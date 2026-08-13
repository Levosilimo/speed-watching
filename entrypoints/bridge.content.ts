// ISOLATED-world sibling of the measurement scripts (entrypoints/content.ts
// and entrypoints/generic.content.ts): hosts the chrome-backed SettingsStore
// + OverrideLog + ChannelMemory that MAIN-world scripts cannot touch
// (chrome.* is unavailable in the page world). Answers the window
// postMessage envelopes defined in lib/messaging.ts straight from
// chrome.storage.local — no service-worker round trip. Demand increments
// are the exception: they are forwarded to the background, the single
// writer (lib-11#3), so per-frame stores never interleave get→set pairs.
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
    const channels = new ChannelMemory(browser.storage.local);

    window.addEventListener(
      'message',
      createBridgeListener(
        {
          settings,
          log,
          channels,
          forwardDemand: (contentType) =>
            browser.runtime.sendMessage({ type: 'demand:increment', contentType }),
        },
        window,
      ),
    );
    // Keyboard shortcuts (chrome.commands) arrive here, not in the MAIN
    // world: chrome.* is unavailable there (file header). The main script
    // on youtube watch pages picks the relayed envelope off the window.
    // One-way relay: no response, so return false instead of keeping the
    // message channel open for a response nobody sends.
    browser.runtime.onMessage.addListener((message: unknown): boolean => {
      if (!isShortcutMessage(message)) return false;
      window.postMessage({ channel: SHORTCUT_CHANNEL, message }, '*');
      return false;
    });
  },
});
