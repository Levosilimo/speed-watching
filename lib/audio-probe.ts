// Message protocol between the options page, background, and offscreen
// document, plus pure helpers for the audio probe. No chrome imports — safe
// to import from any context and from vitest.

type CaptureState = 'idle' | 'starting' | 'capturing' | 'degraded' | 'error';

type OptionsMessage =
  | { kind: 'probe-start' }
  | { kind: 'probe-stop' }
  | { kind: 'probe-state' };

export type ProbeState = {
  state: CaptureState;
  level: number;
  tabId?: number;
  error?: string;
  wasm?: WasmCheckResult;
};

export type WasmCheckResult = { ok: boolean; sab: boolean; error?: string };

export type OffscreenMessage =
  | { kind: 'offscreen-start'; streamId: string }
  | { kind: 'offscreen-stop' }
  | { kind: 'offscreen-wasm-check' };

export type OffscreenEvent =
  | { kind: 'offscreen-event'; event: 'started' }
  | { kind: 'offscreen-event'; event: 'stopped' }
  | { kind: 'offscreen-event'; event: 'track-ended' }
  | { kind: 'offscreen-event'; event: 'level'; level: number }
  | { kind: 'offscreen-event'; event: 'error'; error: string }
  | { kind: 'offscreen-event'; event: 'wasm-check'; wasm: WasmCheckResult };

type OffscreenAck = { received: true };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isOptionsMessage(value: unknown): value is OptionsMessage {
  return (
    isRecord(value) &&
    (value.kind === 'probe-start' || value.kind === 'probe-stop' || value.kind === 'probe-state')
  );
}

export function isOffscreenMessage(value: unknown): value is OffscreenMessage {
  return (
    isRecord(value) &&
    (value.kind === 'offscreen-start' ||
      value.kind === 'offscreen-stop' ||
      value.kind === 'offscreen-wasm-check')
  );
}

export function isOffscreenEvent(value: unknown): value is OffscreenEvent {
  if (!isRecord(value) || value.kind !== 'offscreen-event') return false;
  const event = value.event;
  return (
    event === 'started' ||
    event === 'stopped' ||
    event === 'track-ended' ||
    (event === 'level' && typeof value.level === 'number') ||
    (event === 'error' && typeof value.error === 'string') ||
    (event === 'wasm-check' && isWasmResult(value.wasm))
  );
}

export function isAck(value: unknown): value is OffscreenAck {
  return isRecord(value) && value.received === true;
}

function isWasmResult(value: unknown): value is WasmCheckResult {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    typeof value.sab === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) return error.message;
  return String(error);
}

// Root mean square of analyser samples in [-1, 1]; 0 means silence.
export function rmsLevel(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

// Minimal valid wasm module: the 8-byte header only.
const EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// SharedArrayBuffer exists only under cross-origin isolation, which extension
// pages cannot opt into — this is the COI check for the Phase 2 WASM path.
export async function probeWasmSupport(): Promise<WasmCheckResult> {
  const sab = typeof SharedArrayBuffer !== 'undefined';
  try {
    await WebAssembly.compile(EMPTY_WASM_MODULE);
    return { ok: true, sab };
  } catch (error) {
    return { ok: false, sab, error: errorMessage(error) };
  }
}
