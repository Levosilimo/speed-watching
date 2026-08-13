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
  },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabCapture: { getMediaStreamId: vi.fn() },
  action: { onClicked: { addListener: vi.fn() } },
  commands: { onCommand: { addListener: vi.fn() } },
  offscreen: { createDocument: vi.fn() },
  storage: {
    session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    local: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } },
  },
};
