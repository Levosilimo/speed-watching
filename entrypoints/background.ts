import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createCaptureOrchestrator } from '../lib/capture-orchestrator';
import { isOffscreenEvent, isOptionsMessage } from '../lib/audio-probe';
import { DemandStore } from '../lib/demand';
import {
  isDemandIncrementMessage,
  SHORTCUT_APPLY,
  SHORTCUT_DISMISS,
  type ShortcutMessage,
} from '../lib/messaging';

export default defineBackground(() => {
  const orchestrator = createCaptureOrchestrator(
    {
      tabs: browser.tabs,
      tabCapture: browser.tabCapture,
      offscreen: browser.offscreen,
      runtime: browser.runtime,
      storage: browser.storage,
    },
    { offscreenUrl: browser.runtime.getURL('/offscreen.html') },
  );

  // Single writer for demand counters (lib-11#3): every bridge frame
  // forwards demand:increment here, so one promise chain covers all frames
  // instead of per-frame get→set interleaves.
  const demand = new DemandStore(browser.storage.local);

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: { tab?: { id?: number } },
      sendResponse: (response?: unknown) => void,
    ) => {
      // Bounced offscreen-* messages must not be answered here: the offscreen
      // document's ack is the response the forwarder waits on.
      if (isOptionsMessage(message) || isOffscreenEvent(message)) {
        void orchestrator.handleMessage(message, sender).then(sendResponse);
        return true;
      }
      if (isDemandIncrementMessage(message)) {
        void demand.increment(message.contentType).then(sendResponse);
        return true;
      }
      return false;
    },
  );
  // The action click is the tabCapture invocation gesture — the only way
  // getMediaStreamId accepts the target tab (lib-7 verdict). onClicked only
  // fires when the manifest declares `action` without default_popup
  // (wxt.config.ts). The clicked tab is the capture target.
  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    void orchestrator.startFromAction(tab.id);
  });
  // Keyboard shortcuts (manifest 'commands'): the active tab's youtube
  // content script turns the message into a pill apply/dismiss.
  browser.commands.onCommand.addListener((command) => {
    void routeShortcut(command);
  });
  void orchestrator.init();

  return orchestrator;
});

/** commands API names → the runtime message the active tab's content script
 * handles. Unknown command names are dropped. */
const SHORTCUT_MESSAGES: Record<string, ShortcutMessage> = {
  'apply-recommendation': { type: SHORTCUT_APPLY },
  'dismiss-pill': { type: SHORTCUT_DISMISS },
};

async function routeShortcut(command: string): Promise<void> {
  const message = SHORTCUT_MESSAGES[command];
  if (message === undefined) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  // Tabs without the content script (non-video pages, chrome://) reject with
  // 'Receiving end does not exist' — expected, not an error.
  await browser.tabs.sendMessage(tab.id, message).catch(() => undefined);
}
