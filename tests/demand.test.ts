import { describe, expect, it } from 'vitest';
import { DEMAND_STORAGE_KEY, DemandStore } from '../lib/demand';
import { mockStorage } from './fixtures/helpers';

describe('DemandStore', () => {
  it('increments the total and the per-type count on first use', async () => {
    const store = new DemandStore(mockStorage());
    const record = await store.increment('generic', 1000);
    expect(record.estimatedCount).toBe(1);
    expect(record.byContentType.generic).toBe(1);
    expect(record.firstSeenTs).toBe(1000);
    expect(record.lastSeenTs).toBe(1000);
  });

  it('accumulates across content types and advances lastSeenTs', async () => {
    const store = new DemandStore(mockStorage());
    await store.increment('generic', 1000);
    await store.increment('podcast', 2000);
    await store.increment('generic', 3000);
    const record = await store.get();
    expect(record.estimatedCount).toBe(3);
    expect(record.byContentType).toEqual({ generic: 2, podcast: 1 });
    expect(record.firstSeenTs).toBe(1000);
    expect(record.lastSeenTs).toBe(3000);
  });

  it('serializes concurrent increments so no update is lost', async () => {
    const store = new DemandStore(mockStorage());
    await Promise.all([
      store.increment('generic'),
      store.increment('talk'),
      store.increment('generic'),
    ]);
    const record = await store.get();
    expect(record.estimatedCount).toBe(3);
    expect(record.byContentType).toEqual({ generic: 2, talk: 1 });
  });

  it('returns an empty record when storage is missing or corrupt', async () => {
    const empty = await new DemandStore(mockStorage()).get();
    expect(empty).toEqual({ estimatedCount: 0, byContentType: {} });
    const corrupt = await new DemandStore(
      mockStorage({ [DEMAND_STORAGE_KEY]: 'not a record' }),
    ).get();
    expect(corrupt).toEqual({ estimatedCount: 0, byContentType: {} });
  });

  it('normalizes corrupt fields: negative counts, floats, unknown keys', async () => {
    const store = new DemandStore(
      mockStorage({
        [DEMAND_STORAGE_KEY]: {
          estimatedCount: -5,
          byContentType: { generic: 2.7, bogus: 4, talk: -1 },
          firstSeenTs: 'nope',
          lastSeenTs: 42,
        },
      }),
    );
    const record = await store.get();
    expect(record.estimatedCount).toBe(0);
    expect(record.byContentType).toEqual({ generic: 2 });
    expect(record.firstSeenTs).toBeUndefined();
    expect(record.lastSeenTs).toBe(42);
  });

  it('increment survives a corrupt stored record', async () => {
    const store = new DemandStore(
      mockStorage({ [DEMAND_STORAGE_KEY]: { estimatedCount: 'junk' } }),
    );
    const record = await store.increment('generic', 500);
    expect(record.estimatedCount).toBe(1);
    expect(record.byContentType.generic).toBe(1);
    expect(record.firstSeenTs).toBe(500);
  });

  it('bounds byContentType to the ContentType union', async () => {
    const store = new DemandStore(mockStorage());
    const types = ['lecture', 'talk', 'explainer', 'news', 'podcast', 'music', 'generic', 'unknown'] as const;
    for (const type of types) await store.increment(type);
    const record = await store.get();
    expect(record.estimatedCount).toBe(types.length);
    expect(Object.keys(record.byContentType).sort()).toEqual([...types].sort());
  });
});
