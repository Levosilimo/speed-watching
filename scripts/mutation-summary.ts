#!/usr/bin/env bun
// Mutation survivor summary for the nightly breach issue (wave 5): parses
// the stryker json report and prints a per-file survivor count table plus
// the total. The nightly workflow pipes this into the issue body when the
// tripwire fires; a human reads the HTML report for the full list.

import { readFileSync } from 'node:fs';

interface Mutant {
  mutatorName: string;
  status: string;
  location: { start: { line: number } };
}

const reportPath = 'reports/mutation/mutation.json';
let report: { files: Record<string, { mutants: Mutant[] }> };
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch {
  console.error(`mutation summary: no parseable ${reportPath} — run the mutation suite first`);
  process.exit(1);
}

const rows: string[] = ['| File | Survived |', '|------|--------:|'];
let total = 0;
for (const [file, info] of Object.entries(report.files)) {
  const survived = info.mutants.filter((m) => m.status === 'Survived').length;
  total += survived;
  rows.push(`| ${file.replace('lib/', '')} | ${survived} |`);
}
rows.push(`| **Total** | **${total}** |`);
console.log(rows.join('\n'));
