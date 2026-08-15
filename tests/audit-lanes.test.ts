import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../scripts/audit-lanes.ts';
import { scanFixtureProvenance } from '../scripts/audit-real-fixtures.ts';

const corpusDir = fileURLToPath(new URL('./fixtures/audit-corpus/', import.meta.url));
const unnamed = join(corpusDir, 'unnamed-synthetic.json');
const named = join(corpusDir, 'named-synthetic.json');
// Both corpus fixtures carry a scripts/data videoId reference; only the
// provenance doc distinguishes them — a videoId inside the payload must not
// buy an exemption.
const corpusDoc = 'named: named-synthetic.json';

describe('audit-real-fixtures', () => {
  it('flags a synthetic fixture the provenance README does not name', () => {
    const findings = scanFixtureProvenance([unnamed], corpusDoc, corpusDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe(unnamed);
  });

  it('accepts a synthetic fixture named in the provenance README', () => {
    expect(scanFixtureProvenance([named], corpusDoc, corpusDir)).toEqual([]);
  });

  it('ignores non-caption assets', () => {
    const asset = join(corpusDir, 'asset.webm');
    expect(scanFixtureProvenance([asset], corpusDoc, corpusDir)).toEqual([]);
  });
});

describe('audit-lanes gate', () => {
  it('exits 1 when a synthetic fixture is missing from the provenance README', () => {
    expect(main([unnamed])).toBe(1);
  });

  it('exits 0 when the committed tree names every synthetic fixture', () => {
    // The CI and run-ci wiring run the lanes against the whole tree; the
    // provenance README is the human-confirmed record, so this must stay 0
    // unless a synthetic fixture lands without its README line.
    expect(main([])).toBe(0);
  });
});
