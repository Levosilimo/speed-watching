#!/usr/bin/env bun
/**
 * audit-lanes — the fixture provenance gate (AGENTS.md: Testing lanes →
 * Fixture provenance gate).
 *
 * Hard gate: every fixture data file under tests/fixtures/synthetic/ must
 * be named in tests/fixtures/README.md with its derivation lineage; any
 * synthetic fixture the README does not name fails the run. There is no
 * baseline backlog and no env escape — a new fixture either lands with its
 * README line or the gate stays red.
 *
 * Usage in lefthook.yml:
 *   audit-lanes:
 *     run: bun run scripts/audit-lanes.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverSyntheticFixtures, scanFixtureProvenance } from './audit-real-fixtures.ts';

export function main(argv: string[]): number {
  const root = process.cwd();
  const paths = argv.map((p) => resolve(root, p));
  const files = paths.length > 0 ? paths : discoverSyntheticFixtures(root);
  const fixturesRoot = resolve(root, 'tests', 'fixtures');
  const provenanceDoc = readFileSync(resolve(fixturesRoot, 'README.md'), 'utf8');
  const findings = scanFixtureProvenance(files, provenanceDoc, fixturesRoot);
  for (const f of findings) {
    console.error(`[FAIL] audit-real-fixtures: ${f.file} ${f.message}`);
  }
  if (findings.length > 0) {
    console.error(
      `[audit-lanes] ${findings.length} synthetic fixture(s) missing from the provenance README`,
    );
    return 1;
  }
  console.log('[audit-lanes] every synthetic fixture is named in the provenance README');
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
