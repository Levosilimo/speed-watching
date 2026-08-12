import { describe, expect, it } from 'vitest';
import {
  computeDemandGate,
  DAYS_THRESHOLD,
  DEMAND_STORAGE_KEY,
  DemandStore,
  ELAPSED_CAP_DAYS,
  RENDER_THRESHOLD,
  type DemandRecord,
} from '../lib/demand';
import { mockStorage } from './fixtures/helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
// Local noon, so the +1h/+25h offsets below stay on the same/next local
// date regardless of the runner's timezone.
const NOON = new Date(2026, 0, 10, 12, 0, 0).getTime();

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

  it('normalizes corrupt gate fields: negative renderDays, malformed lastRenderDate', async () => {
    const store = new DemandStore(
      mockStorage({
        [DEMAND_STORAGE_KEY]: {
          estimatedCount: 3,
          byContentType: { generic: 3 },
          renderDays: -2,
          lastRenderDate: 'junk',
        },
      }),
    );
    const record = await store.get();
    expect(record.renderDays).toBeUndefined();
    expect(record.lastRenderDate).toBeUndefined();
  });

  it('keeps valid gate fields, flooring fractional renderDays', async () => {
    const store = new DemandStore(
      mockStorage({
        [DEMAND_STORAGE_KEY]: {
          estimatedCount: 3,
          byContentType: { generic: 3 },
          renderDays: 2.9,
          lastRenderDate: '2026-01-10',
        },
      }),
    );
    const record = await store.get();
    expect(record.renderDays).toBe(2);
    expect(record.lastRenderDate).toBe('2026-01-10');
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

describe('speech-eligible gate counting', () => {
  it('excludes music from the gate count but keeps it in the breakdown', async () => {
    const store = new DemandStore(mockStorage());
    for (let i = 0; i < 5; i++) await store.increment('music', NOON);
    await store.increment('generic', NOON);
    await store.increment('talk', NOON);
    await store.increment('lecture', NOON);
    const record = await store.get();
    const gate = computeDemandGate(record, NOON);
    expect(record.estimatedCount).toBe(8);
    expect(record.byContentType.music).toBe(5);
    expect(gate.speechEligibleCount).toBe(3);
    expect(gate.tripped).toBe(false);
  });

  it('counts distinct render days, not renders, for speech-eligible types', async () => {
    const store = new DemandStore(mockStorage());
    await store.increment('generic', NOON);
    await store.increment('generic', NOON + 60_000); // same day
    await store.increment('podcast', NOON + 3_600_000); // same day
    await store.increment('generic', NOON + 25 * 3_600_000); // next day
    const record = await store.get();
    expect(record.renderDays).toBe(2);
    expect(record.lastRenderDate).toBe('2026-01-11');
  });

  it('does not record render days on music-only increments', async () => {
    const store = new DemandStore(mockStorage());
    await store.increment('music', NOON);
    await store.increment('music', NOON + 25 * 3_600_000);
    const record = await store.get();
    expect(record.renderDays).toBeUndefined();
    expect(record.lastRenderDate).toBeUndefined();
  });

  it('a music-heavy record cannot trip the gate', () => {
    const record: DemandRecord = {
      estimatedCount: RENDER_THRESHOLD * 2,
      byContentType: { music: RENDER_THRESHOLD * 2 },
      renderDays: DAYS_THRESHOLD,
    };
    const gate = computeDemandGate(record, NOON);
    expect(gate.speechEligibleCount).toBe(0);
    expect(gate.tripped).toBe(false);
  });
});

describe('gate trip conditions', () => {
  function record(overrides: Partial<DemandRecord> = {}): DemandRecord {
    return { estimatedCount: 0, byContentType: {}, ...overrides };
  }

  it('trips at the render threshold spread across enough days', () => {
    const gate = computeDemandGate(
      record({
        byContentType: { generic: RENDER_THRESHOLD },
        renderDays: DAYS_THRESHOLD,
        firstSeenTs: NOON,
      }),
      NOON + 10 * DAY_MS,
    );
    expect(gate.tripped).toBe(true);
    expect(gate.reason).toBe('renders');
    expect(gate.speechEligibleCount).toBe(RENDER_THRESHOLD);
  });

  it('does not trip below the threshold or on a single-day binge', () => {
    const belowThreshold = computeDemandGate(
      record({ byContentType: { generic: RENDER_THRESHOLD - 1 }, renderDays: DAYS_THRESHOLD }),
      NOON,
    );
    expect(belowThreshold.tripped).toBe(false);
    const binge = computeDemandGate(
      record({ byContentType: { generic: RENDER_THRESHOLD }, renderDays: DAYS_THRESHOLD - 1 }),
      NOON,
    );
    expect(binge.tripped).toBe(false);
  });

  it('trips on the elapsed cap with an injected clock', () => {
    const firstSeen = NOON;
    const gate = computeDemandGate(record({ firstSeenTs: firstSeen }), firstSeen + ELAPSED_CAP_DAYS * DAY_MS);
    expect(gate.tripped).toBe(true);
    expect(gate.reason).toBe('elapsed');
    expect(gate.elapsedDays).toBe(ELAPSED_CAP_DAYS);
  });

  it('does not trip before the elapsed cap', () => {
    const firstSeen = NOON;
    const gate = computeDemandGate(record({ firstSeenTs: firstSeen }), firstSeen + (ELAPSED_CAP_DAYS - 1) * DAY_MS);
    expect(gate.tripped).toBe(false);
    expect(gate.elapsedDays).toBe(ELAPSED_CAP_DAYS - 1);
  });

  it('reports null elapsed before any increment', () => {
    const gate = computeDemandGate(record(), NOON);
    expect(gate.elapsedDays).toBeNull();
    expect(gate.tripped).toBe(false);
  });

  it('is pure: same record and clock produce the same state', () => {
    const r = record({ byContentType: { talk: 12, podcast: 3 }, renderDays: 2, firstSeenTs: NOON });
    expect(computeDemandGate(r, NOON + 5 * DAY_MS)).toEqual(computeDemandGate(r, NOON + 5 * DAY_MS));
  });
});
