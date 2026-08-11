#!/usr/bin/env bun
// Local CI runner — the pre-remote safety net. Mirrors the GitHub Actions
// `ci` job (minus SARIF upload/artifacts, which only make sense on GitHub):
// typecheck → lint → knip → aislop gate → test → build, in order, with real
// exit codes. The first failing step stops the run.

import { spawnSync } from 'node:child_process';

const STEPS = [
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'lint', args: ['run', 'lint'] },
  { name: 'knip', args: ['run', 'knip'] },
  { name: 'aislop gate', args: ['run', 'check'] },
  { name: 'test', args: ['run', 'test'] },
  { name: 'build', args: ['run', 'build'] },
] as const;

for (const step of STEPS) {
  console.log(`\n=== ci: ${step.name} ===`);
  const result = spawnSync('bun', step.args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nci: FAILED at ${step.name} (exit ${result.status ?? 'signal'})`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nci: all steps passed');
