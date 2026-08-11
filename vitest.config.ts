import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // E2E specs live under e2e/ and run under Playwright, not vitest.
    include: ['tests/**/*.test.ts'],
  },
});
