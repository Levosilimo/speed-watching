// Golden-master replay spec (the executable registry): every committed
// caption fixture — real truncations and the synthetic lanes — is re-parsed
// and re-measured, and the results must equal the committed registry rows
// (tests/fixtures/real/.snapshots/, see its README). The rows were authored
// once from the committed payloads + the recorded corpus; this spec never
// regenerates them. The cross-check section re-asserts, per fixture, the
// relations between the pinned numbers and the recorded full-payload
// metrics that hold under the truncation convention (20 events / 12
// windows).

import { describe, expect, it } from 'vitest';
import { parseYouTubeJson3 } from '../lib/captions';
import {
  computeLayout,
  computePins,
  loadRegistry,
  readFixtureJson,
  type RegistryRow,
} from './fixtures/registry';

const rows = loadRegistry();

function recorded(row: RegistryRow): Record<string, unknown> {
  return row.recorded?.fields ?? {};
}

describe('golden-master registry', () => {
  it('covers every committed fixture and no orphans', () => {
    const fixtures = [
      'asr-word.json',
      'manual-cue.json',
      'music.json',
      'windows-asr--rg9mV6DBl4-trunc.json',
      'windows-asr-Ks-_Mh1QhMc-trunc.json',
      'windows-asr-arj7oStGLkU-trunc.json',
      'windows-asr-iG9CE55wbtY-trunc.json',
      'pot-gated.json',
      'transcript-gated.json',
      'gapped.json',
      'chaptered.json',
    ];
    expect(rows.map((row) => row.fixture).sort()).toEqual([...fixtures].sort());
  });

  it('records provenance on every row', () => {
    for (const row of rows) {
      const p = row.provenance;
      expect(p.source).toMatch(/^(real|synthetic)$/);
      if (p.source === 'real') {
        expect(typeof p.videoId).toBe('string');
      }
      expect(p.captureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.captureMethod.length).toBeGreaterThan(10);
      expect(p.truncation).toContain('20 events');
    }
  });

  it('replays the byte-pinned parse output', () => {
    for (const row of rows) {
      const parsed = parseYouTubeJson3(readFixtureJson(row.fixture));
      expect(JSON.stringify(parsed), row.fixture).toBe(JSON.stringify(row.parse));
    }
  });

  it('replays the layout fingerprint', () => {
    for (const row of rows) {
      expect(computeLayout(readFixtureJson(row.fixture)), row.fixture).toEqual(row.layout);
    }
  });

  it('replays the derived semantic pins', () => {
    for (const row of rows) {
      const pins = computePins(
        parseYouTubeJson3(readFixtureJson(row.fixture)),
        row.kind,
      );
      expect(pins, row.fixture).toEqual(row.pins);
    }
  });

  it('keeps the tolerance inside the documented bands', () => {
    for (const row of rows) {
      expect(row.pins.tolerance.countsRel).toBeLessThanOrEqual(0.25);
      expect(row.pins.tolerance.ratesRel).toBeLessThanOrEqual(0.15);
    }
  });
});

// The recorded-truth cross-checks: relations between the fixture pins and
// the recorded full-payload metrics that hold under the truncation
// convention, derived from scripts/data/*.jsonl (the external truth) rather
// than from lib/.
describe('golden-master recorded-truth cross-checks', () => {
  it('never exceeds the recorded full-payload counts, tokens or span', () => {
    for (const row of rows) {
      const rec = recorded(row);
      if (rec.nCues === undefined && rec.fullDurationSec === undefined) continue;
      const { pins } = row;
      if (typeof rec.nCues === 'number') {
        expect(pins.cueCount, `${row.fixture} cueCount`).toBeLessThanOrEqual(rec.nCues);
      }
      if (typeof rec.nWordsTimed === 'number') {
        expect(pins.wordCount, `${row.fixture} wordCount`).toBeLessThanOrEqual(rec.nWordsTimed);
      }
      if (typeof rec.textTokens === 'number') {
        expect(pins.tokenCount, `${row.fixture} tokenCount`).toBeLessThanOrEqual(rec.textTokens);
      }
      if (typeof rec.spanSec === 'number' && pins.spanSec !== null) {
        expect(pins.spanSec, `${row.fixture} spanSec`).toBeLessThanOrEqual(rec.spanSec + 1e-9);
      }
      if (typeof rec.fullDurationSec === 'number' && pins.spanSec !== null) {
        expect(pins.spanSec, `${row.fixture} spanSec vs fullDurationSec`).toBeLessThanOrEqual(
          rec.fullDurationSec + 1e-9,
        );
      }
    }
  });

  it('derives the tier from the recorded track kind', () => {
    for (const row of rows) {
      const rec = recorded(row);
      const kind = rec.kind ?? row.kind;
      if (kind === 'asr') {
        expect(row.pins.tier, row.fixture).toBe(row.pins.wordCount >= 2 ? 'asr-word' : 'asr-cue');
      } else {
        expect(row.pins.tier, row.fixture).toBe('manual-cue');
      }
    }
  });

  it('keeps the pause-bias sign of the recorded run', () => {
    for (const row of rows) {
      const rec = recorded(row);
      if (typeof rec.pauseBiasPct !== 'number' || row.pins.pauseBiasPct === null) continue;
      expect(
        Math.sign(row.pins.pauseBiasPct),
        `${row.fixture} pauseBiasPct ${row.pins.pauseBiasPct} vs recorded ${rec.pauseBiasPct}`,
      ).toBe(Math.sign(rec.pauseBiasPct));
    }
  });

  it('clears the timing-coverage flag only when the recorded coverage is below the floor', () => {
    for (const row of rows) {
      const rec = recorded(row);
      if (typeof rec.coveragePct !== 'number' || row.pins.timingCoverageOk === null) continue;
      expect(row.pins.timingCoverageOk, `${row.fixture} coverage ${rec.coveragePct}`).toBe(
        rec.coveragePct >= 0.5,
      );
    }
  });

  it('pins the manual-cue rate against the recorded corrected cue rate', () => {
    for (const row of rows) {
      // Only the manual-cue tier measures its rate on the silence-corrected
      // speech duration — the same metric as the recorded cueWpmCorrected.
      if (row.pins.tier !== 'manual-cue') continue;
      const rec = recorded(row);
      if (typeof rec.cueWpmCorrected !== 'number' || row.pins.rates.manualCueRate === null) {
        continue;
      }
      const delta = Math.abs(row.pins.rates.manualCueRate - rec.cueWpmCorrected) / rec.cueWpmCorrected;
      expect(delta, `${row.fixture} manualCueRate vs recorded cueWpmCorrected`).toBeLessThanOrEqual(0.1);
    }
  });

  it('keeps the ru fixture parseable when the corpus classified it so', () => {
    const ru = rows.find((row) => row.fixture.includes('rg9mV6DBl4'));
    expect(ru).toBeDefined();
    const rec = recorded(ru!);
    expect(rec.classification).toBe('parse-available');
    expect(ru!.pins.wordCount).toBeGreaterThan(0);
  });
});
