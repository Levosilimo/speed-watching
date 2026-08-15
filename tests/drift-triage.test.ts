// Spec lane for the drift-triage classifier (scripts/drift-triage.ts): the
// benign/breaking classification of a re-captured truncated payload against
// its golden-master registry row. The capture side is box-gated (real
// browser against real YouTube); this lane pins the pure classification
// contract — identical, benign (retiming/whitespace/comment edits within
// band), and every breaking class (shape change, tOffsetMs gone, windows
// layout flip, count shift beyond tolerance, tier regression, rate drift
// beyond band).

import { describe, expect, it } from 'vitest';
import { parseYouTubeJson3 } from '../lib/captions';
import { classifyFixture } from '../scripts/drift-triage';
import {
  computePins,
  loadRegistry,
  readFixtureJson,
  type RegistryRow,
} from './fixtures/registry';

function rowFor(fixture: string): RegistryRow {
  const row = loadRegistry().find((r) => r.fixture === fixture);
  if (row === undefined) throw new Error(`no registry row for ${fixture}`);
  return row;
}

/** Deep-mutate a parsed-back fixture: retiming shifts every event start by
 * `deltaMs`, and `edit` rewrites one seg's utf8. */
function mutatedPayload(
  row: RegistryRow,
  deltaMs: number,
  edit?: { event: number; seg: number; text: string },
): unknown {
  const raw = JSON.parse(JSON.stringify(readFixtureJson(row.fixture))) as {
    events: { tStartMs: number; segs?: { utf8: string }[] }[];
  };
  for (const event of raw.events) {
    event.tStartMs += deltaMs;
  }
  if (edit !== undefined) {
    const event = raw.events[edit.event];
    if (event === undefined || event.segs === undefined) {
      throw new Error('edit target out of range');
    }
    const seg = event.segs[edit.seg];
    if (seg === undefined) throw new Error('edit target out of range');
    seg.utf8 = edit.text;
  }
  return raw;
}

describe('drift-triage classifier', () => {
  it('classifies the committed payload itself as identical', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    const diff = classifyFixture(row, readFixtureJson(row.fixture), row.kind);
    expect(diff.verdict).toBe('identical');
    expect(diff.reasons).toEqual([]);
  });

  it('treats pure retiming as benign', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    const diff = classifyFixture(row, mutatedPayload(row, 50), row.kind);
    expect(diff.verdict).toBe('benign');
    expect(diff.reasons).toEqual([]);
  });

  it('treats whitespace and comment edits as benign', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    // Timed segs only: the fixture's first "good" seg is untimed (no
    // tOffsetMs) and dropped by the parser, so an edit there would not
    // change the parse. " morning" (event 3 seg 1) is timed.
    const whitespace = classifyFixture(row, mutatedPayload(row, 0, { event: 3, seg: 1, text: ' morning ' }), row.kind);
    expect(whitespace.verdict).toBe('benign');
    // A comment-edit that changes the marker text: bracket markers stay
    // filtered from the token counts, so the rates hold.
    const comment = classifyFixture(row, mutatedPayload(row, 0, { event: 1, seg: 0, text: '[Applause]' }), row.kind);
    expect(comment.verdict).toBe('benign');
  });

  it('breaks when per-seg tOffsetMs disappears', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    const raw = JSON.parse(JSON.stringify(readFixtureJson(row.fixture))) as {
      events: { segs?: { tOffsetMs?: number }[] }[];
    };
    for (const event of raw.events) {
      for (const seg of event.segs ?? []) delete seg.tOffsetMs;
    }
    const diff = classifyFixture(row, raw, row.kind);
    expect(diff.verdict).toBe('breaking');
    expect(diff.reasons.join('; ')).toContain('tOffsetMs gone');
  });

  it('breaks when the windows layout appears', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    const raw = JSON.parse(JSON.stringify(readFixtureJson(row.fixture))) as { windows?: unknown[] };
    raw.windows = [{ text: 'word-timed window', startMs: 0, durMs: 1000 }];
    const diff = classifyFixture(row, raw, row.kind);
    expect(diff.verdict).toBe('breaking');
    expect(diff.reasons.join('; ')).toContain('windows layout appeared');
  });

  it('breaks when a cue count shifts beyond the tolerance', () => {
    const row = rowFor('manual-cue.json');
    const raw = JSON.parse(JSON.stringify(readFixtureJson(row.fixture))) as {
      events: { tStartMs: number; dDurationMs: number; segs: { utf8: string }[] }[];
    };
    // A full extra event with 9 segs pushes the cue count 20 -> 21, over
    // max(1, round(20 * 0.25)) = 5? No — one cue is inside the tolerance,
    // so clone the whole event list instead: 20 -> 40 cues.
    raw.events.push(...JSON.parse(JSON.stringify(raw.events)));
    const diff = classifyFixture(row, raw, row.kind);
    expect(diff.verdict).toBe('breaking');
    expect(diff.reasons.join('; ')).toContain('cue count shift beyond tolerance');
  });

  it('breaks when the tier regresses', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    // The same payload measured as a manual track (no ASR on the page).
    const diff = classifyFixture(row, readFixtureJson(row.fixture), null);
    expect(diff.verdict).toBe('breaking');
    expect(diff.reasons.join('; ')).toContain('tier regressed');
  });

  it('breaks when a rate drifts beyond the band', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    // Halve every gap: double all event starts. The span halves, the
    // unified rate roughly doubles — far past the 15% band.
    const raw = JSON.parse(JSON.stringify(readFixtureJson(row.fixture))) as {
      events: { tStartMs: number }[];
    };
    for (const event of raw.events) event.tStartMs *= 2;
    const diff = classifyFixture(row, raw, row.kind);
    expect(diff.verdict).toBe('breaking');
    expect(diff.reasons.join('; ')).toContain('rate drift beyond band');
  });

  it('keeps count shifts within the tolerance benign', () => {
    const row = rowFor('manual-cue.json');
    const raw = JSON.parse(JSON.stringify(readFixtureJson(row.fixture))) as {
      events: { tStartMs: number; dDurationMs: number; segs: { utf8: string }[] }[];
    };
    raw.events.push({ tStartMs: 60000, dDurationMs: 1200, segs: [{ utf8: 'one more cue' }] });
    const diff = classifyFixture(row, raw, row.kind);
    expect(diff.verdict).toBe('benign');
  });

  it('reports the re-captured pins for the breaking summary', () => {
    const row = rowFor('windows-asr-iG9CE55wbtY-trunc.json');
    const raw = JSON.parse(JSON.stringify(readFixtureJson(row.fixture))) as {
      events: { tStartMs: number }[];
    };
    for (const event of raw.events) event.tStartMs *= 2;
    const diff = classifyFixture(row, raw, row.kind);
    expect(diff.pins).toEqual(computePins(parseYouTubeJson3(raw), row.kind));
  });
});
