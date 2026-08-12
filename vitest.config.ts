import { defineConfig } from 'vitest/config';

export default defineConfig({
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
