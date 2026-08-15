#!/usr/bin/env bun
/**
 * audit-contract-not-count — advisory lane: assert observable outcomes, not
 * implementation counts (AGENTS.md: Contract, not count). The demand and
 * time-saved stores are the sanctioned count assertions.
 *
 * Flags every spyOn / toHaveBeenCalled* hit in tests/ for human
 * confirmation — the count is only a contract where the store exposes it.
 *
 * Exit 1 under LCE_STRICT_COUNT=1 when findings exist; advisory otherwise.
 * Paths on argv override the default test-file discovery under tests/.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanFinding {
  file: string;
  line?: number;
  message: string;
}

const COUNT = /\b(toHaveBeenCalledTimes|toHaveBeenCalledWith|toHaveBeenCalled|spyOn)\b/;

export function discoverTestFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.test.ts')) {
        files.push(full);
      }
    }
  };
  walk(join(root, 'tests'));
  return files.sort();
}

export function scanContractNotCount(files: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (COUNT.test(line)) {
        findings.push({ file, line: i + 1, message: line.trim() });
      }
    }
  }
  return findings;
}
