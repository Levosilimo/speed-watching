import { describe, expect, it } from 'vitest';
import {
  NUDGE_APPLIES_BEFORE_SHOW,
  NUDGE_DISMISS_COOLDOWN_MS,
  NUDGE_MIN_INTERVAL_MS,
  NUDGE_MULTIPLIER_MIN,
  NUDGE_STORAGE_KEY,
  NudgeStore,
  shouldShowNudge,
  type NudgeRecord,
} from '../lib/nudge';
import { mockStorage } from './fixtures/helpers';

const NOW = new Date(2026, 0, 10, 12, 0, 0).getTime();

function record(overrides: Partial<NudgeRecord> = {}): NudgeRecord {
  return { highApplied: 0, ...overrides };
}

function spiedStorage(initial: Record<string, unknown> = {}): {
  storage: ReturnType<typeof mockStorage>;
  writes: unknown[];
} {
  const storage = mockStorage(initial);
  const writes: unknown[] = [];
  return {
    storage: {
      ...storage,
      set: (items: Record<string, unknown>) => {
        writes.push(items);
        return storage.set(items);
      },
    },
    writes,
  };
}

describe('shouldShowNudge', () => {
  it('is false below NUDGE_APPLIES_BEFORE_SHOW high-speed applies', () => {
    expect(shouldShowNudge(record({ highApplied: NUDGE_APPLIES_BEFORE_SHOW - 1 }), NOW)).toBe(false);
  });

  it('is true at exactly NUDGE_APPLIES_BEFORE_SHOW', () => {
    expect(shouldShowNudge(record({ highApplied: NUDGE_APPLIES_BEFORE_SHOW }), NOW)).toBe(true);
  });

  it('respects the minimum interval between shows', () => {
    const shown = record({ highApplied: NUDGE_APPLIES_BEFORE_SHOW, lastShownTs: NOW });
    expect(shouldShowNudge(shown, NOW + NUDGE_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldShowNudge(shown, NOW + NUDGE_MIN_INTERVAL_MS)).toBe(true);
  });

  it('suppresses while a cooldown dismiss is active, and expires it', () => {
    const dismissed = record({
      highApplied: NUDGE_APPLIES_BEFORE_SHOW,
      dismissedUntil: NOW + 1000,
    });
    expect(shouldShowNudge(dismissed, NOW)).toBe(false);
    expect(shouldShowNudge(dismissed, NOW + 1001)).toBe(true);
  });

  it('never shows after a permanent dismiss', () => {
    const forever = record({
      highApplied: NUDGE_APPLIES_BEFORE_SHOW,
      dismissedForever: true,
      lastShownTs: NOW - 10 * NUDGE_MIN_INTERVAL_MS,
    });
    expect(shouldShowNudge(forever, NOW)).toBe(false);
  });

  it('is pure: same record and clock produce the same result', () => {
    const r = record({ highApplied: NUDGE_APPLIES_BEFORE_SHOW, lastShownTs: NOW - 1000 });
    expect(shouldShowNudge(r, NOW)).toEqual(shouldShowNudge(r, NOW));
  });
});

describe('NudgeStore', () => {
  it('counts applies below the multiplier threshold as no-ops with zero storage writes', async () => {
    const { storage, writes } = spiedStorage();
    const store = new NudgeStore(storage);
    for (const multiplier of [1, 1.4, NUDGE_MULTIPLIER_MIN - 0.01]) {
      await expect(store.recordApply(multiplier, NOW)).resolves.toEqual({ show: false });
    }
    expect(writes).toHaveLength(0);
    expect(await store.get()).toEqual({ highApplied: 0 });
  });

  it('shows after NUDGE_APPLIES_BEFORE_SHOW high-speed applies and resets the counter', async () => {
    const { storage, writes } = spiedStorage();
    const store = new NudgeStore(storage);
    await expect(store.recordApply(1.6, NOW)).resolves.toEqual({ show: false });
    await expect(store.recordApply(1.6, NOW)).resolves.toEqual({ show: false });
    const shown = await store.recordApply(1.6, NOW);
    expect(shown).toEqual({ show: true });
    // The show stamped lastShownTs and reset the counter in the same write.
    expect(await store.get()).toEqual({ highApplied: 0, lastShownTs: NOW });
    expect(writes).toHaveLength(3);
  });

  it('needs NUDGE_APPLIES_BEFORE_SHOW more applies after a show once the interval passed', async () => {
    const store = new NudgeStore(mockStorage());
    await store.recordApply(1.6, NOW);
    await store.recordApply(1.6, NOW);
    await store.recordApply(1.6, NOW); // show
    const afterInterval = NOW + NUDGE_MIN_INTERVAL_MS + 1;
    await expect(store.recordApply(1.6, afterInterval)).resolves.toEqual({ show: false });
    await expect(store.recordApply(1.6, afterInterval)).resolves.toEqual({ show: false });
    await expect(store.recordApply(1.6, afterInterval)).resolves.toEqual({ show: true });
  });

  it('still counts a show within the interval: interval guards the next show, not the count', async () => {
    const store = new NudgeStore(mockStorage());
    await store.recordApply(1.6, NOW);
    await store.recordApply(1.6, NOW);
    await store.recordApply(1.6, NOW); // show at NOW
    // Within the interval the counter climbs again but nothing shows.
    await expect(store.recordApply(1.6, NOW + 1000)).resolves.toEqual({ show: false });
    await expect(store.recordApply(1.6, NOW + 1000)).resolves.toEqual({ show: false });
    await expect(store.recordApply(1.6, NOW + 1000)).resolves.toEqual({ show: false });
  });

  it('dismiss(false) arms a cooldown and resets the counter', async () => {
    const store = new NudgeStore(mockStorage());
    await store.recordApply(1.6, NOW);
    await store.recordApply(1.6, NOW);
    const dismissed = await store.dismiss(false, NOW);
    expect(dismissed).toEqual({ highApplied: 0, dismissedUntil: NOW + NUDGE_DISMISS_COOLDOWN_MS });
    await expect(store.recordApply(1.6, NOW + 1000)).resolves.toEqual({ show: false });
    await expect(
      store.recordApply(1.6, NOW + NUDGE_DISMISS_COOLDOWN_MS + 1),
    ).resolves.toEqual({ show: false }); // counter restarted from 0
  });

  it('dismiss(true) suppresses forever and resets the counter', async () => {
    const store = new NudgeStore(mockStorage());
    await store.recordApply(1.6, NOW);
    await store.recordApply(1.6, NOW);
    const dismissed = await store.dismiss(true, NOW);
    expect(dismissed).toEqual({ highApplied: 0, dismissedForever: true });
    await expect(store.recordApply(1.6, NOW + 1000)).resolves.toEqual({ show: false });
    await expect(
      store.recordApply(1.6, NOW + 100 * NUDGE_MIN_INTERVAL_MS),
    ).resolves.toEqual({ show: false });
  });

  it('normalizes corrupt or absent storage to safe defaults', async () => {
    const empty = await new NudgeStore(mockStorage()).get();
    expect(empty).toEqual({ highApplied: 0 });
    const corrupt = await new NudgeStore(
      mockStorage({ [NUDGE_STORAGE_KEY]: 'not a record' }),
    ).get();
    expect(corrupt).toEqual({ highApplied: 0 });
    const fields = await new NudgeStore(
      mockStorage({
        [NUDGE_STORAGE_KEY]: {
          highApplied: -3,
          lastShownTs: 'nope',
          dismissedUntil: 42.7,
          dismissedForever: 'yes',
        },
      }),
    ).get();
    // Timestamps pass through verbatim (like demand's lastSeenTs); the
    // counter is floored and non-finite fields are dropped.
    expect(fields).toEqual({ highApplied: 0, dismissedUntil: 42.7 });
  });

  it('recordApply survives a corrupt stored record', async () => {
    const store = new NudgeStore(
      mockStorage({ [NUDGE_STORAGE_KEY]: { highApplied: 'junk' } }),
    );
    await expect(store.recordApply(1.6, NOW)).resolves.toEqual({ show: false });
    await expect(store.recordApply(1.6, NOW)).resolves.toEqual({ show: false });
    await expect(store.recordApply(1.6, NOW)).resolves.toEqual({ show: true });
  });

  it('serializes concurrent recordApply calls so no count is lost (single writer)', async () => {
    const { storage, writes } = spiedStorage();
    const store = new NudgeStore(storage);
    const [a, b, c] = await Promise.all([
      store.recordApply(1.6, NOW),
      store.recordApply(1.6, NOW),
      store.recordApply(1.6, NOW),
    ]);
    expect(a).toEqual({ show: false });
    expect(b).toEqual({ show: false });
    expect(c).toEqual({ show: true });
    expect(await store.get()).toEqual({ highApplied: 0, lastShownTs: NOW });
    expect(writes).toHaveLength(3);
  });

  it('serializes concurrent dismiss and recordApply through the same chain', async () => {
    const store = new NudgeStore(mockStorage());
    await store.recordApply(1.6, NOW);
    await store.recordApply(1.6, NOW);
    const [dismissed, applied] = await Promise.all([
      store.dismiss(false, NOW),
      store.recordApply(1.6, NOW),
    ]);
    expect(dismissed.dismissedUntil).toBe(NOW + NUDGE_DISMISS_COOLDOWN_MS);
    // The dismiss reset the counter; the queued apply bumped it back to 1.
    expect(applied).toEqual({ show: false });
    expect(await store.get()).toEqual({ highApplied: 1, dismissedUntil: NOW + NUDGE_DISMISS_COOLDOWN_MS });
  });
});
