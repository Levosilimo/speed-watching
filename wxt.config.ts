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
    // The action entrypoint is the tabCapture invocation path: clicking the
    // toolbar icon is the user gesture that lets getMediaStreamId succeed
    // (lib-7 verdict, docs/phase0-offscreen-audio.md). NO default_popup:
    // chrome.action.onClicked never fires when a popup consumes the click, and
    // without it the capture flow would be unreachable (the options-page Test
    // button does not invoke — runtime messages are not among the four
    // invocation gestures). action is not a permission; the permission list
    // below stays unchanged.
    action: {
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
      default_title: 'Speed Watcher',
    },
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
  // vtt.js's lib files end `}(this));` — in node, top-level `this` is
  // module.exports, which is how the parser exports itself; under strict
  // ESM the commonjs transform turns `this` into void 0 and the module
  // exports nothing (import throws / WebVTT undefined). Rewrite the call to
  // module.exports before the commonjs transform sees the module.
  vite: () => ({
    plugins: [
      {
        name: 'vttjs-this-exports',
        enforce: 'pre',
        transform(code, id) {
          if (!id.includes('node_modules/vtt.js/')) return undefined;
          return code.replaceAll('}(this));', '}(module.exports));');
        },
      },
    ],
  }),
});
