import { describe, expect, it } from 'vitest';
import { isAck, isOffscreenEvent, isOffscreenMessage, isOptionsMessage, probeWasmSupport, rmsLevel } from '../lib/audio-probe';

describe('rmsLevel', () => {
  it('returns 0 for silence and empty input', () => {
    expect(rmsLevel(new Float32Array([0, 0, 0]))).toBe(0);
    expect(rmsLevel(new Float32Array())).toBe(0);
  });

  it('computes the root mean square of constant samples', () => {
    expect(rmsLevel(new Float32Array([0.5, 0.5, 0.5, 0.5]))).toBeCloseTo(0.5, 6);
    expect(rmsLevel(new Float32Array([1, -1]))).toBeCloseTo(1, 6);
  });

  it('averages mixed samples', () => {
    expect(rmsLevel(new Float32Array([1, 0]))).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe('probeWasmSupport', () => {
  it('compiles a minimal module and reports SAB availability', async () => {
    const result = await probeWasmSupport();
    expect(result.ok).toBe(true);
    expect(typeof result.sab).toBe('boolean');
  });
});

describe('message guards', () => {
  it('recognizes options messages', () => {
    expect(isOptionsMessage({ kind: 'probe-start' })).toBe(true);
    expect(isOptionsMessage({ kind: 'probe-state' })).toBe(true);
    expect(isOptionsMessage({ kind: 'nope' })).toBe(false);
    expect(isOptionsMessage(null)).toBe(false);
    expect(isOptionsMessage('probe-start')).toBe(false);
  });

  it('recognizes offscreen messages and rejects lookalikes', () => {
    expect(isOffscreenMessage({ kind: 'offscreen-start', streamId: 'x' })).toBe(true);
    expect(isOffscreenMessage({ kind: 'offscreen-stop' })).toBe(true);
    expect(isOffscreenMessage({ kind: 'probe-start' })).toBe(false);
  });

  it('recognizes offscreen events with valid payloads', () => {
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'started' })).toBe(true);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'level', level: 0.5 })).toBe(true);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'level', level: 'x' })).toBe(false);
    expect(isOffscreenEvent({ kind: 'offscreen-event', event: 'unknown' })).toBe(false);
    expect(
      isOffscreenEvent({ kind: 'offscreen-event', event: 'wasm-check', wasm: { ok: true, sab: false } }),
    ).toBe(true);
  });

  it('recognizes acks', () => {
    expect(isAck({ received: true })).toBe(true);
    expect(isAck({ received: false })).toBe(false);
    expect(isAck(undefined)).toBe(false);
  });
});
