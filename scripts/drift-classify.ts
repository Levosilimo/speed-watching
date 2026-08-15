// Shared drift classification vocabulary: the verdict terms and the
// tolerance comparisons both box-gated runners classify with — the
// drift-triage runner (scripts/drift-triage.ts) against re-captured
// truncated payloads, the realsite runner's field-diff
// (scripts/realsite-runner-lib.ts) against the registry's recorded rates.
//
// Verdicts:
//   identical   — byte-equal to the pinned row (re-captures only)
//   benign      — within the semantic tolerance band (ratesRel/countsRel)
//   breaking    — outside the band, or a structural class changed
//   unreachable — the re-capture could not land (infra, box-gated)

export type DriftVerdict = 'identical' | 'benign' | 'breaking' | 'unreachable';

/** Within the semantic tolerance: counts shift at most max(1, rel*pinned)
 * — the truncation boundary (20th event) is the dominant legitimate noise
 * source, ASR re-segmentation the second. */
export function countInTolerance(pinned: number, current: number, rel: number): boolean {
  return Math.abs(current - pinned) <= Math.max(1, Math.round(pinned * rel));
}

export function rateInTolerance(pinned: number | null, current: number | null, rel: number): boolean {
  if (pinned === null || current === null) return true;
  if (pinned === 0) return current === 0;
  return Math.abs(current - pinned) / Math.abs(pinned) <= rel;
}
