import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Same '@' → project root alias WXT generates for builds (.wxt/tsconfig.json).
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  // Same build-time define as wxt.config.ts: tests run the production path
  // (entrypoints/content.ts's e2e hooks are compiled out).
  define: { __E2E__: 'false' },
  test: {
    environment: 'node',
    environmentOptions: {
      // happy-dom would fetch the options page's stylesheet from a dead
      // http origin on every test import; no test asserts CSS, so skip it.
      happyDOM: {
        settings: { disableCSSFileLoading: true },
      },
    },
    setupFiles: ['./tests/setup.ts'],
    // E2E specs live under e2e/ and run under Playwright, not vitest.
    include: ['tests/**/*.test.ts'],
  },
});
