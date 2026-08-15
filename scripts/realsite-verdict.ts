// Real-site runner verdict — the release gate's bar machinery
// (scripts/realsite-runner.ts drives it; docs/release-gate.md is the spec).
// Three gates sit on top of the per-video evaluatePass: the signed-in lane
// assertion (a --profile run that recorded signedIn=false is a lane
// failure, not a video failure), the fix-on-repeat rule (a video failing
// with the same classification in the last N runs forces a fix regardless
// of the ratio), and the per-class speech floor (the product's core must
// hold ≥ the threshold separately from the overall ratio). Split out so
// scripts/realsite-runner-lib.ts stays under the repo's file-size cap.
//
// Gate order — the first failing gate wins:
//   5 signed-out lane → 4 repeat failure → 3 speech floor → 1 ratio → 0 pass
// Exit code 2 is the runner's usage-error code and never comes from here.

import type { RealsiteRecord } from './realsite-runner-lib';

export const VERDICT_EXIT = {
  /** All bars held. */
  PASS: 0,
  /** Overall pass ratio below --threshold. */
  RATIO: 1,
  /** The speech class held below its floor. */
  SPEECH_FLOOR: 3,
  /** A video failed with a classification it also failed with in the last N runs. */
  REPEAT: 4,
  /** A --profile run recorded signedIn=false. */
  SIGNED_OUT: 5,
} as const;

export interface RepeatFailure {
  videoId: string;
  /** The record's failure classification (evaluatePass reason). */
  reason: string;
}

export interface VerdictConfig {
  /** Overall pass-ratio bar (--threshold, default 0.8). */
  threshold: number;
  /** Speech-class floor: --threshold unless --speech-threshold is set. */
  speechThreshold: number;
  /** --profile run: any signedIn=false record fails the run. */
  signedInLane: boolean;
  /** --ignore-repeats: the re-verification escape — the repeat gate does
   * not exit, but the summary still lists the repeats. */
  ignoreRepeats: boolean;
  /** The lookback window for repeat detection (N=2). */
  repeatLookbackRuns: number;
}

export interface VerdictResult {
  code: number;
  /** Overall pass ratio over all sampled videos. */
  ratio: number;
  /** Speech-class pass ratio; null when the run sampled no speech videos
   * (the floor is vacuous then). */
  speechRatio: number | null;
  /** Repeat failures in run order. */
  repeats: RepeatFailure[];
  /** Records that failed the signed-in lane assertion. */
  signedOut: RealsiteRecord[];
  /** The verdict line the runner prints after 'VERDICT: '. */
  line: string;
}

/** A run-start marker written by the runner before its first record in
 * scripts/data/realsite-run/results.jsonl. */
const RUN_START_KEY = 'runStart';

/** Groups results.jsonl into runs: the records between run markers. The
 * file predates markers (the first 40 records), so leading marker-less
 * records form the legacy first run. Torn lines (a kill mid-append) are
 * skipped without splitting the run. */
export function parseRunHistory(text: string): RealsiteRecord[][] {
  const runs: RealsiteRecord[][] = [];
  let run: RealsiteRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry !== null && typeof entry === 'object' && RUN_START_KEY in entry) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(entry as RealsiteRecord);
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** The completed runs before the current one: the runner appends its own
 * marker + records, so the trailing group is the run being judged. */
export function previousRuns(text: string): RealsiteRecord[][] {
  return parseRunHistory(text).slice(0, -1);
}

/** The fix-on-repeat rule (release-gate.md §4): a video that failed in
 * this run with a classification it also failed with in any of the last N
 * completed runs. Passes in between do not reset the window — the rule
 * reads the recorded history, not the last occurrence. */
export function findRepeatFailures(
  current: RealsiteRecord[],
  history: RealsiteRecord[][],
  lookbackRuns: number,
): RepeatFailure[] {
  const window = history.slice(-lookbackRuns);
  const repeats: RepeatFailure[] = [];
  for (const record of current) {
    if (record.pass || record.reason === null) continue;
    const prior = window.flatMap((run) => run.filter((r) => r.videoId === record.videoId));
    if (prior.some((r) => !r.pass && r.reason === record.reason)) {
      repeats.push({ videoId: record.videoId, reason: record.reason });
    }
  }
  return repeats;
}

const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pct0 = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function evaluateVerdict(
  current: RealsiteRecord[],
  history: RealsiteRecord[][],
  cfg: VerdictConfig,
): VerdictResult {
  const passed = current.filter((r) => r.pass).length;
  const ratio = current.length === 0 ? 0 : passed / current.length;
  const speech = current.filter((r) => r.kind === 'speech');
  const speechPassed = speech.filter((r) => r.pass).length;
  const speechRatio = speech.length === 0 ? null : speechPassed / speech.length;
  const signedOut = cfg.signedInLane ? current.filter((r) => !r.signedIn) : [];
  const repeats = findRepeatFailures(current, history, cfg.repeatLookbackRuns);
  const base = { ratio, speechRatio, repeats, signedOut };

  if (signedOut.length > 0) {
    const ids = signedOut.map((r) => r.videoId).join(', ');
    return {
      ...base,
      code: VERDICT_EXIT.SIGNED_OUT,
      line: `signed-out lane: ${signedOut.length}/${current.length} records signedIn=false (${ids}) — re-login and re-run`,
    };
  }
  if (repeats.length > 0 && !cfg.ignoreRepeats) {
    const list = repeats.map((r) => `${r.videoId}=${r.reason}`).join(', ');
    return {
      ...base,
      code: VERDICT_EXIT.REPEAT,
      line: `repeat failures: ${list} — fix forced (same classification in the last ${cfg.repeatLookbackRuns} runs)`,
    };
  }
  if (speechRatio !== null && speechRatio < cfg.speechThreshold) {
    return {
      ...base,
      code: VERDICT_EXIT.SPEECH_FLOOR,
      line: `speech-class floor: ${pct1(speechRatio)} (${speechPassed}/${speech.length}) below ${pct0(cfg.speechThreshold)}`,
    };
  }
  if (ratio < cfg.threshold) {
    return {
      ...base,
      code: VERDICT_EXIT.RATIO,
      line: `pass ratio ${pct1(ratio)} below ${pct0(cfg.threshold)}`,
    };
  }
  const ignored =
    repeats.length > 0 ? ` (repeat failures ignored: ${repeats.map((r) => r.videoId).join(', ')})` : '';
  return {
    ...base,
    code: VERDICT_EXIT.PASS,
    line: `pass ratio ${pct1(ratio)} ≥ ${pct0(cfg.threshold)}${ignored}`,
  };
}
