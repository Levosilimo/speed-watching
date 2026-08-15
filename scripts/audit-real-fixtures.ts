#!/usr/bin/env bun
/**
 * audit-real-fixtures — advisory lane: synthetic fixtures derive from a real
 * captured payload, not from invention (AGENTS.md: External truth; the
 * scripts/data results.jsonl oracle).
 *
 * Flags a fixture file when it contains neither a videoId recorded in any
 * scripts/data jsonl file nor a scripts/data reference — no traceable
 * provenance. Only fixture data files (*.json/*.vtt/*.srt) are considered.
 *
 * Exit 1 under LCE_STRICT_FIXTURES=1 when findings exist; advisory
 * otherwise. Paths on argv override the default tests/fixtures/synthetic
 * discovery.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanFinding {
  file: string;
  line?: number;
  message: string;
}

const FIXTURE_EXT = /\.(json|vtt|srt)$/;
const VIDEO_ID = /[A-Za-z0-9_-]{11}/g;
const RECORDED_ID = /"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g;
const DATA_REF = /scripts\/data|results\.jsonl/;

export function discoverSyntheticFixtures(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (FIXTURE_EXT.test(entry)) {
        files.push(full);
      }
    }
  };
  walk(join(root, 'tests', 'fixtures', 'synthetic'));
  return files.sort();
}

function recordedVideoIds(root: string): Set<string> {
  const ids = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.jsonl')) {
        for (const m of readFileSync(full, 'utf8').matchAll(RECORDED_ID)) ids.add(m[1]!);
      }
    }
  };
  walk(join(root, 'scripts', 'data'));
  return ids;
}

export function scanSyntheticFixtures(files: string[], root = process.cwd()): ScanFinding[] {
  const ids = recordedVideoIds(root);
  const findings: ScanFinding[] = [];
  for (const file of files) {
    if (!FIXTURE_EXT.test(file)) continue;
    const content = readFileSync(file, 'utf8');
    const hasRecordedId = [...content.matchAll(VIDEO_ID)].some((m) => ids.has(m[0]!));
    if (!hasRecordedId && !DATA_REF.test(content)) {
      findings.push({ file, message: 'no scripts/data videoId and no results.jsonl reference' });
    }
  }
  return findings;
}
