// Window postMessage bridge between the MAIN-world measurement scripts (no
// chrome.* access) and the bridge script (entrypoints/bridge.content.ts),
// which owns a chrome-backed SettingsStore, OverrideLog, and ChannelMemory.
// Requests and responses travel as postMessage envelopes on the shared
// window. Settings, log, and channel-memory requests the bridge answers
// directly from chrome.storage.local — no service-worker round trip.
// demand:increment, the nudge messages, and timeSaved:accrue are the
// exceptions: the bridge forwards them to the background
// (runtime.sendMessage), the single writer, so increments from every frame
// serialize on one DemandStore / NudgeStore / TimeSavedStore instead of
// interleaving per-frame get→set pairs (lib-11#3).
// World choice documented in entrypoints/content.ts.
//
// Transport choice: postMessage, not CustomEvents. Firefox does not deliver
// page-dispatched custom events to content-script sandboxes, so a
// CustomEvent protocol dies in Firefox's single-world layout (the firefox
// e2e settings spec caught it: the bridge never answered). postMessage is
// the sanctioned cross-world channel in both browsers, in both directions.
//
// Wire protocol (envelope shapes, payload guards, shared bounds) lives in
// lib/bridge-protocol.ts and is re-exported below for existing importers.

import { CHANNEL_KEY_MAX_LENGTH, ChannelMemory, isChannelRecord } from './channel-memory';
import { isContentType, type ContentType } from './music';
import { OverrideLog } from './override-log';
import { SettingsStore } from './settings';
import { SkipSilenceStore } from './skip-silence';
import { BRIDGE_CHANNEL, isBridgeEnvelope, isLogEntry, isNudgeDismiss, isNudgeRecordApply, isSettingsPayload, isSkipPrefs, isTimeSavedAccrueMessage, type BridgeRequest, type BridgeResult } from './bridge-protocol';
export {
  BRIDGE_CHANNEL,
  isBridgeEnvelope,
  isDemandIncrementMessage,
  isNudgeDismiss,
  isNudgeRecordApply,
  isSettingsPayload,
  isShortcutEnvelope,
  isShortcutMessage,
  isTimeSavedAccrueMessage,
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
  SHORTCUT_APPLY,
  SHORTCUT_CHANNEL,
  SHORTCUT_DISMISS,
  type BridgeEnvelope,
  type BridgeRequest,
  type BridgeResult,
  type ShortcutMessage,
} from './bridge-protocol';

export const BRIDGE_TIMEOUT_MS = 1500;

/** Runtime shape check for channel keys crossing the postMessage boundary:
 * non-empty and bounded (channelIds are ~24 chars; author-name fallbacks
 * are short display names). */
function isChannelKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CHANNEL_KEY_MAX_LENGTH;
}

/** postMessage/addEventListener('message') surface shared by Window
 * (content scripts) and the unit-test fake host. */
export interface EventHost {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
}

export interface BridgeDeps {
  settings: SettingsStore;
  skip: SkipSilenceStore;
  log: OverrideLog;
  channels: ChannelMemory;
  forwardDemand: (contentType: ContentType) => Promise<unknown>;
  forwardNudgeRecordApply: (multiplier: number) => Promise<unknown>;
  forwardNudgeDismiss: (forever: boolean) => Promise<unknown>;
  forwardAccrue: (deltaSec: number, multiplier: number) => Promise<unknown>;
}

/** Isolated-world side: resolves a request against the shared stores.
 * siteHost is the requesting frame's bare hostname (see
 * createBridgeListener); it bounds which sites overrides the page may
 * write (SEC-1). */
export async function handleBridgeRequest(
  request: BridgeRequest,
  deps: BridgeDeps,
  siteHost: string,
): Promise<unknown> {
  switch (request.type) {
    case 'settings:get':
      return deps.settings.load();
    case 'settings:set':
      // Forged payloads (out-of-range target/platformMax, wrong shapes)
      // must not reach storage.
      if (!isSettingsPayload(request.settings)) {
        throw new Error('settings:set: invalid settings payload');
      }
      // SEC-1: a page may only add overrides for its own host; other hosts
      // are the options page's domain (it writes SettingsStore directly, so
      // the restriction cannot lock legitimate writes out).
      for (const host of Object.keys(request.settings.sites)) {
        if (host !== siteHost) {
          throw new Error(`settings:set: sites override for foreign host ${host}`);
        }
      }
      await deps.settings.save(request.settings);
      return undefined;
    case 'settings:seenFirstRun':
      // One-flag merge, not a full settings:set — the content script cannot
      // round-trip the stored settings through SEC-1 (foreign site
      // overrides would reject the write).
      await deps.settings.update((settings) => ({ ...settings, seenFirstRun: true }));
      return undefined;
    case 'skip:get':
      return deps.skip.load();
    case 'skip:set':
      // Forged prefs (out-of-bound gaps, non-boolean toggles) must not reach
      // storage.
      if (!isSkipPrefs(request.prefs)) {
        throw new Error('skip:set: invalid prefs');
      }
      await deps.skip.save(request.prefs);
      return undefined;
    case 'log:append':
      // SEC-3: forged entries (NaN multipliers, unknown content types) must
      // not pollute the habits report.
      if (!isLogEntry(request.entry)) {
        throw new Error('log:append: invalid entry');
      }
      await deps.log.append(request.entry);
      return undefined;
    case 'channel:get':
      // SEC: a lookup with a malformed key answers null — nothing is
      // written, so there is nothing to reject.
      if (!isChannelKey(request.channelKey)) return null;
      return deps.channels.get(request.channelKey);
    case 'channel:put':
      // SEC-3: forged records (out-of-range rates, oversized or empty
      // keys) must not reach storage.
      if (!isChannelKey(request.channelKey) || !isChannelRecord(request.record)) {
        throw new Error('channel:put: invalid record');
      }
      await deps.channels.put(request.channelKey, request.record);
      return undefined;
    case 'demand:increment':
      // Boundary validation: unknown content types never reach the
      // background writer.
      if (!isContentType(request.contentType)) {
        throw new Error(`demand:increment: unknown content type ${request.contentType}`);
      }
      await deps.forwardDemand(request.contentType);
      return undefined;
    case 'nudge:recordApply':
      // Boundary validation: out-of-range multipliers never reach the
      // background writer.
      if (!isNudgeRecordApply(request)) {
        throw new Error('nudge:recordApply: invalid multiplier');
      }
      return deps.forwardNudgeRecordApply(request.multiplier);
    case 'nudge:dismiss':
      if (!isNudgeDismiss(request)) {
        throw new Error('nudge:dismiss: invalid forever flag');
      }
      return deps.forwardNudgeDismiss(request.forever);
    case 'timeSaved:accrue':
      // Boundary validation: out-of-range payloads never reach the
      // background writer (the store re-checks the (0, 1] delta bound —
      // the wire guard only proves finite numbers).
      if (!isTimeSavedAccrueMessage(request)) {
        throw new Error('timeSaved:accrue: invalid accrue payload');
      }
      await deps.forwardAccrue(request.deltaSec, request.multiplier);
      return undefined;
  }
}

/** Factory for the bridge's window listener: same-frame source guard, then
 * envelope dispatch against handleBridgeRequest. host is the frame window
 * the bridge serves; requests whose event.source is a different window
 * (cross-frame forgery) are dropped before parsing. */
export function createBridgeListener(
  deps: BridgeDeps,
  host: Window,
): (event: MessageEvent) => void {
  // SEC-1: the frame's bare hostname is the only sites key its page may
  // write — same normalization the measurement scripts apply
  // (location.hostname.replace(/^www\./, '')).
  const siteHost = host.location.hostname.replace(/^www\./, '');
  return (event) => {
    if (event.source !== host) return;
    const envelope = event.data;
    if (!isBridgeEnvelope(envelope) || envelope.direction !== 'request') return;
    const detail = envelope.payload as BridgeRequest & { id: number };
    void handleBridgeRequest(detail, deps, siteHost).then(
      (result) => {
        host.postMessage(
          {
            channel: BRIDGE_CHANNEL,
            direction: 'response',
            payload: { id: detail.id, ok: true, result },
          },
          '*',
        );
      },
      (error: unknown) => {
        host.postMessage(
          {
            channel: BRIDGE_CHANNEL,
            direction: 'response',
            payload: { id: detail.id, ok: false, error: String(error) },
          },
          '*',
        );
      },
    );
  };
}

export interface BridgeClient {
  request<T extends BridgeRequest>(request: T): Promise<BridgeResult<T>>;
}

export function createBridgeClient(host: EventHost): BridgeClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  host.addEventListener('message', (event) => {
    const envelope = event.data;
    if (!isBridgeEnvelope(envelope) || envelope.direction !== 'response') return;
    const detail = envelope.payload;
    const id = Number(detail.id);
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    if (detail.ok === true) {
      entry.resolve(detail.result);
    } else {
      entry.reject(new Error(String(detail.error)));
    }
  });

  return {
    request<T extends BridgeRequest>(request: T): Promise<BridgeResult<T>> {
      const id = nextId++;
      return new Promise<BridgeResult<T>>((resolve, reject) => {
        pending.set(id, {
          // Wire boundary: the response envelope carries the typed result
          // by contract.
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        host.postMessage(
          { channel: BRIDGE_CHANNEL, direction: 'request', payload: { id, ...request } },
          '*',
        );
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`bridge timeout: ${request.type}`));
        }, BRIDGE_TIMEOUT_MS);
      });
    },
  };
}
