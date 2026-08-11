import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Speed Watcher',
    description: 'WPM-based speed-watching extension',
    version: '0.0.1',
    permissions: ['storage', 'tabCapture'],
    min_chrome_version: '116',
  },
});
