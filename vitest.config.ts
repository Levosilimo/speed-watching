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
    coverage: {
      provider: 'v8',
      // The gate's scope: the rate-math core plus the behavior-bearing
      // stores. Thresholds sit ~5 points below the measured aggregate
      // (96.4/93.9/95.8/96.4, 2026-08-15) so the gate blocks regressions
      // without demanding new tests.
      include: [
        'lib/wpm.ts',
        'lib/tokenizer.ts',
        'lib/captions.ts',
        'lib/languages.ts',
        'lib/recommend.ts',
        'lib/caption-fetch.ts',
        'lib/caption-trigger.ts',
        'lib/transcript.ts',
        'lib/matcher.ts',
        'lib/rate-controller.ts',
        'lib/demand.ts',
        'lib/time-saved.ts',
        'lib/chapters.ts',
        'lib/chapter-scheduler.ts',
        'lib/skip-silence.ts',
        'lib/error-journal.ts',
        'lib/nudge.ts',
        'lib/channel-memory.ts',
        'lib/caption-capture.ts',
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
