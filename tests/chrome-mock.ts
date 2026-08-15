import { vi, type Mock } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// fakeBrowser (wxt/testing/fake-browser → @webext-core/fake-browser 2.0.1)
// ships real in-memory implementations for storage, runtime messaging,
// tabs, and action events. Members it models are exposed as vi.fn()s
// wrapping the fake's implementation: tests keep the vitest surface
// (mockResolvedValue, mock.calls, toHaveBeenCalledWith) while unstubbed
// calls hit the fake's semantics instead of hand-rolled stubs. The rest —
// tabCapture, offscreen, tabs.sendMessage, runtime.getContexts,
// commands, contextMenus — are not modeled by the fake (it throws
// MockNotImplementedError), so they stay bare vi.fn()s. The overloaded
// fake members (sendMessage, query, session.get) need a signature cast so
// vi.fn picks the promise-returning overload, not the callback one.
const wrap = <Args extends unknown[], R>(fn: (...args: Args) => R): Mock<(...args: Args) => R> =>
  vi.fn(fn) as Mock<(...args: Args) => R>;

export const chromeMock = {
  runtime: {
    getURL: wrap(fakeBrowser.runtime.getURL),
    sendMessage: wrap(
      fakeBrowser.runtime.sendMessage as (message: unknown, options?: unknown) => Promise<unknown>,
    ),
    getContexts: vi.fn(),
    onMessage: { addListener: wrap(fakeBrowser.runtime.onMessage.addListener) },
    onMessageExternal: { addListener: vi.fn() },
  },
  tabs: {
    query: wrap(
      fakeBrowser.tabs.query as (
        info: { active?: boolean; currentWindow?: boolean },
      ) => Promise<unknown[]>,
    ),
    sendMessage: vi.fn(),
    create: wrap(fakeBrowser.tabs.create),
    onActivated: { addListener: wrap(fakeBrowser.tabs.onActivated.addListener) },
    onRemoved: { addListener: wrap(fakeBrowser.tabs.onRemoved.addListener) },
  },
  tabCapture: { getMediaStreamId: vi.fn() },
  action: { onClicked: { addListener: wrap(fakeBrowser.action.onClicked.addListener) } },
  commands: { onCommand: { addListener: vi.fn() } },
  offscreen: { createDocument: vi.fn() },
  contextMenus: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn(), hasListener: vi.fn() },
  },
  storage: {
    session: {
      get: wrap(
        fakeBrowser.storage.session.get as (keys: string | null) => Promise<Record<string, unknown>>,
      ),
      set: wrap(fakeBrowser.storage.session.set),
      remove: wrap(fakeBrowser.storage.session.remove),
    },
    local: {
      get: wrap(fakeBrowser.storage.local.get as (keys: never) => Promise<unknown>),
      set: wrap(fakeBrowser.storage.local.set),
      onChanged: { addListener: wrap(fakeBrowser.storage.local.onChanged.addListener) },
    },
  },
};
