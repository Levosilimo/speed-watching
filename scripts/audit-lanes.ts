#!/usr/bin/env bun
/**
 * audit-lanes — the advisory lanes dispatcher (AGENTS.md: Testing lanes).
 *
 * Runs the three advisory scans over the repo test globs, logs [WARN] per
 * finding, and exits 0 unless the matching strict flag is set:
 *   LCE_STRICT_MIRROR=1 / LCE_STRICT_COUNT=1 / LCE_STRICT_FIXTURES=1
 * Paths on argv override every scan's default scope (the audit specs pass
 * their corpus this way).
 *
 * Usage in lefthook.yml:
 *   audit-lanes:
 *     run: bun run scripts/audit-lanes.ts
 */

import { resolve } from 'node:path';
import type { ScanFinding } from './audit-contract-not-count.ts';
import { scanContractNotCount, discoverTestFiles as discoverCountFiles } from './audit-contract-not-count.ts';
import { scanMirrorScan, discoverTestFiles as discoverMirrorFiles } from './audit-mirror-scan.ts';
import { scanSyntheticFixtures, discoverSyntheticFixtures } from './audit-real-fixtures.ts';

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const root = process.cwd();
  const paths = argv.map((p) => resolve(root, p));
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
      console.warn(`[audit-lanes] ${lane.name}: ${lane.findings.length} finding(s)`);
      if (env[lane.strictVar] === '1') {
        console.error(`[audit-lanes] ${lane.strictVar}=1: ${lane.findings.length} finding(s) must be resolved`);
        failed = true;
      }
    }
  }
  if (failed) return 1;
  if (total === 0) console.log('[audit-lanes] all advisory lanes clean');
  else console.warn('[audit-lanes] advisory findings above — set LCE_STRICT_*=1 to fail on them');
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), process.env));
}
