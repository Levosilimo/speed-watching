#!/usr/bin/env bun
/**
 * audit-lanes — the advisory lanes dispatcher (AGENTS.md: Testing lanes).
 *
 * Runs the three advisory scans over the repo test globs and logs [WARN] per
 * finding. Under the matching strict flag (LCE_STRICT_MIRROR=1 /
 * LCE_STRICT_COUNT=1 / LCE_STRICT_FIXTURES=1) findings NOT recorded in the
 * accepted baseline (scripts/data/audit-lanes-baseline.jsonl) fail the run:
 * the baseline is the human-confirmed backlog (the methodology's "so a human
 * confirms each one"), so enforcement is over NEW findings, not the accepted
 * ones. Paths on argv override every scan's default scope (the audit specs
 * pass their corpus this way).
 *
 * `--write-baseline` regenerates the baseline from the current tree and
 * exits 0 — the human checkpoint is reviewing that diff in the PR.
 *
 * Usage in lefthook.yml:
 *   audit-lanes:
 *     run: bun run scripts/audit-lanes.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { ScanFinding } from './audit-contract-not-count.ts';
import { scanContractNotCount, discoverTestFiles as discoverCountFiles } from './audit-contract-not-count.ts';
import { scanMirrorScan, discoverTestFiles as discoverMirrorFiles } from './audit-mirror-scan.ts';
import { scanSyntheticFixtures, discoverSyntheticFixtures } from './audit-real-fixtures.ts';

export interface BaselineEntry {
  file: string;
  message: string;
}

function baselinePath(root: string): string {
  return resolve(root, 'scripts', 'data', 'audit-lanes-baseline.jsonl');
}

/** Machine-independent key: cwd-relative file plus the message with the
 * cwd prefix stripped (mirror findings embed the lib path in the message). */
export function baselineKey(root: string, finding: ScanFinding): string {
  return JSON.stringify({
    file: relative(root, finding.file),
    message: finding.message.replaceAll(`${root}${sep}`, ''),
  });
}

export function loadBaseline(root: string): Set<string> {
  const path = baselinePath(root);
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = JSON.parse(trimmed) as BaselineEntry;
    keys.add(JSON.stringify(entry));
  }
  return keys;
}

function writeBaseline(root: string): void {
  const findings = [
    ...scanMirrorScan(discoverMirrorFiles(root)),
    ...scanContractNotCount(discoverCountFiles(root)),
    ...scanSyntheticFixtures(discoverSyntheticFixtures(root), root),
  ];
  const keys = [...new Set(findings.map((f) => baselineKey(root, f)))].sort();
  const lines = keys.map((key) => {
    const entry = JSON.parse(key) as BaselineEntry;
    return JSON.stringify(entry);
  });
  writeFileSync(baselinePath(root), `${lines.join('\n')}\n`);
  console.log(`[audit-lanes] baseline written: ${lines.length} finding(s)`);
}

export function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  baseline: ReadonlySet<string> = loadBaseline(process.cwd()),
): number {
  const root = process.cwd();
  if (argv.includes('--write-baseline')) {
    writeBaseline(root);
    return 0;
  }
  const paths = argv.filter((p) => p !== '--write-baseline').map((p) => resolve(root, p));
  const overridden = paths.length > 0;
  const lanes = [
    {
      name: 'mirror',
      strictVar: 'LCE_STRICT_MIRROR' as const,
      findings: scanMirrorScan(overridden ? paths : discoverMirrorFiles(root)),
    },
    {
      name: 'contract-not-count',
      strictVar: 'LCE_STRICT_COUNT' as const,
      findings: scanContractNotCount(overridden ? paths : discoverCountFiles(root)),
    },
    {
      name: 'real-fixtures',
      strictVar: 'LCE_STRICT_FIXTURES' as const,
      findings: scanSyntheticFixtures(overridden ? paths : discoverSyntheticFixtures(root), root),
    },
  ];

  let failed = false;
  let total = 0;
  for (const lane of lanes) {
    total += lane.findings.length;
    for (const f of lane.findings as ScanFinding[]) {
      console.warn(`[WARN] audit-${lane.name}: ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`);
    }
    if (lane.findings.length > 0) {
      const fresh = lane.findings.filter((f) => !baseline.has(baselineKey(root, f)));
      console.warn(
        `[audit-lanes] ${lane.name}: ${lane.findings.length} finding(s)` +
          (fresh.length > 0 ? `, ${fresh.length} outside the baseline` : ''),
      );
      if (env[lane.strictVar] === '1' && fresh.length > 0) {
        console.error(
          `[audit-lanes] ${lane.strictVar}=1: ${fresh.length} finding(s) outside the baseline must be resolved or reviewed into it`,
        );
        failed = true;
      }
    }
  }
  if (failed) return 1;
  if (total === 0) console.log('[audit-lanes] all advisory lanes clean');
  else console.warn('[audit-lanes] findings above are baseline-accepted; LCE_STRICT_*=1 fails only on new ones');
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), process.env));
}
