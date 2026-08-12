import { beforeEach, describe, expect, it, vi } from 'vitest';
import backgroundModule from '../entrypoints/background';
import { chromeMock } from './chrome-mock';

const EXTENSION_ID = 'abcdefghijklmnop';
const OFFSCREEN_URL = `chrome-extension://${EXTENSION_ID}/offscreen.html`;

type BackgroundListener = (
  message: unknown,
  sender: { tab?: { id?: number } },
  sendResponse: (response?: unknown) => void,
) => boolean;

beforeEach(() => {
  vi.clearAllMocks();
  chromeMock.runtime.getURL.mockReturnValue(OFFSCREEN_URL);
  chromeMock.tabs.query.mockResolvedValue([{ id: 5 }]);
  chromeMock.tabCapture.getMediaStreamId.mockResolvedValue('stream-1');
  chromeMock.runtime.getContexts.mockResolvedValue([]);
  chromeMock.offscreen.createDocument.mockResolvedValue(undefined);
  chromeMock.storage.session.get.mockResolvedValue({});
  chromeMock.storage.session.set.mockResolvedValue(undefined);
  chromeMock.storage.session.remove.mockResolvedValue(undefined);
  chromeMock.runtime.sendMessage.mockResolvedValue({ received: true });
});

function driveMessage(listener: BackgroundListener, message: unknown, senderTabId?: number): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, { tab: senderTabId === undefined ? undefined : { id: senderTabId } }, resolve);
  });
}

function registeredListener(): BackgroundListener {
  const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]?.[0] as
    | BackgroundListener
    | undefined;
  if (!listener) throw new Error('no background listener registered');
  return listener;
}

function installLocalStorage(): Map<string, unknown> {
  const storageData = new Map<string, unknown>();
  chromeMock.storage.local.get.mockImplementation(async (key: string) => ({
    [key]: storageData.get(key),
  }));
  chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) storageData.set(key, value);
  });
  return storageData;
}

describe('background wiring', () => {
  it('registers the message listener and drives a start through the chrome APIs', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const response = await driveMessage(listener, { kind: 'probe-start' }, 3);

    expect(chromeMock.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 5 });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledWith({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: expect.any(String),
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      kind: 'offscreen-start',
      streamId: 'stream-1',
    });
    expect(response).toMatchObject({ state: 'starting', tabId: 5 });
  });

  it('leaves bounced offscreen messages unanswered', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const returned = listener({ kind: 'offscreen-start', streamId: 'x' }, { tab: { id: 1 } }, vi.fn());
    expect(returned).toBe(false);
    const also = listener({ kind: 'offscreen-stop' }, { tab: { id: 1 } }, vi.fn());
    expect(also).toBe(false);
  });

  it('routes a stop through to the offscreen document', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    await driveMessage(listener, { kind: 'probe-start' }, 3);
    const response = await driveMessage(listener, { kind: 'probe-stop' });

    expect(response).toMatchObject({ state: 'idle' });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'offscreen-stop' });
    expect(chromeMock.storage.session.remove).toHaveBeenCalledWith('probeCapture');
  });

  it('wires the action click to a capture of the clicked tab', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const click = chromeMock.action.onClicked.addListener.mock.calls[0]?.[0] as
      | ((tab: { id?: number }) => void)
      | undefined;
    if (!click) throw new Error('no action click listener registered');

    click({ id: 9 });
    await vi.waitFor(() => {
      expect(chromeMock.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 9 });
    });
    const listener = registeredListener();
    await driveMessage(listener, { kind: 'offscreen-event', event: 'started' });
    expect(await driveMessage(listener, { kind: 'probe-state' })).toMatchObject({
      state: 'capturing',
      tabId: 9,
    });
  });

  it('answers demand:increment through its single DemandStore (lib-11#3 single writer)', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    const response = await driveMessage(listener, { type: 'demand:increment', contentType: 'generic' });

    expect(response).toMatchObject({ estimatedCount: 1, byContentType: { generic: 1 } });
  });

  it('serializes concurrent increments from two frames without loss', async () => {
    installLocalStorage();
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const listener = registeredListener();

    // Two frames (sender tabs 1 and 2) race their increments; the single
    // background-owned chain serializes them so neither get→set interleaves.
    const [a, b] = await Promise.all([
      driveMessage(listener, { type: 'demand:increment', contentType: 'generic' }, 1),
      driveMessage(listener, { type: 'demand:increment', contentType: 'talk' }, 2),
    ]);
    expect(a).toMatchObject({ estimatedCount: 1, byContentType: { generic: 1 } });
    expect(b).toMatchObject({ estimatedCount: 2, byContentType: { generic: 1, talk: 1 } });
  });

  it('ignores an action click without a tab id', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const click = chromeMock.action.onClicked.addListener.mock.calls[0]?.[0] as
      | ((tab: { id?: number }) => void)
      | undefined;
    if (!click) throw new Error('no action click listener registered');

    click({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeMock.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
  });
});
