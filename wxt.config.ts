import { defineConfig } from 'wxt';

// Match-pattern scope (Phase 3, documented in docs/phase0-generic-probe.md
// and docs/amo-listing.md):
//   - The generic matcher (entrypoints/generic.content.ts) targets any page
//     that may carry a <video> — a curated site list would miss the native
//     elements the probe measured working (native-baseline) and any
//     unlisted host. `<all_urls>` with all_frames is the only pattern that
//     reaches the cross-origin embed frames where every embedded player
//     lives (probe: all embedded players are in cross-origin iframes).
//   - host_permissions names the measured embed/target origins explicitly.
//     The `<all_urls>` content-script match already grants host access, so
//     these add no functional scope — they make the caption-harvest fetch
//     rights explicit and reviewable for CWS/AMO (vimeo.com covers
//     player.vimeo.com; twitch.tv covers player.twitch.tv).
//   - The YouTube script stays on *://*.youtube.com/* (unchanged); the
//     generic script bails on youtube.com /watch pages so the two never
//     both drive a watch page. youtube-nocookie.com embeds are NOT covered
//     by the youtube match, so the generic script handles them.
export default defineConfig({
  // Firefox defaults to MV2 in WXT; this project is MV3-only, so both
  // browser targets build the same manifest shape.
  manifestVersion: 3,
  manifest: {
    name: 'Speed Watcher',
    description: 'WPM-based speed-watching extension',
    version: '0.0.1',
    permissions: ['storage', 'tabCapture', 'offscreen'],
    host_permissions: [
      '*://*.vimeo.com/*',
      '*://*.twitch.tv/*',
      '*://*.coursera.org/*',
      '*://*.edx.org/*',
      '*://*.youtube-nocookie.com/*',
    ],
    min_chrome_version: '116',
    browser_specific_settings: {
      gecko: {
        id: 'speed-watcher@levosilimo.dev',
        // strict_min_version 128: runtime.getContexts (capture-orchestrator)
        // and content-script world: 'MAIN' (youtube script) both landed in
        // Firefox 128. Older versions would silently run the youtube script
        // in the content-script sandbox — working, but unmeasured.
        strict_min_version: '128.0',
      },
    },
  },
});
