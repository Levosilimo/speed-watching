import { chromeMock } from './chrome-mock';

// Bitwarden pattern: expose the chrome mock as a global so modules that wrap
// `globalThis.chrome` at import time (wxt/browser) bind to the mock.
Object.assign(globalThis, { chrome: chromeMock });
