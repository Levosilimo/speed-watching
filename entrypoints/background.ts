import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createCaptureOrchestrator } from '../lib/capture-orchestrator';
import { isOffscreenEvent, isOptionsMessage } from '../lib/audio-probe';

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
  void orchestrator.init();

  return orchestrator;
});
