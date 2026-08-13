import type { Segment } from './captions';
import type { LanguageModel } from './languages';
import type { ContentType } from './music';
import { cueSpanSec, estimateSpeechDurationSec } from './wpm';

export interface WpmRange {
  min: number;
  max: number;
}

const MEASURED_PRIORS: Partial<Record<ContentType, WpmRange>> = {
  talk: { min: 140, max: 206 },
  lecture: { min: 110, max: 188 },
  explainer: { min: 103, max: 191 },
  news: { min: 127, max: 150 },
};

const GENERIC_PRIOR: WpmRange = { min: 130, max: 190 };
const PODCAST_PRIOR: WpmRange = { min: 140, max: 200 };

/**
 * Natural-rate range for the 'estimated' tier. Language priors win for
 * known non-English tracks — the Phase-0 anchors are an English-corpus
 * measurement. A register band (language.registerPriors) applies when the
 * language carries one and the caller resolved a concrete type
 * (detectContentType or a user/site preference); everything else on the
 * language falls back to its generic band. English and unmapped tracks
 * keep the measured anchors and the generic default.
 */
export function priorRange(contentType: ContentType, language?: LanguageModel): WpmRange {
  if (language !== undefined && language.code !== 'en') {
    const register = language.registerPriors?.[contentType];
    if (register !== undefined) return register;
    return language.priors;
  }
  const measured = MEASURED_PRIORS[contentType];
  if (measured !== undefined) return measured;
  if (contentType === 'podcast') return PODCAST_PRIOR;
  return GENERIC_PRIOR;
}

/** Best-guess natural rate for the 'estimated' tier: prior-range midpoint. */
export function priorMidpoint(contentType: ContentType, language?: LanguageModel): number {
  const { min, max } = priorRange(contentType, language);
  return (min + max) / 2;
}

// ── Content-type auto-detect over the measured signal ────────────────────

/** Detection input: the measured caption-track signal. The register bands
 * are per language (registerPriors), so naturalRate is in the language's
 * unit. */
export interface MeasuredSignal {
  naturalRate: number;
  /** Wall-clock span of the track, first cue start to last cue end. */
  durationSec: number;
  /** Number of cues over the span. */
  cueCount: number;
  /** Inter-cue pause share of the span (0..1): 1 − speech/span. */
  pauseShare: number;
  /** Language model for the register bands; absent → English bands. */
  language?: LanguageModel;
}

// Auto-detect thresholds. BAND_MARGIN_RATIO is the confidence rule: the
// nearest register's midpoint distance must be at most half the
// second-nearest's, or the overlapping bands make the assignment a coin
// flip. The pause structure then confirms the assignment: lectures hold
// long inter-cue pauses (pauseShare ≥ LECTURE_PAUSE_MIN), news runs short
// cues over tight timing (≤ NEWS_CUE_MAX_SEC mean cue length and
// ≤ NEWS_PAUSE_MAX pause share), the mid-band registers stay conversational
// (moderate pause share). Registers sharing one band (ru/uk norm data:
// podcast/explainer/talk) are one candidate for the margin rule — the
// pause profile cannot split them, so the first-listed register carries the
// band's label (the assigned prior is identical, only the demand-count
// label differs).
const BAND_MARGIN_RATIO = 0.5;
const LECTURE_PAUSE_MIN = 0.3;
const NEWS_PAUSE_MAX = 0.25;
const NEWS_CUE_MAX_SEC = 5;
const MODERATE_PAUSE_MIN = 0.15;
const MODERATE_PAUSE_MAX = 0.4;

/** The language's register bands (en and unmapped languages: the measured
 * English anchors plus the podcast prior), always including the generic
 * band — a rate nearest to the generic midpoint is not confidently any
 * register. */
function registerBands(language?: LanguageModel): Array<[ContentType, WpmRange]> {
  if (language?.registerPriors !== undefined) {
    return Object.entries(language.registerPriors) as Array<[ContentType, WpmRange]>;
  }
  const bands: Array<[ContentType, WpmRange]> = [];
  for (const [type, band] of Object.entries(MEASURED_PRIORS) as Array<[ContentType, WpmRange]>) {
    bands.push([type, band]);
  }
  bands.push(['podcast', PODCAST_PRIOR]);
  bands.push(['generic', GENERIC_PRIOR]);
  return bands;
}

/** Auto-detect the content type from a measured signal: nearest register
 * band by rate under the band-margin confidence rule, confirmed by the
 * pause structure; 'generic' when nothing is confident. Never returns
 * 'music' — detectMusic has precedence and is checked before this (lyric
 * tracks share no speech register). */
export function detectContentType(input: MeasuredSignal): ContentType {
  const rate = input.naturalRate;
  // Distinct bands only: registers sharing a band are one candidate, else
  // the margin rule always rejects their own midpoint tie.
  const candidates = new Map<string, { type: ContentType; mid: number }>();
  for (const [type, band] of registerBands(input.language)) {
    const key = `${band.min}:${band.max}`;
    if (!candidates.has(key)) candidates.set(key, { type, mid: (band.min + band.max) / 2 });
  }
  const ranked = [...candidates.values()]
    .map((candidate) => ({ ...candidate, distance: Math.abs(rate - candidate.mid) }))
    .sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0];
  const second = ranked[1];
  if (nearest === undefined) return 'generic';
  if (second !== undefined && nearest.distance > second.distance * BAND_MARGIN_RATIO) {
    return 'generic';
  }
  const meanCueSec = input.cueCount > 0 ? input.durationSec / input.cueCount : Number.POSITIVE_INFINITY;
  switch (nearest.type) {
    case 'lecture':
      return input.pauseShare >= LECTURE_PAUSE_MIN ? 'lecture' : 'generic';
    case 'news':
      return input.pauseShare <= NEWS_PAUSE_MAX && meanCueSec <= NEWS_CUE_MAX_SEC ? 'news' : 'generic';
    case 'podcast':
    case 'talk':
    case 'explainer':
      return input.pauseShare >= MODERATE_PAUSE_MIN && input.pauseShare <= MODERATE_PAUSE_MAX
        ? nearest.type
        : 'generic';
    default:
      return 'generic';
  }
}

/** Build the detection signal from a parsed track: pause share is
 * 1 − speech/span (cue durations capped at the span). Null when the span
 * is not measurable (empty track). */
export function cueSignal(
  cues: Segment[],
  naturalRate: number,
  language?: LanguageModel,
): MeasuredSignal | null {
  const span = cueSpanSec(cues);
  if (span === null) return null;
  const speech = estimateSpeechDurationSec(cues) ?? 0;
  return {
    naturalRate,
    durationSec: span,
    cueCount: cues.length,
    pauseShare: 1 - speech / span,
    language,
  };
}
