import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createCaptureOrchestrator } from '../lib/capture-orchestrator';
import { isOffscreenEvent, isOptionsMessage } from '../lib/audio-probe';
import { DemandStore } from '../lib/demand';
import {
  clampWpmResponse,
  isDemandIncrementMessage,
  isWpmGetRequest,
  isWpmGetResponse,
  SHORTCUT_APPLY,
  SHORTCUT_DISMISS,
  WPM_GET,
  WPM_PROTOCOL_VERSION,
  type ShortcutMessage,
  type WpmGetResponse,
} from '../lib/messaging';
import { SettingsStore } from '../lib/settings';

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
  const settings = new SettingsStore(browser.storage.local);

  browser.runtime.onMessageExternal.addListener(
    (
      message: unknown,
      sender: { id?: string },
      sendResponse: (response?: unknown) => void,
    ) => {
      if (!isWpmGetRequest(message)) return false;
      void handleExternalWpmRequest(settings, sender.id)
        .then(sendResponse)
        // The provider must never throw: a dead listener leaves the partner
        // hanging, so any unexpected failure becomes an internal error.
        .catch(() => sendResponse({ ok: false, error: 'internal' }));
      return true;
    },
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

// Measured-rate provider (docs/provider-integration.md): partner extensions
// query the current video's measured rate over runtime.onMessageExternal.
// Both this allowlist and the manifest's externally_connectable.ids
// (wxt.config.ts) must name a partner before their requests are served —
// they mirror each other. Partner opt-in: the partner adds the matching
// listener, the user enables the options toggle, and the partner's ID
// lands in both lists. Starts empty; partner IDs get added on their opt-in.
export const ALLOWED_PROVIDER_IDS: string[] = [];

// Per-sender sliding window over request timestamps: a partner cannot wake
// the service worker more than 10 times per 10 s window.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10_000;
const providerHits = new Map<string, number[]>();

function providerAllowed(id: string, now = Date.now()): boolean {
  const recent = (providerHits.get(id) ?? []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    providerHits.set(id, recent);
    return false;
  }
  recent.push(now);
  providerHits.set(id, recent);
  return true;
}

/** wpm:get serving path; guards run in order, cheapest first, so a
 * disabled or unknown sender never reaches the tab round trip (SW-wake
 * abuse protection). The response crosses back from the tab world, so it
 * is re-validated and clamped at this boundary before sendResponse. */
async function handleExternalWpmRequest(
  settings: SettingsStore,
  senderId: string | undefined,
): Promise<WpmGetResponse> {
  if ((await settings.load()).externalApiEnabled !== true) return { ok: false, error: 'disabled' };
  if (senderId === undefined || !ALLOWED_PROVIDER_IDS.includes(senderId)) {
    return { ok: false, error: 'forbidden' };
  }
  if (!providerAllowed(senderId)) return { ok: false, error: 'rate_limited' };
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return { ok: false, error: 'no-active-video' };
  const response = await browser.tabs.sendMessage(tab.id, {
    type: WPM_GET,
    version: WPM_PROTOCOL_VERSION,
  });
  if (!isWpmGetResponse(response)) return { ok: false, error: 'internal' };
  return clampWpmResponse(response);
}

async function routeShortcut(command: string): Promise<void> {
  const message = SHORTCUT_MESSAGES[command];
  if (message === undefined) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  // Tabs without the content script (non-video pages, chrome://) reject with
  // 'Receiving end does not exist' — expected, not an error.
  await browser.tabs.sendMessage(tab.id, message).catch(() => undefined);
}

