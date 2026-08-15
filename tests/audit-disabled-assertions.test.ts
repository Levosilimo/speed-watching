import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, scanDisabledAssertions } from '../scripts/audit-disabled-assertions.ts';
import { CORPUS } from './fixtures/audit-corpus/disabled-assertions.ts';

const corpusPath = fileURLToPath(new URL('./fixtures/audit-corpus/disabled-assertions.ts', import.meta.url));
const cleanPath = fileURLToPath(new URL('./fixtures/audit-corpus/mirror-lib.ts', import.meta.url));

describe('audit-disabled-assertions', () => {
  it('flags every disabled-assertion sample with file:line', () => {
    const findings = scanDisabledAssertions([corpusPath]);
    const source = readFileSync(corpusPath, 'utf8');
    // 1-based line of the opening backtick; CORPUS index i sits at +i.
    const templateLine = source.slice(0, source.indexOf('`')).split('\n').length;
    const sampleLines = CORPUS.split('\n');
    for (let i = 1; i < sampleLines.length - 1; i++) {
      const sample = sampleLines[i]!.trim();
      if (sample.includes('skipIf')) continue; // negative control, asserted below
      const hit = findings.find((f) => f.text.includes(sample));
      expect(hit, `sample: ${sample}`).toBeDefined();
      expect(hit?.line).toBe(templateLine + i);
    }
    expect(findings).toHaveLength(7);
  });

  it('does not flag skipIf conditionals', () => {
    const findings = scanDisabledAssertions([corpusPath]);
    expect(findings.some((f) => f.text.includes('skipIf'))).toBe(false);
  });

  it('leaves clean files alone', () => {
    expect(scanDisabledAssertions([cleanPath])).toEqual([]);
  });

  it('exits 1 on findings, 0 on clean input', () => {
    expect(main([corpusPath])).toBe(1);
    expect(main([cleanPath])).toBe(0);
  });
});
