import { beforeEach, describe, expect, it, vi } from 'vitest';
import backgroundModule from '../entrypoints/background';
import { chromeMock } from './chrome-mock';

const EXTENSION_ID = 'abcdefghijklmnop';
const OFFSCREEN_URL = `chrome-extension://${EXTENSION_ID}/offscreen.html`;

type CommandListener = (command: string) => void;

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
  chromeMock.tabs.sendMessage.mockResolvedValue({ received: true });
});

function registeredCommandListener(): CommandListener {
  const listener = chromeMock.commands.onCommand.addListener.mock.calls[0]?.[0] as
    | CommandListener
    | undefined;
  if (!listener) throw new Error('no commands listener registered');
  return listener;
}

describe('keyboard shortcut routing (chrome.commands)', () => {
  it('routes apply-recommendation to the active tab as a shortcut message', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const onCommand = registeredCommandListener();

    onCommand('apply-recommendation');
    await vi.waitFor(() => {
      expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(5, {
        type: 'speedwatcher:apply-shortcut',
      });
    });
  });

  it('routes dismiss-pill to the active tab as a shortcut message', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const onCommand = registeredCommandListener();

    onCommand('dismiss-pill');
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(5, {
        type: 'speedwatcher:dismiss-shortcut',
      });
    });
  });

  it('drops unknown command names without touching any tab', async () => {
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const onCommand = registeredCommandListener();

    onCommand('not-a-command');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the active tab has no id', async () => {
    chromeMock.tabs.query.mockResolvedValue([{ active: true, currentWindow: true }]);
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const onCommand = registeredCommandListener();

    onCommand('apply-recommendation');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('swallows sendMessage rejection on tabs without the content script', async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    const main = (backgroundModule as { main: () => unknown }).main;
    main();
    const onCommand = registeredCommandListener();

    onCommand('dismiss-pill');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(5, {
      type: 'speedwatcher:dismiss-shortcut',
    });
  });
});
