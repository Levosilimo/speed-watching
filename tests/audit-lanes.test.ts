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
const table = (rows: string[]): string =>
  ['| fixture | lineage | evidence |', '|---|---|---|', ...rows].join('\n');
const honestRow = '| named-synthetic.json | wpm pipeline edge case | 3c99d7d |';

describe('audit-real-fixtures', () => {
  it('flags a synthetic fixture the provenance table does not name', () => {
    const findings = scanFixtureProvenance([unnamed], table([honestRow]), corpusDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe(unnamed);
  });

  it('flags a fixture named only in a doc comment — the name must be a table row', () => {
    // The old gate name-matched the whole doc, so a comment mentioning the
    // fixture bought an exemption; the table is the only naming surface.
    const doc = `<!-- ${'named'} fixture: ${'named-synthetic.json'} — mentioned in prose, not named -->\n\n${table([])}`;
    expect(scanFixtureProvenance([named], doc, corpusDir)).toHaveLength(1);
  });

  it('flags a lineage row with no citable evidence', () => {
    const doc = table(['| named-synthetic.json | wpm pipeline edge case | |']);
    const findings = scanFixtureProvenance([named], doc, corpusDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('no citable evidence');
  });

  it('flags a lineage row whose evidence does not exist', () => {
    const doc = table(['| named-synthetic.json | wpm pipeline edge case | real/nope.json |']);
    const findings = scanFixtureProvenance([named], doc, corpusDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('does not exist: real/nope.json');
  });

  it('accepts a fixture whose lineage cites real evidence', () => {
    expect(scanFixtureProvenance([named], table([honestRow]), corpusDir)).toEqual([]);
  });

  it('accepts a lineage citing a golden-master registry fixture', () => {
    const doc = table(['| named-synthetic.json | derived from the captured ASR payload | real/asr-word.json |']);
    expect(scanFixtureProvenance([named], doc, corpusDir)).toEqual([]);
  });

  it('ignores non-caption assets', () => {
    const asset = join(corpusDir, 'asset.webm');
    expect(scanFixtureProvenance([asset], table([honestRow]), corpusDir)).toEqual([]);
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
