import { describe, expect, it } from 'vitest';
import { OVERRIDE_LOG_LIMIT, OverrideLog } from '../lib/override-log';
import type { ContentTypeStats, OverrideLogEntry, OverrideReport } from '../lib/override-log';
import { mockStorage } from './fixtures/helpers';

function entry(overrides: Partial<OverrideLogEntry> = {}): Omit<OverrideLogEntry, 'ts'> {
  return {
    site: 'youtube.com',
    contentType: 'lecture',
    naturalRate: 150,
    multiplier: 1.5,
    mode: 'warning',
    userAction: 'apply',
    ...overrides,
  };
}

describe('OverrideLog', () => {
  it('appends timestamped entries in order', async () => {
    const log = new OverrideLog(mockStorage());
    await log.append(entry({ userAction: 'dismiss' }));
    await log.append(entry({ videoId: 'abc', userAction: 'adjust', finalMultiplier: 1.6 }));
    const entries = await log.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.userAction).toBe('dismiss');
    expect(entries[1]?.finalMultiplier).toBe(1.6);
    expect(entries.every((e) => Number.isFinite(e.ts))).toBe(true);
  });

  it('keeps only the newest entries within the limit', async () => {
    const log = new OverrideLog(mockStorage());
    for (let i = 0; i < OVERRIDE_LOG_LIMIT + 25; i++) {
      await log.append(entry({ videoId: `v${i}` }));
    }
    const entries = await log.entries();
    expect(entries).toHaveLength(OVERRIDE_LOG_LIMIT);
    expect(entries[0]?.videoId).toBe('v25');
    expect(entries.at(-1)?.videoId).toBe(`v${OVERRIDE_LOG_LIMIT + 24}`);
  });

  it('reports counts and applied-multiplier averages per content type', async () => {
    const log = new OverrideLog(mockStorage());
    await log.append(entry({ contentType: 'lecture', multiplier: 1.5 }));
    await log.append(entry({ contentType: 'lecture', multiplier: 1.7 }));
    await log.append(entry({ contentType: 'lecture', multiplier: 1.9, userAction: 'dismiss' }));
    await log.append(entry({ contentType: 'talk', multiplier: 1.2, userAction: 'adjust' }));
    const report: OverrideReport = await log.report();
    expect(report.total).toBe(4);
    const lecture: ContentTypeStats | undefined = report.byContentType.lecture;
    expect(lecture).toEqual({ count: 3, avgMultiplier: 1.6 });
    expect(report.byContentType.talk).toEqual({ count: 1, avgMultiplier: null });
  });

  it('reports an empty log as empty', async () => {
    const report = await new OverrideLog(mockStorage()).report();
    expect(report.total).toBe(0);
    expect(report.byContentType).toEqual({});
  });
});
