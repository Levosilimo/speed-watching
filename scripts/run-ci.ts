#!/usr/bin/env bun
// Local CI runner — the pre-remote safety net. Mirrors the GitHub Actions
// `ci` job (minus SARIF upload/artifacts, which only make sense on GitHub):
// lint → typecheck → knip → aislop gate → build:userscript → test (incl.
// the fail-closed bundle gate) → audit-disabled gate → audit lanes
// (fixture provenance gate) → build → mpv tests, in order, with real exit
// codes. The first failing
// step stops the run. The mpv step is optional — it needs a lua5.1 or luajit
// binary, which CI installs but local machines may not have; without one it
// prints a skip note and continues.
//
// The mutation suite deliberately has NO step here: it is the nightly's job
// (.github/workflows/nightly.yml), not the pre-remote safety net's. A fresh
// clone pays a 60s+ instrumented run that the local mirror would repeat on
// every `bun run ci`; the mirror stays under a minute and the tripwire stays
// scheduled (docs/testing-methodology.md → Stryker tripwire). Run it ad hoc
// with `bun run mutation`.

import { spawnSync } from 'node:child_process';

type Step = {
  name: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  optional?: boolean;
};

const STEPS: Step[] = [
  { name: 'lint', args: ['run', 'lint'] },
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'knip', args: ['run', 'knip'] },
  { name: 'aislop gate', args: ['run', 'check'] },
  // The bundle gate is fail-closed, so the userscript must be built first.
  { name: 'build:userscript', args: ['run', 'build:userscript'] },
  { name: 'test', args: ['run', 'test'] },
  { name: 'audit-disabled', args: ['run', 'scripts/audit-disabled-assertions.ts'] },
  { name: 'audit lanes (fixture provenance gate)', args: ['run', 'scripts/audit-lanes.ts'] },
  { name: 'build', args: ['run', 'build'] },
  { name: 'mpv tests', args: ['run', 'test:mpv'], optional: true },
];

function hasLua(): boolean {
  const probe = spawnSync('sh', [
    '-c',
    'command -v lua5.1 >/dev/null 2>&1 || command -v luajit >/dev/null 2>&1',
  ]);
  return probe.status === 0;
}

for (const step of STEPS) {
  console.log(`\n=== ci: ${step.name} ===`);
  if (step.optional && !hasLua()) {
    console.log(`ci: skipping ${step.name} (lua5.1/luajit not on PATH)`);
    continue;
  }
  const result = spawnSync('bun', step.args, {
    stdio: 'inherit',
    env: step.env ? { ...process.env, ...step.env } : process.env,
  });
  if (result.status !== 0) {
    console.error(`\nci: FAILED at ${step.name} (exit ${result.status ?? 'signal'})`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nci: all steps passed');
