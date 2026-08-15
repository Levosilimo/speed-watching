#!/usr/bin/env bun
/**
 * audit-disabled-assertions — hard gate over disabled test assertions.
 *
 * Scans the test globs (tests and e2e: *.test.ts, *.spec.ts) for:
 *   - skipped/todo assertions: it|describe|test|spec .skip/.todo, xit, xdescribe
 *   - runtime conditionals: .skipIf/.runIf — a conditional disable is still
 *     a disable: the test silently stops running when the condition flips
 *   - .only(): narrows the suite, hiding every other test
 *   - the { skip: true } object form
 *   - happy-dom holes: "cannot/can't" or "skipped/unsupported/not supported"
 *     tied to happy-dom on the same line — comments that excuse a missing
 *     assertion instead of making it
 * Every hit prints file:line with the offending line; any hit exits 1.
 * Paths on argv override the default globs (the audit specs scan their
 * corpus this way; the corpus files are not test globs, so the gate never
 * flags its own samples).
 *
 * Usage in lefthook.yml:
 *   audit-disabled:
 *     run: bun run scripts/audit-disabled-assertions.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ScanFinding {
  file: string;
  line?: number;
  message: string;
}

const SKIP_OR_TODO = /\b(it|describe|test|spec)\.(skip|todo)\b/;
const RUNTIME_CONDITIONAL = /\b(it|describe|test|spec)\.(skipIf|runIf)\b/;
const ONLY = /\b(it|describe|test|spec)\.only\s*\(/;
const SKIP_OBJECT = /\bskip\s*:\s*true\b/;
const XIT = /^\s*(xit|xdescribe)\b/;
const HAPPY_DOM_HOLE = /happy-dom[^\n]{0,100}\b(cannot|can't|skipped|unsupported|not supported)\b/i;

export function discoverTestFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(test|spec)\.ts$/.test(entry)) {
        files.push(full);
      }
    }
  };
  walk(join(root, 'tests'));
  walk(join(root, 'e2e'));
  return files.sort();
}

export function scanDisabledAssertions(files: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (
        SKIP_OR_TODO.test(line) ||
        RUNTIME_CONDITIONAL.test(line) ||
        ONLY.test(line) ||
        SKIP_OBJECT.test(line) ||
        XIT.test(line) ||
        HAPPY_DOM_HOLE.test(line)
      ) {
        findings.push({ file, line: i + 1, message: line.trim() });
      }
    }
  }
  return findings;
}

export function main(argv: string[]): number {
  const files = argv.length > 0 ? argv.map((p) => resolve(p)) : discoverTestFiles(process.cwd());
  const findings = scanDisabledAssertions(files);
  for (const f of findings) {
    console.error(`[audit-disabled] ${f.file}:${f.line} ${f.message}`);
  }
  if (findings.length > 0) {
    console.error(`[audit-disabled] ${findings.length} disabled assertion(s) — commit blocked`);
    return 1;
  }
  console.log('[audit-disabled] no disabled assertions');
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
