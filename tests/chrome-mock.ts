import { vi } from 'vitest';

// Minimal chrome mock for the background glue test. vitest-chrome 0.1.0
// cannot load under vitest 3: its CJS build require()s the ESM-only vitest
// entry. Same shape as the Bitwarden pattern — a global `chrome` of vi.fn()s.
export const chromeMock = {
  runtime: {
    getURL: vi.fn(),
    sendMessage: vi.fn(),
    getContexts: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onMessageExternal: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
    create: vi.fn(),
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabCapture: { getMediaStreamId: vi.fn() },
  action: { onClicked: { addListener: vi.fn() } },
  commands: { onCommand: { addListener: vi.fn() } },
  offscreen: { createDocument: vi.fn() },
  contextMenus: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn(), hasListener: vi.fn() },
  },
  storage: {
    session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    // Default get/set implementations: a vi.fn() with no implementation
    // returns undefined, and the options harness's module re-imports (the
    // vitest module-cache quirk documented in options-a11y.test.ts) can
    // float a dev.ts refreshDemand past vi.restoreAllMocks() at teardown —
    // a bare get() then throws on raw[this.key] as an unhandled rejection
    // and fails the run. Returning {} keeps the floating call harmless.
    local: {
      get: vi.fn(async (..._args: never[]) => ({})),
      set: vi.fn(async (..._args: never[]) => {}),
      onChanged: { addListener: vi.fn() },
    },
  },
};
