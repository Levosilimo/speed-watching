import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  // Firefox defaults to MV2 in WXT; this project is MV3-only, so both
  // browser targets build the same manifest shape.
  manifestVersion: 3,
  manifest: {
    name: 'Speed Watcher',
    description: 'WPM-based speed-watching extension',
    version: '0.0.1',
    permissions: ['storage', 'tabCapture', 'offscreen'],
    min_chrome_version: '116',
    browser_specific_settings: {
      gecko: {
        id: 'speed-watcher@levosilimo.dev',
      },
    },
  },
});
