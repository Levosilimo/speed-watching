import { beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { chromeMock } from './chrome-mock';

// Bitwarden pattern: expose the chrome mock as a global so modules that wrap
// `globalThis.chrome` at import time (wxt/browser) bind to the mock.
Object.assign(globalThis, { chrome: chromeMock });

// fakeBrowser's in-memory storage and listeners persist across tests
// otherwise; the storage tests (mockStorage, the wrapped chromeMock
// defaults) expect a fresh store per test.
beforeEach(() => {
  fakeBrowser.reset();
});
