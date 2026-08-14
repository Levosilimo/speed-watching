// Window postMessage bridge between the MAIN-world measurement scripts (no
// chrome.* access) and the bridge script (entrypoints/bridge.content.ts),
// which owns a chrome-backed SettingsStore, OverrideLog, and ChannelMemory.
// Requests and responses travel as postMessage envelopes on the shared
// window. Settings, log, and channel-memory requests the bridge answers
// directly from chrome.storage.local — no service-worker round trip.
// demand:increment and timeSaved:accrue are the exceptions: the bridge
// forwards them to the background (runtime.sendMessage), the single writer,
// so increments from every frame serialize on one DemandStore/TimeSavedStore
// instead of interleaving per-frame get→set pairs (lib-11#3).
// World choice documented in entrypoints/content.ts.
//
// Transport choice: postMessage, not CustomEvents. Firefox does not deliver
// page-dispatched custom events to content-script sandboxes, so a
// CustomEvent protocol dies in Firefox's single-world layout (the firefox
// e2e settings spec caught it: the bridge never answered). postMessage is
// the sanctioned cross-world channel in both browsers, in both directions.

import { CHANNEL_KEY_MAX_LENGTH, ChannelMemory, isChannelRecord, type ChannelRecord } from './channel-memory';
import { isContentType } from './music';
import type { ContentType } from './music';
import type { OverrideLogEntry } from './override-log';
import { OverrideLog } from './override-log';
import {
  PLATFORM_MAX_MAX,
  PLATFORM_MAX_MIN,
  SettingsStore,
  TARGET_WPM_MAX,
  TARGET_WPM_MIN,
  type Settings,
} from './settings';

export const BRIDGE_CHANNEL = 'speedwatcher:bridge';
export const BRIDGE_TIMEOUT_MS = 1500;

/** Runtime message the bridge sends the background for demand:increment
 * (single-writer routing, lib-11#3); the background answers with the
 * updated DemandRecord. Same shape as the bridge request it carries. */
interface DemandIncrementMessage {
  type: 'demand:increment';
  contentType: ContentType;
}

export function isDemandIncrementMessage(value: unknown): value is DemandIncrementMessage {
  return isRecord(value) && value.type === 'demand:increment' && isContentType(value.contentType);
}

/** Runtime message the bridge sends the background for timeSaved:accrue
 * (single-writer routing, lib-11#3); the background answers with the new
 * saved-seconds total. Same shape as the bridge request it carries. */
interface TimeSavedAccrueMessage {
  type: 'timeSaved:accrue';
  deltaSec: number;
  multiplier: number;
}

/** Shape check for timeSaved:accrue crossing the postMessage boundary: the
 * delta must be a finite number (the store's (0, 1] bound is the accrue
 * authority) and the multiplier must sit in the SEC-3 log bounds. */
export function isTimeSavedAccrueMessage(value: unknown): value is TimeSavedAccrueMessage {
  return (
    isRecord(value) &&
    value.type === 'timeSaved:accrue' &&
    typeof value.deltaSec === 'number' &&
    Number.isFinite(value.deltaSec) &&
    isFiniteNumberIn(value.multiplier, MULTIPLIER_MIN, MULTIPLIER_MAX)
  );
}

/** Runtime message the background sends the active tab on a keyboard
 * shortcut (chrome.commands, wxt.config.ts). The ISOLATED bridge receives
 * it and relays it to the MAIN-world script (see ShortcutEnvelope). */
export const SHORTCUT_APPLY = 'speedwatcher:apply-shortcut';
export const SHORTCUT_DISMISS = 'speedwatcher:dismiss-shortcut';

export type ShortcutMessage =
  | { type: typeof SHORTCUT_APPLY }
  | { type: typeof SHORTCUT_DISMISS };

export function isShortcutMessage(value: unknown): value is ShortcutMessage {
  return isRecord(value) && (value.type === SHORTCUT_APPLY || value.type === SHORTCUT_DISMISS);
}

/** Window channel the ISOLATED bridge uses to relay a shortcut message to
 * the MAIN-world script (chrome.* is unavailable in the page world). */
export const SHORTCUT_CHANNEL = 'speedwatcher:shortcut';

export interface ShortcutEnvelope {
  channel: typeof SHORTCUT_CHANNEL;
  message: ShortcutMessage;
}

export function isShortcutEnvelope(value: unknown): value is ShortcutEnvelope {
  return isRecord(value) && value.channel === SHORTCUT_CHANNEL && isShortcutMessage(value.message);
}

export type BridgeRequest =
  | { type: 'settings:get' }
  | { type: 'settings:set'; settings: Settings }
  | { type: 'log:append'; entry: Omit<OverrideLogEntry, 'ts'> }
  | { type: 'channel:get'; channelKey: string }
  | { type: 'channel:put'; channelKey: string; record: ChannelRecord }
  | DemandIncrementMessage
  | TimeSavedAccrueMessage;

export type BridgeResult<T extends BridgeRequest> = T extends { type: 'settings:get' }
  ? Settings
  : T extends { type: 'channel:get' }
    ? ChannelRecord | null
    : void;

export interface BridgeEnvelope {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'request' | 'response';
  payload: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Runtime shape check for channel keys crossing the postMessage boundary:
 * non-empty and bounded (channelIds are ~24 chars; author-name fallbacks
 * are short display names). */
function isChannelKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CHANNEL_KEY_MAX_LENGTH;
}

export function isBridgeEnvelope(value: unknown): value is BridgeEnvelope {
  return (
    isRecord(value) &&
    value.channel === BRIDGE_CHANNEL &&
    (value.direction === 'request' || value.direction === 'response') &&
    isRecord(value.payload)
  );
}

/** postMessage/addEventListener('message') surface shared by Window
 * (content scripts) and the unit-test fake host. */
export interface EventHost {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
}

export interface BridgeDeps {
  settings: SettingsStore;
  log: OverrideLog;
  channels: ChannelMemory;
  /** Forwards demand:increment to the background — the single writer. */
  forwardDemand: (contentType: ContentType) => Promise<unknown>;
  /** Forwards timeSaved:accrue to the background — the single writer. */
  forwardAccrue: (deltaSec: number, multiplier: number) => Promise<unknown>;
}

export function isFiniteNumberIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isSiteOverride(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.target !== undefined && !isFiniteNumberIn(value.target, TARGET_WPM_MIN, TARGET_WPM_MAX)) {
    return false;
  }
  if (
    value.platformMax !== undefined &&
    !isFiniteNumberIn(value.platformMax, PLATFORM_MAX_MIN, PLATFORM_MAX_MAX)
  ) {
    return false;
  }
  if (
    value.multiplierOverride !== undefined &&
    (typeof value.multiplierOverride !== 'number' || !Number.isFinite(value.multiplierOverride))
  ) {
    return false;
  }
  if (value.contentType !== undefined && !isContentType(value.contentType)) return false;
  return true;
}

function isContentTypePrefs(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.target === undefined || isFiniteNumberIn(value.target, TARGET_WPM_MIN, TARGET_WPM_MAX))
  );
}

// SEC-3 bounds for log:append entries: the pill recommends within
// platformMax (<= 4) and no speech track runs above 1000 wpm, so anything
// outside these ranges is forgery. Shared with lib/time-saved.ts, whose
// accrue gate uses the same multiplier bounds.
export const MULTIPLIER_MIN = 0.1;
export const MULTIPLIER_MAX = 10;
export const NATURAL_RATE_MIN = 1;
export const NATURAL_RATE_MAX = 1000;
const USER_ACTIONS = new Set(['apply', 'dismiss', 'adjust']);
export const RECOMMENDATION_MODES = new Set(['recommend', 'warning', 'unreachable', 'music']);

/** Runtime shape check for log:append payloads crossing the postMessage
 * boundary (SEC-3): a page can post arbitrary JSON, so every field the
 * habits report reads is validated before anything is appended. */
export function isLogEntry(value: unknown): value is Omit<OverrideLogEntry, 'ts'> {
  if (!isRecord(value)) return false;
  if (!isContentType(value.contentType)) return false;
  if (!isFiniteNumberIn(value.naturalRate, NATURAL_RATE_MIN, NATURAL_RATE_MAX)) return false;
  if (!isFiniteNumberIn(value.multiplier, MULTIPLIER_MIN, MULTIPLIER_MAX)) return false;
  if (typeof value.site !== 'string' || value.site.length === 0) return false;
  if (typeof value.userAction !== 'string' || !USER_ACTIONS.has(value.userAction)) return false;
  if (typeof value.mode !== 'string' || !RECOMMENDATION_MODES.has(value.mode)) return false;
  if (value.videoId !== undefined && typeof value.videoId !== 'string') return false;
  if (value.finalMultiplier !== undefined && !isFiniteNumberIn(value.finalMultiplier, MULTIPLIER_MIN, MULTIPLIER_MAX)) {
    return false;
  }
  return true;
}

/** Runtime shape check for settings:set payloads crossing the postMessage
 * boundary — the type system cannot vouch for page-posted data. */
export function isSettingsPayload(value: unknown): value is Settings {
  if (!isRecord(value)) return false;
  if (typeof value.conservative !== 'boolean') return false;
  if (!isFiniteNumberIn(value.platformMax, PLATFORM_MAX_MIN, PLATFORM_MAX_MAX)) return false;
  // Strict boolean: a forged (or stale, pre-Tier-4) payload without the
  // provider toggle must not turn the measured-rate API on.
  if (typeof value.externalApiEnabled !== 'boolean') return false;
  if (value.target !== undefined && !isFiniteNumberIn(value.target, TARGET_WPM_MIN, TARGET_WPM_MAX)) {
    return false;
  }
  if (value.contentType !== undefined && !isContentType(value.contentType)) return false;
  if (!isRecord(value.sites) || !Object.values(value.sites).every(isSiteOverride)) return false;
  if (!isRecord(value.contentTypes) || !Object.values(value.contentTypes).every(isContentTypePrefs)) {
    return false;
  }
  return true;
}

/** Isolated-world side: resolves a request against the shared stores.
 * siteHost is the requesting frame's bare hostname (see
 * createBridgeListener); it bounds which sites overrides the page may
 * write (SEC-1). */
export async function handleBridgeRequest(
  request: BridgeRequest,
  deps: BridgeDeps,
  siteHost: string,
): Promise<Settings | ChannelRecord | null | void> {
  switch (request.type) {
    case 'settings:get':
      return deps.settings.load();
    case 'settings:set':
      // Forged payloads (out-of-range target/platformMax, wrong shapes) must
      // not reach storage: reject instead of saving garbage.
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
    case 'log:append':
      // SEC-3: forged entries (NaN multipliers, unknown content types) must
      // not pollute the habits report; nothing is appended on rejection.
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
      // keys) must not reach storage; nothing is written on rejection.
      if (!isChannelKey(request.channelKey) || !isChannelRecord(request.record)) {
        throw new Error('channel:put: invalid record');
      }
      await deps.channels.put(request.channelKey, request.record);
      return undefined;
    case 'demand:increment':
      // Shape validation at the boundary: unknown content types are rejected
      // here and never reach the background writer.
      if (!isContentType(request.contentType)) {
        throw new Error(`demand:increment: unknown content type ${request.contentType}`);
      }
      await deps.forwardDemand(request.contentType);
      return undefined;
    case 'timeSaved:accrue':
      // Shape validation at the boundary: out-of-range payloads are rejected
      // here and never reach the background writer (the store re-checks the
      // (0, 1] delta bound — the wire guard only proves finite numbers).
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

/** MAIN-world side: posts a request envelope and awaits the matching
 * response envelope. */
export function createBridgeClient(host: EventHost): {
  request<T extends BridgeRequest>(request: T): Promise<BridgeResult<T>>;
} {
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
