// Window postMessage bridge between the MAIN-world measurement scripts (no
// chrome.* access) and the bridge script (entrypoints/bridge.content.ts),
// which owns a chrome-backed SettingsStore + OverrideLog. Requests and
// responses travel as postMessage envelopes on the shared window; the
// bridge answers directly from chrome.storage.local, so no service-worker
// round trip is involved. World choice documented in entrypoints/content.ts.
//
// Transport choice: postMessage, not CustomEvents. Firefox does not deliver
// page-dispatched custom events to content-script sandboxes, so a
// CustomEvent protocol dies in Firefox's single-world layout (the firefox
// e2e settings spec caught it: the bridge never answered). postMessage is
// the sanctioned cross-world channel in both browsers, in both directions.

import type { OverrideLogEntry } from './override-log';
import { OverrideLog } from './override-log';
import type { Settings } from './settings';
import { SettingsStore } from './settings';

export const BRIDGE_CHANNEL = 'speedwatcher:bridge';
export const BRIDGE_TIMEOUT_MS = 1500;

export type BridgeRequest =
  | { type: 'settings:get' }
  | { type: 'settings:set'; settings: Settings }
  | { type: 'log:append'; entry: Omit<OverrideLogEntry, 'ts'> };

export type BridgeResult<T extends BridgeRequest> = T extends { type: 'settings:get' }
  ? Settings
  : void;

export interface BridgeEnvelope {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'request' | 'response';
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

/** Isolated-world side: resolves a request against the shared store + log. */
export async function handleBridgeRequest(
  request: BridgeRequest,
  deps: { settings: SettingsStore; log: OverrideLog },
): Promise<Settings | void> {
  switch (request.type) {
    case 'settings:get':
      return deps.settings.load();
    case 'settings:set':
      await deps.settings.save(request.settings);
      return undefined;
    case 'log:append':
      await deps.log.append(request.entry);
      return undefined;
  }
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
