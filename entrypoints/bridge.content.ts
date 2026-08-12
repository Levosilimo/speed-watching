// ISOLATED-world sibling of the measurement scripts (entrypoints/content.ts
// and entrypoints/generic.content.ts): hosts the chrome-backed SettingsStore
// + OverrideLog that MAIN-world scripts cannot touch (chrome.* is
// unavailable in the page world). Answers the window postMessage envelopes
// defined in lib/messaging.ts straight from chrome.storage.local — no
// service-worker round trip. Demand increments are the exception: they are
// forwarded to the background, the single writer (lib-11#3), so per-frame
// stores never interleave get→set pairs.
//
// World tolerance: Firefox has no isolated worlds, so the bridge may share
// the page world with the main script. Correctness never depends on world
// separation — the envelope protocol is symmetric postMessage and both
// sides talk to the same chrome.storage.local instance, so the bridge
// behaves identically whether or not the two scripts share a world (the
// firefox e2e suite exercises the single-world layout).

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createBridgeListener } from '@/lib/messaging';
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

    window.addEventListener(
      'message',
      createBridgeListener(
        {
          settings,
          log,
          forwardDemand: (contentType) =>
            browser.runtime.sendMessage({ type: 'demand:increment', contentType }),
        },
        window,
      ),
    );
  },
});
