// Corpus clean lib for the audit gates: distinctive literals living in the
// non-exported internals, exports that call them. Used as the clean sample
// by the audit specs (no disabled assertions, no mirror signature).

const BAND_MS = 482;
const SURGE_KEY = 'surge-window';

export function bandWidth(): number {
  return BAND_MS;
}

export function surgeKey(): string {
  return SURGE_KEY;
}
