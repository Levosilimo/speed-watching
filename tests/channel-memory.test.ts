import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MEMORY_MAX,
  CHANNEL_MEMORY_STORAGE_KEY,
  ChannelMemory,
  isChannelRecord,
  type ChannelRecord,
} from '../lib/channel-memory';
import { mockStorage } from './fixtures/helpers';

function record(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return { rate: 160, unit: 'wpm', language: 'en', ts: 1000, ...overrides };
}

describe('ChannelMemory', () => {
  it('round-trips a measured record', async () => {
    const memory = new ChannelMemory(mockStorage());
    await memory.put('UC-a', record());
    expect(await memory.get('UC-a')).toEqual(record());
  });

  it('overwrites on re-put for the same channel', async () => {
    const memory = new ChannelMemory(mockStorage());
    await memory.put('UC-a', record({ rate: 150, ts: 1 }));
    await memory.put('UC-a', record({ rate: 165, ts: 2 }));
    expect(await memory.get('UC-a')).toEqual(record({ rate: 165, ts: 2 }));
  });

  it('serializes concurrent puts over one storage so no update is lost', async () => {
    // chrome.storage.local has no atomic write: two interleaved get→set
    // pairs would drop one record. The put queue (mirror of DemandStore)
    // serializes them.
    const memory = new ChannelMemory(mockStorage());
    await Promise.all([
      memory.put('UC-a', record({ ts: 1 })),
      memory.put('UC-b', record({ ts: 2 })),
    ]);
    expect(await memory.get('UC-a')).toEqual(record({ ts: 1 }));
    expect(await memory.get('UC-b')).toEqual(record({ ts: 2 }));
  });

  it('returns null for unknown channels and drops corrupt records on read', async () => {
    const memory = new ChannelMemory(mockStorage());
    expect(await memory.get('UC-nope')).toBeNull();
    const storage = mockStorage({
      [CHANNEL_MEMORY_STORAGE_KEY]: {
        'UC-bad': { rate: 'fast', unit: 'wpm', language: 'en', ts: 1 },
        'UC-ok': record(),
      },
    });
    const corrupted = new ChannelMemory(storage);
    expect(await corrupted.get('UC-bad')).toBeNull();
    expect(await corrupted.get('UC-ok')).toEqual(record());
  });

  it('evicts the least-recently-written entry past the bound', async () => {
    const memory = new ChannelMemory(mockStorage());
    for (let i = 0; i < CHANNEL_MEMORY_MAX; i++) {
      await memory.put(`UC-${i}`, record({ ts: i }));
    }
    await memory.put('UC-new', record({ ts: CHANNEL_MEMORY_MAX }));
    expect(await memory.get('UC-0')).toBeNull();
    expect(await memory.get('UC-1')).toEqual(record({ ts: 1 }));
    expect(await memory.get('UC-new')).toEqual(record({ ts: CHANNEL_MEMORY_MAX }));
    expect(await memory.get(`UC-${CHANNEL_MEMORY_MAX - 1}`)).toEqual(
      record({ ts: CHANNEL_MEMORY_MAX - 1 }),
    );
  });

  it('normalizes corrupt entries out of load and the LRU bound', async () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < CHANNEL_MEMORY_MAX; i++) data[`UC-${i}`] = record({ ts: i });
    data['UC-corrupt'] = { rate: 'fast', unit: 'wpm', language: 'en', ts: 1 };
    const memory = new ChannelMemory(mockStorage({ [CHANNEL_MEMORY_STORAGE_KEY]: data }));
    const clean = await memory.load();
    expect(Object.keys(clean)).toHaveLength(CHANNEL_MEMORY_MAX);
    expect(clean['UC-corrupt']).toBeUndefined();
  });

  it('rejects forged record shapes', () => {
    expect(isChannelRecord(record())).toBe(true);
    expect(isChannelRecord({ ...record(), rate: 0 })).toBe(false);
    expect(isChannelRecord({ ...record(), rate: 5000 })).toBe(false);
    expect(isChannelRecord({ ...record(), rate: Number.NaN })).toBe(false);
    expect(isChannelRecord({ ...record(), unit: '' })).toBe(false);
    expect(isChannelRecord({ ...record(), language: '' })).toBe(false);
    expect(isChannelRecord({ ...record(), ts: Number.NaN })).toBe(false);
    expect(isChannelRecord('nope')).toBe(false);
    expect(isChannelRecord(null)).toBe(false);
  });
});
