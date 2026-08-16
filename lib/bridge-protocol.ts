// Wire protocol for the window postMessage bridge: envelope shapes plus the
// runtime guards that validate page-posted payloads (a page can post
// arbitrary JSON — nothing crosses the bridge unvalidated). Split from
// lib/messaging.ts so the bridge runtime stays under the aislop size
// budget; messaging.ts re-exports this surface for existing importers.
// Routing rationale (single-writer background forwarding) lives in
// lib/messaging.ts.

import { CHANNEL_KEY_MAX_LENGTH, isChannelRecord, type ChannelRecord } from './channel-memory';
import { isCaptionStatus } from './error-journal';
import { isContentType, type ContentType } from './music';
import type { CaptionStatus } from '../ui/pill';
import type { OverrideLogEntry } from './override-log';
import { MAX_GAP_SEC, MAX_PAUSE_RATE, MIN_GAP_SEC, MIN_PAUSE_RATE, type SkipSilencePrefs } from './skip-silence';
import { MAX_FLUSH_SEC } from './time-saved';
import {
  PLATFORM_MAX_MAX,
  PLATFORM_MAX_MIN,
  TARGET_WPM_MAX,
  TARGET_WPM_MIN,
  type AutoApplyPrefs,
  type Settings,
} from './settings';

export const BRIDGE_CHANNEL = 'speedwatcher:bridge';

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

/** Runtime message the bridge sends the background for channel:put
 * (single-writer routing like demand:increment, lib-11#3); the background
 * answers after the record lands. Same shape as the bridge request it
 * carries. */
interface ChannelPutMessage {
  type: 'channel:put';
  channelKey: string;
  record: ChannelRecord;
}

export function isChannelPutMessage(value: unknown): value is ChannelPutMessage {
  return (
    isRecord(value) &&
    value.type === 'channel:put' &&
    typeof value.channelKey === 'string' &&
    value.channelKey.length > 0 &&
    value.channelKey.length <= CHANNEL_KEY_MAX_LENGTH &&
    isChannelRecord(value.record)
  );
}

/** Runtime message the bridge sends the background for journal:append
 * (single-writer routing like demand:increment); the background answers
 * after the record lands. Same shape as the bridge request it carries. */
export interface JournalAppendMessage {
  type: 'journal:append';
  reason: CaptionStatus;
  videoId?: string;
}

export function isJournalAppendMessage(value: unknown): value is JournalAppendMessage {
  return (
    isRecord(value) &&
    value.type === 'journal:append' &&
    isCaptionStatus(value.reason) &&
    (value.videoId === undefined || typeof value.videoId === 'string')
  );
}

/** Runtime message the bridge sends the background for nudge:recordApply
 * (single-writer routing like demand:increment); the background answers
 * with the show flag. Same shape as the bridge request it carries. */
interface NudgeRecordApplyMessage {
  type: 'nudge:recordApply';
  multiplier: number;
}

export function isNudgeRecordApply(value: unknown): value is NudgeRecordApplyMessage {
  return (
    isRecord(value) &&
    value.type === 'nudge:recordApply' &&
    isFiniteNumberIn(value.multiplier, MULTIPLIER_MIN, MULTIPLIER_MAX)
  );
}

interface TimeSavedAccrueMessage {
  type: 'timeSaved:accrue';
  deltaSec: number;
  multiplier: number;
}

/** Shape check for timeSaved:accrue crossing the postMessage boundary: the
 * delta must be finite and within the honest per-flush bound (a flush spans
 * at most FLUSH_INTERVAL_MS of tracked wall time — MAX_FLUSH_SEC), and the
 * multiplier must sit in the SEC-3 log bounds. The store re-checks the
 * delta > 0 and multiplier range as defense-in-depth. */
export function isTimeSavedAccrueMessage(value: unknown): value is TimeSavedAccrueMessage {
  return (
    isRecord(value) &&
    value.type === 'timeSaved:accrue' &&
    isFiniteNumberIn(value.deltaSec, 0, MAX_FLUSH_SEC) &&
    isFiniteNumberIn(value.multiplier, MULTIPLIER_MIN, MULTIPLIER_MAX)
  );
}

/** Runtime message the bridge sends the background for nudge:dismiss —
 * 'Got it' (cooldown) or 'Don't show again' (permanent). */
interface NudgeDismissMessage {
  type: 'nudge:dismiss';
  forever: boolean;
}

export function isNudgeDismiss(value: unknown): value is NudgeDismissMessage {
  return isRecord(value) && value.type === 'nudge:dismiss' && typeof value.forever === 'boolean';
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
  | { type: 'settings:seenFirstRun' }
  | { type: 'skip:get' }
  | { type: 'skip:set'; prefs: SkipSilencePrefs }
  | { type: 'log:append'; entry: Omit<OverrideLogEntry, 'ts'> }
  | { type: 'channel:get'; channelKey: string }
  | { type: 'channel:put'; channelKey: string; record: ChannelRecord }
  | DemandIncrementMessage
  | JournalAppendMessage
  | NudgeRecordApplyMessage
  | NudgeDismissMessage
  | TimeSavedAccrueMessage;

export type BridgeResult<T extends BridgeRequest> = T extends { type: 'settings:get' }
  ? Settings
  : T extends { type: 'skip:get' }
    ? SkipSilencePrefs
    : T extends { type: 'channel:get' }
      ? ChannelRecord | null
      : T extends { type: 'nudge:recordApply' }
        ? { show: boolean }
        : void;

export interface BridgeEnvelope {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'request' | 'response';
  payload: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  if (value.skipSilence !== undefined && typeof value.skipSilence !== 'boolean') return false;
  return true;
}

function isContentTypePrefs(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.target === undefined || isFiniteNumberIn(value.target, TARGET_WPM_MIN, TARGET_WPM_MAX))
  );
}

/** Runtime shape check for the auto-apply prefs crossing the postMessage
 * boundary: master toggle boolean, contentTypes a record of booleans. */
export function isAutoApplyPrefs(value: unknown): value is AutoApplyPrefs {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isRecord(value.contentTypes) &&
    Object.values(value.contentTypes).every((flag) => typeof flag === 'boolean')
  );
}

/** Runtime shape check for skip-silence prefs crossing the postMessage
 * boundary: strict toggle, gap/pause bounds matching the lib's
 * normalize-on-read clamps. */
export function isSkipPrefs(value: unknown): value is SkipSilencePrefs {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isFiniteNumberIn(value.minGapSec, MIN_GAP_SEC, MAX_GAP_SEC) &&
    isFiniteNumberIn(value.pauseRate, MIN_PAUSE_RATE, MAX_PAUSE_RATE)
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
  // Optional-only: pre-auto-apply payloads (the e2e bridge write) stay
  // valid; a present-but-malformed autoApply is rejected.
  if (value.autoApply !== undefined && !isAutoApplyPrefs(value.autoApply)) return false;
  return true;
}
