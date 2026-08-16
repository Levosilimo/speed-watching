import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.ts';

/**
 * Config-pin lane: the quality gates' own thresholds and wiring are
 * contract, not implementation detail. A PR that silently lowers the
 * coverage floors, the mutation break, the mutate scope, or that unbinds
 * the audit lanes from CI, must trip here — the gates protect the rate
 * math, so the gates' own strength is pinned.
 */

const COVERAGE_FLOORS = { statements: 90, lines: 90, functions: 90, branches: 85 };
const STRYKER_BREAK_FLOOR = 65;

// The config's coverage type is a provider union; the v8 branch (the one
// this repo configures) carries the gate fields, so narrow on presence.
const testConfig = vitestConfig.test;
const coverage = testConfig?.coverage;
if (coverage === undefined) {
  throw new Error('vitest.config.ts must define the coverage gate');
}
if (!('thresholds' in coverage) || !('include' in coverage) || coverage.thresholds === undefined) {
  throw new Error('vitest.config.ts must define coverage.thresholds and coverage.include');
}
const coverageThresholds = coverage.thresholds;
const stryker = JSON.parse(readFileSync('stryker.conf.json', 'utf8')) as {
  mutate: string[];
  thresholds: { high: number; low: number; break: number };
};
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const runCi = readFileSync('scripts/run-ci.ts', 'utf8');

describe('vitest coverage config', () => {
  it('keeps the aggregate thresholds at or above the documented floors', () => {
    expect(coverageThresholds.statements, 'statements floor').toBeGreaterThanOrEqual(COVERAGE_FLOORS.statements);
    expect(coverageThresholds.lines, 'lines floor').toBeGreaterThanOrEqual(COVERAGE_FLOORS.lines);
    expect(coverageThresholds.functions, 'functions floor').toBeGreaterThanOrEqual(COVERAGE_FLOORS.functions);
    expect(coverageThresholds.branches, 'branches floor').toBeGreaterThanOrEqual(COVERAGE_FLOORS.branches);
  });

  it('enforces the floors per file, not only in aggregate', () => {
    expect(coverageThresholds.perFile).toBe(true);
  });

  it('keeps the coverage gate scoped to the critical libs', () => {
    expect(coverage.include).toEqual([
      'lib/wpm.ts',
      'lib/tokenizer.ts',
      'lib/captions.ts',
      'lib/languages.ts',
      'lib/recommend.ts',
      'lib/caption-fetch.ts',
      'lib/caption-trigger.ts',
      'lib/transcript.ts',
      'lib/matcher.ts',
      'lib/rate-controller.ts',
      'lib/demand.ts',
      'lib/time-saved.ts',
      'lib/chapters.ts',
      'lib/chapter-scheduler.ts',
      'lib/skip-silence.ts',
      'lib/error-journal.ts',
      'lib/nudge.ts',
      'lib/channel-memory.ts',
      'lib/caption-capture.ts',
    ]);
  });
});

describe('stryker mutation config', () => {
  it('keeps the break threshold at or above the documented floor', () => {
    expect(stryker.thresholds.break).toBeGreaterThanOrEqual(STRYKER_BREAK_FLOOR);
  });

  it('keeps the high threshold at or above the break threshold', () => {
    expect(stryker.thresholds.high).toBeGreaterThanOrEqual(stryker.thresholds.break);
  });

  it('keeps every coverage-gated lib in the mutate list', () => {
    // The mutate scope must not shrink below the coverage gate's scope: a
    // lib the coverage gate guards must stay mutation-gated too.
    for (const lib of coverage.include ?? []) {
      expect(stryker.mutate, `mutate must cover ${lib}`).toContain(lib);
    }
  });
});

describe('gate wiring', () => {
  it('runs the audit-lanes gate in ci.yml and the local CI runner', () => {
    expect(ci).toContain('bun run scripts/audit-lanes.ts');
    expect(runCi).toContain('scripts/audit-lanes.ts');
  });

  it('builds the userscript before the vitest run in ci.yml', () => {
    // The bundle test is fail-closed; a reordered workflow would run the
    // suite against a missing bundle.
    const buildStep = ci.indexOf('bun run build:userscript');
    const testStep = ci.indexOf('bun run test');
    expect(buildStep).toBeGreaterThanOrEqual(0);
    expect(testStep).toBeGreaterThan(buildStep);
  });

  it('keeps the ci script bound to the local runner', () => {
    expect(pkg.scripts.ci).toBe('bun run scripts/run-ci.ts');
  });

  it('fetches full history in the ci job — commit-hash evidence needs it', () => {
    // verifyEvidence resolves hash citations with git rev-parse; a shallow
    // checkout cannot see the cited commits, so the lineage gate flags
    // every hash citation (the audit-corpus lanes prove the seam).
    const ciJob = ci.slice(ci.indexOf('  ci:'), ci.indexOf('  codeql:'));
    const checkout = ciJob.indexOf('actions/checkout');
    const checkoutStep = ciJob.slice(checkout, checkout + 200);
    expect(checkoutStep).toContain('fetch-depth: 0');
  });
});
