import { describe, expect, it } from 'vitest';
import {
  ERROR_JOURNAL_LIMIT,
  ERROR_JOURNAL_STORAGE_KEY,
  ErrorJournal,
  isCaptionStatus,
  type ErrorJournalEntry,
} from '../lib/error-journal';
import { mockStorage } from './fixtures/helpers';

describe('ErrorJournal', () => {
  it('appends entries with the collapse reason and an optional video id', async () => {
    const store = new ErrorJournal(mockStorage());
    await store.append({ reason: 'no-track', videoId: 'abc123' }, 1000);
    await store.append({ reason: 'fetch-failed' }, 2000);
    expect(await store.entries()).toEqual([
      { ts: 1000, reason: 'no-track', videoId: 'abc123' },
      { ts: 2000, reason: 'fetch-failed' },
    ]);
  });

  it('is a ring buffer bounded to the newest ERROR_JOURNAL_LIMIT entries', async () => {
    const store = new ErrorJournal(mockStorage());
    for (let i = 0; i < ERROR_JOURNAL_LIMIT + 5; i++) {
      await store.append({ reason: 'capture-missed' }, i);
    }
    const entries = await store.entries();
    expect(entries).toHaveLength(ERROR_JOURNAL_LIMIT);
    expect(entries[0]?.ts).toBe(5);
    expect(entries.at(-1)?.ts).toBe(ERROR_JOURNAL_LIMIT + 4);
  });

  it('serializes concurrent appends so no entry is lost', async () => {
    const store = new ErrorJournal(mockStorage());
    const reasons: ErrorJournalEntry['reason'][] = ['no-track', 'fetch-failed', 'capture-missed'];
    await Promise.all(reasons.map((reason, i) => store.append({ reason }, i)));
    expect(await store.entries()).toHaveLength(3);
  });

  it('drops corrupt records on read', async () => {
    const store = new ErrorJournal(
      mockStorage({
        [ERROR_JOURNAL_STORAGE_KEY]: [
          { ts: 1, reason: 'no-track' },
          { ts: 'bad', reason: 'no-track' },
          { reason: 'fetch-failed' },
          { ts: 4, reason: 'bogus' },
          { ts: 5, reason: 'capture-missed', videoId: 42 },
          'garbage',
          null,
          { ts: 8, reason: 'fetch-failed', videoId: 'v8' },
        ],
      }),
    );
    expect(await store.entries()).toEqual([
      { ts: 1, reason: 'no-track' },
      { ts: 8, reason: 'fetch-failed', videoId: 'v8' },
    ]);
  });

  it('returns an empty list when storage is missing or not an array', async () => {
    expect(await new ErrorJournal(mockStorage()).entries()).toEqual([]);
    const corrupt = await new ErrorJournal(
      mockStorage({ [ERROR_JOURNAL_STORAGE_KEY]: 'not an array' }),
    ).entries();
    expect(corrupt).toEqual([]);
  });

  it('clears the journal', async () => {
    const store = new ErrorJournal(mockStorage());
    await store.append({ reason: 'no-track' }, 1);
    await store.clear();
    expect(await store.entries()).toEqual([]);
  });

  it('accepts only the three caption-collapse reasons on the wire', () => {
    expect(isCaptionStatus('no-track')).toBe(true);
    expect(isCaptionStatus('fetch-failed')).toBe(true);
    expect(isCaptionStatus('capture-missed')).toBe(true);
    expect(isCaptionStatus('measured')).toBe(false);
    expect(isCaptionStatus(undefined)).toBe(false);
    expect(isCaptionStatus(null)).toBe(false);
  });
});
