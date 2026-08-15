import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../scripts/audit-lanes.ts';
import { scanContractNotCount } from '../scripts/audit-contract-not-count.ts';
import { scanMirrorScan } from '../scripts/audit-mirror-scan.ts';
import { scanSyntheticFixtures } from '../scripts/audit-real-fixtures.ts';
import { copycat, countSamples, honest } from './fixtures/audit-corpus/mirror-test.ts';

const corpusDir = fileURLToPath(new URL('./fixtures/audit-corpus/', import.meta.url));
const mirrorTest = join(corpusDir, 'mirror-test.ts');
const mirrorLib = join(corpusDir, 'mirror-lib.ts');
const disabled = join(corpusDir, 'disabled-assertions.ts');
const noRef = join(corpusDir, 'synthetic-no-ref.json');
const withRef = join(corpusDir, 'synthetic-with-ref.json');

describe('audit-mirror-scan', () => {
  it('flags literals repeated from the lib internals', () => {
    const findings = scanMirrorScan([mirrorTest]);
    const messages = findings.map((f) => f.message);
    expect(messages.some((m) => m.includes(`number ${copycat.retryMs} mirrors`))).toBe(true);
    expect(messages.some((m) => m.includes(`string '${copycat.key}' mirrors`))).toBe(true);
    expect(findings.every((f) => f.message.includes(mirrorLib))).toBe(true);
  });

  it('accepts a test that calls the lib instead of copying values', () => {
    expect(honest.retryMs).toBe(copycat.retryMs);
    expect(honest.key).toBe(copycat.key);
  });
});

describe('audit-contract-not-count', () => {
  it('flags spy and call hits for human confirmation', () => {
    const src = readFileSync(mirrorTest, 'utf8').split('\n');
    const spyLine = src.findIndex((l) => l.includes('spy'));
    const callLine = src.findIndex((l) => l.includes('CalledWith'));
    expect(spyLine).toBeGreaterThan(0);
    expect(callLine).toBeGreaterThan(0);
    const findings = scanContractNotCount([mirrorTest]);
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.line === spyLine + 1)).toBe(true);
    expect(findings.some((f) => f.line === callLine + 1)).toBe(true);
    expect(countSamples.spy).toContain('spy');
    expect(countSamples.call).toContain('CalledWith');
  });
});

describe('audit-real-fixtures', () => {
  it('flags synthetic fixtures with no provenance', () => {
    expect(scanSyntheticFixtures([noRef])).toHaveLength(1);
  });

  it('accepts fixtures tracing to a recorded videoId', () => {
    expect(scanSyntheticFixtures([withRef])).toEqual([]);
  });
});

describe('audit-lanes dispatcher', () => {
  const corpus = [disabled, mirrorTest, noRef, withRef];

  it('warns and exits 0 by default', () => {
    expect(main(corpus, {})).toBe(0);
  });

  it('fails when a lane is strict', () => {
    expect(main(corpus, { LCE_STRICT_MIRROR: '1' })).toBe(1);
    expect(main(corpus, { LCE_STRICT_COUNT: '1' })).toBe(1);
    expect(main(corpus, { LCE_STRICT_FIXTURES: '1' })).toBe(1);
  });

  it('stays green on clean input even when strict', () => {
    const env = { LCE_STRICT_MIRROR: '1', LCE_STRICT_COUNT: '1', LCE_STRICT_FIXTURES: '1' };
    expect(main([mirrorLib], env)).toBe(0);
  });
});
