#!/usr/bin/env bun
/**
 * audit-real-fixtures — hard lane: synthetic fixtures trace to a captured
 * payload or the e2e lane they were authored for (AGENTS.md: External
 * truth, Fixture provenance gate).
 *
 * Every file under tests/fixtures/synthetic/ — whatever its extension —
 * must be named in tests/fixtures/README.md's synthetic-fixtures table
 * with its derivation lineage AND an evidence citation the scan can
 * verify exists: a golden-master registry fixture (`real/<name>`), a
 * committed file path (`BUG_ZOO.md`, an e2e spec), a scripts/data/*.jsonl
 * record (`scripts/data/<file>.jsonl#<videoId>`), or a commit hash.
 * Name-matching reads only the table rows — a fixture mentioned in prose
 * or a comment buys no exemption — and a lineage row whose evidence does
 * not exist, or that has no citable evidence, fails the scan.
 *
 * Exit 1 whenever findings exist (the gate is hard — no env escape). Paths
 * on argv override the default synthetic discovery; the provenance doc and
 * fixtures root are parameters so the audit specs can drive corpus inputs.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { loadRegistry } from '../tests/fixtures/registry.ts';

export interface ScanFinding {
  file: string;
  message: string;
}

export interface ProvenanceRow {
  name: string;
  lineage: string;
  evidence: string;
}

const COMMIT_HASH = /^[0-9a-f]{7,40}$/;
const JSONL_RECORD = /^scripts\/data\/.+\.jsonl#([A-Za-z0-9_-]+)$/;

/** Rows of the synthetic-fixtures table — the table whose header carries a
 * `lineage` column. This is the ONLY text the gate name-matches against. */
export function parseProvenanceTable(doc: string): ProvenanceRow[] {
  const rows: ProvenanceRow[] = [];
  let inTable = false;
  for (const line of doc.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      inTable = trimmed.includes('lineage');
      continue;
    }
    const cells = trimmed.split('|').map((cell) => cell.trim());
    if (cells[1] === undefined || cells[1].startsWith('-')) continue; // separator row
    rows.push({
      name: cells[1] ?? '',
      lineage: cells[2] ?? '',
      evidence: cells[3] ?? '',
    });
  }
  return rows;
}

function registryFixtures(): Set<string> {
  return new Set(loadRegistry().map((row) => row.fixture));
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** True when the citation resolves to something that exists: a git commit,
 * a golden-master registry row, a jsonl record carrying the videoId, or a
 * committed file path (fixtures-root-relative or repo-root-relative). */
export function verifyEvidence(token: string, root: string, fixturesRoot: string): boolean {
  if (COMMIT_HASH.test(token)) {
    const check = spawnSync('git', ['rev-parse', '--verify', `${token}^{commit}`], {
      cwd: root,
      stdio: 'ignore',
    });
    return check.status === 0;
  }
  const record = JSONL_RECORD.exec(token);
  if (record !== null) {
    const videoId = record[1]!;
    const file = token.split('#')[0]!;
    return [root, fixturesRoot].some(
      (base) => {
        const path = resolve(base, file);
        return isFile(path) && readFileSync(path, 'utf8').includes(videoId);
      },
    );
  }
  if (token.startsWith('real/')) {
    return registryFixtures().has(token.slice('real/'.length));
  }
  return [root, fixturesRoot].some((base) => isFile(resolve(base, token)));
}

export function discoverSyntheticFixtures(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      } else {
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
  const rows = parseProvenanceTable(provenanceDoc);
  const named = new Set(rows.map((row) => row.name));
  const findings: ScanFinding[] = [];
  for (const file of files) {
    const name = relative(fixturesRoot, file);
    if (!named.has(name)) {
      findings.push({
        file,
        message: 'not named in the synthetic-fixtures provenance table',
      });
    }
  }
  const root = process.cwd();
  for (const row of rows) {
    const tokens = row.evidence
      .split(/[;,]/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length === 0) {
      findings.push({ file: row.name, message: 'lineage row has no citable evidence' });
      continue;
    }
    for (const token of tokens) {
      if (!verifyEvidence(token, root, fixturesRoot)) {
        findings.push({
          file: row.name,
          message: `lineage cites evidence that does not exist: ${token}`,
        });
      }
    }
  }
  return findings;
}
