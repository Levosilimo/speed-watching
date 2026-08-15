// Golden-master registry: committed per-fixture rows under
// tests/fixtures/real/.snapshots/ (one JSON per fixture) pinning the FULL
// parse output of every committed caption fixture plus the derived semantic
// pins. Shared by the replay spec (tests/golden-master.test.ts) and the
// drift-triage runner (scripts/drift-triage.ts) so both consume the same row
// shape and the same pin computation.
//
// The rows are authored once per verified capture from the committed
// payloads + the recorded corpus rates (scripts/data/*.jsonl — the external
// truth); nothing here regenerates them.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedCaptions, Segment } from '../../lib/captions';
import type { RateTier } from '../../lib/recommend';
import {
  asrTierInputs,
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  speechDurationSec,
  unitTokens,
  wordLevelWpm,
} from '../../lib/wpm';

export interface RegistryProvenance {
  source: 'real' | 'synthetic';
  videoId: string | null;
  captureDate: string;
  captureMethod: string;
  truncation: string;
  backs: string;
  notes: string[];
}

/** Structural fingerprint of the raw payload: top-level events/windows
 * counts, event segs carrying a numeric tOffsetMs, top-level windows
 * carrying direct text. The drift runner's "windows layout
 * appears/disappears" and "tOffsetMs gone" classes diff this. */
export interface RegistryLayout {
  events: number;
  windows: number;
  segOffsets: number;
  windowTexts: number;
}

export interface RegistryRates {
  wordLevelWpm: number | null;
  cueLevelWpm: number | null;
  correctedCueLevelWpm: number | null;
  manualCueRate: number | null;
  unifiedWpm: number | null;
  articulatoryWpm: number | null;
}

export interface RegistryTolerance {
  countsRel: number;
  ratesRel: number;
}

export interface RegistryPins {
  tier: RateTier;
  wordCount: number;
  cueCount: number;
  tokenCount: number;
  spanSec: number | null;
  speechDurationSec: number | null;
  pauseBiasPct: number | null;
  timingCoverageOk: boolean | null;
  rates: RegistryRates;
  tolerance: RegistryTolerance;
}

export interface RegistryRow {
  fixture: string;
  provenance: RegistryProvenance;
  layout: RegistryLayout;
  /** Track kind feeding asrTierInputs: the recorded corpus kind for real
   * fixtures, the e2e fixture contract (KIND_BY_FIXTURE) for synthetic. */
  kind: string | null;
  /** Full parse output, byte-pinned. */
  parse: ParsedCaptions;
  pins: RegistryPins;
  /** Recorded full-payload metrics from scripts/data/*.jsonl for the same
   * videoId — the external-truth anchor the pins were verified against. */
  recorded: { sourceFiles: string[]; fields: Record<string, unknown> } | null;
}

const snapshotsDir = fileURLToPath(new URL('./real/.snapshots/', import.meta.url));

/** One row per committed fixture, sorted by fixture name. */
export function loadRegistry(): RegistryRow[] {
  return readdirSync(snapshotsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(snapshotsDir, file), 'utf8')) as RegistryRow);
}

export function readFixtureJson(fixture: string): unknown {
  const dir = fixture.startsWith('windows-') ||
    fixture === 'asr-word.json' ||
    fixture === 'manual-cue.json' ||
    fixture === 'music.json'
    ? 'real'
    : 'synthetic';
  const root = fileURLToPath(new URL('../', import.meta.url));
  return JSON.parse(readFileSync(join(root, 'fixtures', dir, fixture), 'utf8')) as unknown;
}

export function computeLayout(raw: unknown): RegistryLayout {
  if (typeof raw !== 'object' || raw === null) {
    return { events: 0, windows: 0, segOffsets: 0, windowTexts: 0 };
  }
  const record = raw as Record<string, unknown>;
  const events = Array.isArray(record.events) ? record.events : [];
  const windows = Array.isArray(record.windows) ? record.windows : [];
  let segOffsets = 0;
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const segs = (event as Record<string, unknown>).segs;
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      if (
        typeof seg === 'object' &&
        seg !== null &&
        typeof (seg as Record<string, unknown>).tOffsetMs === 'number'
      ) {
        segOffsets += 1;
      }
    }
  }
  let windowTexts = 0;
  for (const window of windows) {
    if (
      typeof window === 'object' &&
      window !== null &&
      typeof (window as Record<string, unknown>).text === 'string'
    ) {
      windowTexts += 1;
    }
  }
  return { events: events.length, windows: windows.length, segOffsets, windowTexts };
}

function spanSec(cues: readonly Segment[]): number | null {
  const first = cues[0];
  const last = cues.at(-1);
  if (first === undefined || last === undefined) return null;
  const span = last.startSec + (last.durSec ?? 0) - first.startSec;
  return span > 0 ? span : null;
}

/** The derived semantic pins: the same computation the registry rows were
 * authored with, shared by the replay spec and the drift-triage runner. */
export function computePins(parsed: ParsedCaptions, kind: string | null): RegistryPins {
  const { words, cues } = parsed;
  const tierInputs = asrTierInputs(kind ?? undefined, words, cues);
  const unified = filteredTokensOverTrimmedSpan(cues);
  const articulatory = tierInputs.wordInputs?.articulatoryWpm ?? null;
  const span = spanSec(cues);
  return {
    tier: tierInputs.tier,
    wordCount: words.length,
    cueCount: cues.length,
    tokenCount: cues.reduce((sum, cue) => sum + unitTokens(cue.text, undefined), 0),
    spanSec: span,
    speechDurationSec: speechDurationSec(words),
    pauseBiasPct:
      unified !== null && articulatory !== null ? ((unified - articulatory) / unified) * 100 : null,
    timingCoverageOk: tierInputs.wordInputs?.timingCoverageOk ?? null,
    rates: {
      wordLevelWpm: wordLevelWpm(words),
      cueLevelWpm: cueLevelWpm(cues),
      correctedCueLevelWpm: correctedCueLevelWpm(cues),
      manualCueRate: manualCueRate(cues),
      unifiedWpm: unified,
      articulatoryWpm: articulatory,
    },
    tolerance: { countsRel: 0.25, ratesRel: 0.15 },
  };
}
