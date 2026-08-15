// Corpus lib for the mirror lane: distinctive literals living in the
// non-exported internals. A test that repeats them verbatim is the mirror
// signature audit-mirror-scan flags; a test that calls the exports instead
// is the honest lane.

const BAND_MS = 482;
const SURGE_KEY = 'surge-window';

export function bandWidth(): number {
  return BAND_MS;
}

export function surgeKey(): string {
  return SURGE_KEY;
}
