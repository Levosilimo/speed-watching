// Spec lane for the real-site runner verdict — the release gate's bar
// machinery. Spec: docs/release-gate.md §0.5 (signed-in lane), §2 (pass
// ratio + the per-class floor), §4 (the fix-on-repeat rule). Fixture: the
// real scripts/data/realsite-run/results.jsonl history (the oracle — the
// only non-LLM artifact), never regenerated from the implementation.
//
// Gates pinned here:
//   - per-class floor: the speech class (the product's core) must hold ≥
//     the threshold separately; the overall ratio is the secondary bar.
//     A run failing the floor exits with the distinct speech-floor code
//     and the verdict names the class.
//   - fix-on-repeat: a video failing with the same classification in the
//     last N=2 runs forces a fix — the run exits with the distinct
//     repeat code regardless of the ratio. --ignore-repeats is the
//     documented re-verification escape.
//   - signed-in lane: a --profile run that recorded signedIn=false is a
//     lane failure (exit code 5), not a video failure; the anonymous
//     (no-profile) lane is unaffected.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateVerdict,
  parseRunHistory,
  previousRuns,
  VERDICT_EXIT,
  type VerdictConfig,
} from '../scripts/realsite-verdict';
import type { RealsiteRecord, VideoKind } from '../scripts/realsite-runner-lib';

const HISTORY_FIXTURE = fileURLToPath(new URL('./fixtures/realsite-run-history.jsonl', import.meta.url));
const HISTORY_TEXT = readFileSync(HISTORY_FIXTURE, 'utf8');

/** The oracle's 40 records chunked into 4 runs of 10 — the corpus order
 * (the runner's DEFAULT_VIDEOS: 10 videos per box run). */
const historyRuns = (): RealsiteRecord[][] => {
  const records = HISTORY_TEXT.trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RealsiteRecord);
  const runs: RealsiteRecord[][] = [];
  for (let i = 0; i < records.length; i += 10) runs.push(records.slice(i, i + 10));
  return runs;
};

/** A record for the verdict gates; only the fields the gates read matter. */
function rec(
  videoId: string,
  kind: VideoKind,
  opts: { pass?: boolean; reason?: string | null; signedIn?: boolean } = {},
): RealsiteRecord {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    category: 'fixture',
    kind,
    title: null,
    signedIn: opts.signedIn ?? true,
    pillRendered: true,
    mode: 'recommend',
    tier: null,
    rate: 150,
    lang: null,
    source: 'web',
    measure: null,
    pillRect: null,
    playerRect: null,
    pillInsidePlayer: true,
    clearsControls: true,
    occludedAtCenter: false,
    consoleLines: [],
    tracePath: null,
    rateDiff: null,
    pass: opts.pass ?? false,
    reason: opts.reason ?? null,
  };
}

const cfg = (overrides: Partial<VerdictConfig> = {}): VerdictConfig => ({
  threshold: 0.8,
  speechThreshold: 0.8,
  signedInLane: false,
  ignoreRepeats: false,
  repeatLookbackRuns: 2,
  ...overrides,
});

const speech = (videoId: string, pass: boolean): RealsiteRecord =>
  rec(videoId, 'speech', { pass, reason: pass ? null : 'caption source=none; rate=n/a outside 100-600' });

/** The audit's boundary case: 5/7 speech + 3/3 non-speech = 80% overall
 * with the product's core class at 71%. */
const boundaryRun = (): RealsiteRecord[] => [
  speech('v01', true), speech('v02', true), speech('v03', true), speech('v04', true), speech('v05', true),
  speech('v06', false), speech('v07', false),
  rec('v08', 'music', { pass: true }),
  rec('v09', 'live', { pass: true }),
  rec('v10', 'live', { pass: true }),
];

describe('run history parsing', () => {
  it('the real 40-record oracle parses as one legacy run', () => {
    const runs = parseRunHistory(HISTORY_TEXT);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(40);
  });

  it('markers delimit runs; the trailing group is the current run', () => {
    const text = [
      JSON.stringify({ runStart: '2026-08-01T00:00:00.000Z' }),
      JSON.stringify(rec('a', 'speech', { pass: true })),
      JSON.stringify(rec('b', 'speech', { pass: true })),
      JSON.stringify(rec('c', 'speech', { pass: true })),
      JSON.stringify({ runStart: '2026-08-08T00:00:00.000Z' }),
      JSON.stringify(rec('d', 'speech', { pass: true })),
      JSON.stringify(rec('e', 'speech', { pass: true })),
    ].join('\n');
    const runs = parseRunHistory(text);
    expect(runs.map((run) => run.map((r) => r.videoId))).toEqual([['a', 'b', 'c'], ['d', 'e']]);
    // previousRuns drops the trailing group — the run being judged.
    expect(previousRuns(text).map((run) => run.map((r) => r.videoId))).toEqual([['a', 'b', 'c']]);
  });

  it('marker-less leading records form the legacy first run', () => {
    const text = [
      JSON.stringify(rec('a', 'speech', { pass: true })),
      JSON.stringify({ runStart: '2026-08-01T00:00:00.000Z' }),
      JSON.stringify(rec('b', 'speech', { pass: true })),
    ].join('\n');
    expect(parseRunHistory(text).map((run) => run.length)).toEqual([1, 1]);
  });

  it('a torn line is skipped without splitting the run', () => {
    const text = [
      JSON.stringify(rec('a', 'speech', { pass: true })),
      '{"videoId":"b","ur',
      JSON.stringify(rec('c', 'speech', { pass: true })),
    ].join('\n');
    const runs = parseRunHistory(text);
    expect(runs).toHaveLength(1);
    expect(runs[0].map((r) => r.videoId)).toEqual(['a', 'c']);
  });
});

describe('per-class speech floor', () => {
  it('80% overall with speech at 5/7 fails with the distinct code and names the class', () => {
    const verdict = evaluateVerdict(boundaryRun(), [], cfg());
    expect(verdict.code).toBe(VERDICT_EXIT.SPEECH_FLOOR);
    expect(verdict.speechRatio).toBeCloseTo(5 / 7);
    expect(verdict.line).toContain('speech');
  });

  it('speech at the floor and overall above it passes', () => {
    const current = [
      ...['v01', 'v02', 'v03', 'v04', 'v05', 'v06'].map((id) => speech(id, true)),
      speech('v07', false),
      rec('v08', 'music', { pass: true }),
      rec('v09', 'live', { pass: true }),
      rec('v10', 'live', { pass: true }),
    ];
    expect(evaluateVerdict(current, [], cfg()).code).toBe(VERDICT_EXIT.PASS);
  });

  it('speech at the floor but overall below the threshold fails on the ratio, not the class', () => {
    const current = [
      ...['v01', 'v02', 'v03', 'v04', 'v05', 'v06'].map((id) => speech(id, true)),
      speech('v07', false),
      rec('v08', 'music', { pass: false, reason: 'music suppression: mode=recommend' }),
      rec('v09', 'live', { pass: false, reason: 'live suppression: mode=recommend' }),
      rec('v10', 'live', { pass: false, reason: 'live suppression: mode=recommend' }),
    ];
    const verdict = evaluateVerdict(current, [], cfg());
    expect(verdict.code).toBe(VERDICT_EXIT.RATIO);
    expect(verdict.speechRatio).toBeGreaterThanOrEqual(0.8);
  });

  it('a run without speech records skips the floor', () => {
    const current = [
      rec('v08', 'music', { pass: true }),
      rec('v09', 'live', { pass: true }),
    ];
    expect(evaluateVerdict(current, [], cfg()).code).toBe(VERDICT_EXIT.PASS);
  });

  it('--speech-threshold moves only the floor, not the overall bar', () => {
    // 5/7 speech (71%) passes a 0.7 floor; overall 80% still passes 0.8.
    const verdict = evaluateVerdict(boundaryRun(), [], cfg({ speechThreshold: 0.7 }));
    expect(verdict.code).toBe(VERDICT_EXIT.PASS);
    // The same run with the default 0.8 floor fails on the class.
    expect(evaluateVerdict(boundaryRun(), [], cfg()).code).toBe(VERDICT_EXIT.SPEECH_FLOOR);
  });
});

describe('fix-on-repeat (same classification, last N=2 runs)', () => {
  it('a classification failed in the recorded history and failing again exits with the repeat code regardless of the ratio', () => {
    const current = [
      ...['v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09'].map((id) => speech(id, true)),
      // The oracle's own classification for fpbOEoRrHyU (run 4 of the fixture).
      rec('fpbOEoRrHyU', 'speech', {
        pass: false,
        reason: 'caption source=none; rate=n/a outside 100-600',
      }),
    ];
    const verdict = evaluateVerdict(current, historyRuns(), cfg());
    expect(verdict.code).toBe(VERDICT_EXIT.REPEAT);
    expect(verdict.repeats).toEqual([
      { videoId: 'fpbOEoRrHyU', reason: 'caption source=none; rate=n/a outside 100-600' },
    ]);
  });

  it('the music control deadline classification repeats too', () => {
    const current = [
      ...['v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09'].map((id) => speech(id, true)),
      rec('dQw4w9WgXcQ', 'music', { pass: false, reason: 'video-deadline-exceeded' }),
    ];
    const verdict = evaluateVerdict(current, historyRuns(), cfg());
    expect(verdict.code).toBe(VERDICT_EXIT.REPEAT);
    expect(verdict.repeats).toEqual([{ videoId: 'dQw4w9WgXcQ', reason: 'video-deadline-exceeded' }]);
  });

  it('a classification the video never failed with is not a repeat', () => {
    const current = [
      ...['v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09'].map((id) => speech(id, true)),
      rec('fpbOEoRrHyU', 'speech', { pass: false, reason: 'no-pill-render' }),
    ];
    expect(evaluateVerdict(current, historyRuns(), cfg()).code).toBe(VERDICT_EXIT.PASS);
  });

  it('a classification older than the lookback window does not repeat', () => {
    // iG9CE55wbtY failed 'caption source=none; rate=n/a outside 100-600'
    // only in run 1 of the fixture — outside the last 2 runs.
    const current = [
      ...['v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09', 'v10'].map((id) => speech(id, true)),
      rec('iG9CE55wbtY', 'speech', {
        pass: false,
        reason: 'caption source=none; rate=n/a outside 100-600',
      }),
    ];
    expect(evaluateVerdict(current, historyRuns(), cfg()).code).toBe(VERDICT_EXIT.PASS);
  });

  it('an empty history (first run ever) has no repeats', () => {
    const current = [rec('fpbOEoRrHyU', 'speech', { pass: false, reason: 'no-pill-render' })];
    const verdict = evaluateVerdict(current, [], cfg());
    expect(verdict.code).toBe(VERDICT_EXIT.PASS);
    expect(verdict.repeats).toEqual([]);
  });

  it('--ignore-repeats drops the exit but the summary still lists the repeats', () => {
    const current = [
      ...['v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09'].map((id) => speech(id, true)),
      rec('fpbOEoRrHyU', 'speech', {
        pass: false,
        reason: 'caption source=none; rate=n/a outside 100-600',
      }),
    ];
    const verdict = evaluateVerdict(current, historyRuns(), cfg({ ignoreRepeats: true }));
    expect(verdict.code).toBe(VERDICT_EXIT.PASS);
    expect(verdict.repeats).toHaveLength(1);
    expect(verdict.line).toContain('fpbOEoRrHyU');
  });

  it('the repeat exit fires before the speech floor', () => {
    const current = [
      ...boundaryRun().slice(0, 7), // speech 5/7 — the floor would fail
      rec('fpbOEoRrHyU', 'speech', {
        pass: false,
        reason: 'caption source=none; rate=n/a outside 100-600',
      }),
      rec('v09', 'live', { pass: true }),
      rec('v10', 'live', { pass: true }),
    ];
    const verdict = evaluateVerdict(current, historyRuns(), cfg());
    expect(verdict.code).toBe(VERDICT_EXIT.REPEAT);
  });
});

describe('signed-in lane assertion', () => {
  it('a --profile run with any signedIn=false record is a lane failure', () => {
    const current = [
      rec('v01', 'speech', { pass: true }),
      rec('v02', 'speech', { pass: true, signedIn: false }),
    ];
    const verdict = evaluateVerdict(current, [], cfg({ signedInLane: true }));
    expect(verdict.code).toBe(VERDICT_EXIT.SIGNED_OUT);
    expect(verdict.signedOut.map((r) => r.videoId)).toEqual(['v02']);
  });

  it('the anonymous lane is unaffected by signedIn=false records', () => {
    const current = [
      rec('v01', 'speech', { pass: true }),
      rec('v02', 'speech', { pass: true, signedIn: false }),
    ];
    expect(evaluateVerdict(current, [], cfg({ signedInLane: false })).code).toBe(VERDICT_EXIT.PASS);
  });

  it('the lane failure names the signed-out records', () => {
    const current = [rec('fpbOEoRrHyU', 'speech', { pass: true, signedIn: false })];
    const verdict = evaluateVerdict(current, [], cfg({ signedInLane: true }));
    expect(verdict.line).toContain('fpbOEoRrHyU');
  });

  it('the lane failure fires before the repeat exit', () => {
    const current = [
      rec('fpbOEoRrHyU', 'speech', {
        pass: false,
        reason: 'caption source=none; rate=n/a outside 100-600',
        signedIn: false,
      }),
    ];
    const verdict = evaluateVerdict(current, historyRuns(), cfg({ signedInLane: true }));
    expect(verdict.code).toBe(VERDICT_EXIT.SIGNED_OUT);
  });
});
