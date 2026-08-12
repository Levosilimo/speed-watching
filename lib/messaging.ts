// Window-event bridge between the MAIN-world content script (no chrome.*
// access) and its ISOLATED-world sibling (entrypoints/bridge.ts), which owns
// a chrome-backed SettingsStore + OverrideLog + DemandStore. Requests and
// responses travel as CustomEvents on the shared window; the isolated side
// answers directly from chrome.storage.local, so no service-worker round
// trip is involved. World choice documented in entrypoints/content.ts.

import { DemandStore } from './demand';
import { isContentType } from './music';
import type { ContentType } from './music';
import type { OverrideLogEntry } from './override-log';
import { OverrideLog } from './override-log';
import type { Settings } from './settings';
import { SettingsStore } from './settings';

export const BRIDGE_REQUEST_EVENT = 'speedwatcher:bridge-request';
export const BRIDGE_RESPONSE_EVENT = 'speedwatcher:bridge-response';
export const BRIDGE_TIMEOUT_MS = 1500;

export type BridgeRequest =
  | { type: 'settings:get' }
  | { type: 'log:append'; entry: Omit<OverrideLogEntry, 'ts'> }
  | { type: 'demand:increment'; contentType: ContentType };

export type BridgeResult<T extends BridgeRequest> = T extends { type: 'settings:get' }
  ? Settings
  : T extends { type: 'log:append' }
    ? void
    : T extends { type: 'demand:increment' }
      ? void
      : never;

export interface BridgeResponse<T extends BridgeRequest = BridgeRequest> {
  id: number;
  ok: true;
  result: BridgeResult<T>;
}

export interface BridgeErrorResponse {
  id: number;
  ok: false;
  error: string;
}

/** addEventListener/dispatchEvent surface shared by Window and EventTarget. */
export interface EventHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
}

/** Isolated-world side: resolves a request against the shared stores. */
export async function handleBridgeRequest(
  request: BridgeRequest,
  deps: { settings: SettingsStore; log: OverrideLog; demand: DemandStore },
): Promise<Settings | void> {
  switch (request.type) {
    case 'settings:get':
      return deps.settings.load();
    case 'log:append':
      await deps.log.append(request.entry);
      break;
    case 'demand:increment':
      // Shape validation: reject unknown content types instead of counting
      // them under a garbage key.
      if (!isContentType(request.contentType)) {
        throw new Error(`demand:increment: unknown content type ${request.contentType}`);
      }
      await deps.demand.increment(request.contentType);
  }
}

/** MAIN-world side: dispatches a request and awaits the matching response. */
export function createBridgeClient(host: EventHost): {
  request<T extends BridgeRequest>(request: T): Promise<BridgeResult<T>>;
} {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  host.addEventListener(BRIDGE_RESPONSE_EVENT, (event) => {
    const detail = (event as CustomEvent<BridgeResponse | BridgeErrorResponse>).detail;
    const entry = pending.get(detail.id);
    if (entry === undefined) return;
    pending.delete(detail.id);
    if (detail.ok) {
      entry.resolve(detail.result);
    } else {
      entry.reject(new Error(detail.error));
    }
  });

  return {
    request<T extends BridgeRequest>(request: T): Promise<BridgeResult<T>> {
      const id = nextId++;
      return new Promise<BridgeResult<T>>((resolve, reject) => {
        pending.set(id, {
          // Wire boundary: the response carries the typed result by contract.
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        host.dispatchEvent(
          new CustomEvent(BRIDGE_REQUEST_EVENT, { detail: { id, ...request } }),
        );
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`bridge timeout: ${request.type}`));
        }, BRIDGE_TIMEOUT_MS);
      });
    },
  };
}
