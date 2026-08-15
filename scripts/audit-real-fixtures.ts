#!/usr/bin/env bun
/**
 * audit-real-fixtures — hard lane: synthetic fixtures trace to a captured
 * payload or the e2e lane they were authored for (AGENTS.md: External
 * truth, Fixture provenance gate).
 *
 * Every fixture data file under tests/fixtures/synthetic/ (*.json/*.vtt/
 * *.srt) must be named in tests/fixtures/README.md with its derivation
 * lineage. A fixture the README does not name is a finding — a recorded
 * videoId inside the payload buys no exemption, because provenance is the
 * doc line, not a greppable token.
 *
 * Exit 1 whenever findings exist (the gate is hard — no env escape). Paths
 * on argv override the default synthetic discovery; the provenance doc and
 * fixtures root are parameters so the audit specs can drive corpus inputs.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ScanFinding {
  file: string;
  message: string;
}

const FIXTURE_EXT = /\.(json|vtt|srt)$/;
/** Provenance doc names: fixture paths like `synthetic/word-level.json`. */
const NAME_IN_DOC = /[A-Za-z0-9_./-]+\.(json|vtt|srt)/g;

export function discoverSyntheticFixtures(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      } else if (FIXTURE_EXT.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(join(root, 'tests', 'fixtures', 'synthetic'));
  return files.sort();
}

export function scanFixtureProvenance(
  files: string[],
  provenanceDoc: string,
  fixturesRoot: string,
): ScanFinding[] {
  const named = new Set([...provenanceDoc.matchAll(NAME_IN_DOC)].map((m) => m[0]!));
  const findings: ScanFinding[] = [];
  for (const file of files) {
    if (!FIXTURE_EXT.test(file)) continue;
    const name = relative(fixturesRoot, file);
    if (!named.has(name)) {
      findings.push({
        file,
        message: 'not named in tests/fixtures/README.md (synthetic fixtures table)',
      });
    }
  }
  return findings;
}
