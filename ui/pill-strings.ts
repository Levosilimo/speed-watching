// Pill copy + format helpers — split out of ui/pill.ts so the component
// file stays under the aislop file-size budget (complexity/file-too-large).
// Everything here is a pure function of its inputs: no DOM, no state.
// ui/pill-parts.ts renders with these; ui/pill.ts re-exports the four the
// seam contract exposes (tests/pill.test.ts, tests/live-rate.test.ts,
// entrypoints/options/main.ts import them from '../ui/pill').

import type { RateRange } from '../lib/languages';
import {
  extractUnit,
  formatMultiplier,
  t,
  tierKeyFromLabel,
  tierLabel,
  unitLabel,
  type I18nKey,
  type UiLocale,
} from '../lib/i18n';
import type { CaptionStatus, LiveRate, PillState } from './pill';

export function warningNoteCopy(
  reason?: 'above-zone' | 'capped-below' | 'pause-diluted',
  locale: UiLocale = 'en',
  range?: RateRange,
): string {
  const key =
    reason === 'capped-below'
      ? 'pill.warning.cappedBelow'
      : reason === 'pause-diluted'
        ? 'pill.warning.pauseDiluted'
        : 'pill.warning.aboveZone';
  // The above-zone copy renders the TRACK language's range (P0): a ru track
  // warns past 168–180 слов/мин, never the en 250–275. Absent range → en.
  const params =
    key === 'pill.warning.aboveZone'
      ? {
          lo: range?.lo ?? 250,
          hi: range?.hi ?? 275,
          unit: unitLabel(range?.unit ?? 'wpm', locale),
        }
      : undefined;
  return t(key, locale, params);
}

/** Formats the live-rate line, e.g. 'now ≈ 248 wpm at 1.55x'. */
export function liveRateText(live: LiveRate, locale: UiLocale = 'en'): string {
  return t('pill.liveRate', locale, {
    rate: Math.round(live.rate),
    unit: unitLabel(extractUnit(live.unit), locale),
    mult: formatMultiplier(live.multiplier, locale),
  });
}

/** Throttle gate: true only when pushing `next` would change the live line.
 * timeupdate fires ~4x/sec while playing; the equality check keeps the pill
 * update from fighting the apply flow with redundant renders. */
export function shouldRefreshLive(prev: LiveRate | null, next: LiveRate | null): boolean {
  if (next === null) return prev !== null;
  if (prev === null) return true;
  return (
    prev.rate !== next.rate ||
    prev.multiplier !== next.multiplier ||
    prev.unit !== next.unit
  );
}

/** Localized main line: English renders the recommendation verbatim; ru
 * rebuilds it from the structured state (unit recovered from the label).
 * In the auto-applied state the line leads with the 'Auto · ' marker and
 * drops the leading arrow (P1b: 'Auto · 1.6x ≈ 240 wpm'). */
export function localizedLabel(state: PillState, locale: UiLocale): string {
  const prefix = state.applied === 'auto' ? t('pill.label.autoPrefix', locale) : '';
  let text: string;
  if (locale === 'en') {
    text = state.label;
  } else {
    const mult = formatMultiplier(state.multiplier, 'ru');
    const rate = Math.round(state.effectiveWpm);
    const unit = unitLabel(extractUnit(state.label), 'ru');
    switch (state.mode) {
      case 'music':
        text = t('pill.label.music', 'ru');
        break;
      case 'unreachable':
        text = t('pill.label.unreachable', 'ru', { mult, rate, unit });
        break;
      default:
        text =
          t('pill.label.recommend', 'ru', { mult, rate, unit }) +
          (state.reason === 'capped-below' ? t('pill.label.cappedSuffix', 'ru') : '');
    }
  }
  return prefix === '' ? text : prefix + text.replace(/^→\s*/, '');
}

export const CAPTION_STATUS_KEYS: Record<CaptionStatus, I18nKey> = {
  'no-track': 'pill.caption.noTrack',
  'fetch-failed': 'pill.caption.fetchFailed',
  'capture-missed': 'pill.caption.captureMissed',
};

/** Localized tier badge; unknown labels pass through unchanged. */
export function localizedTier(tierLabelText: string, locale: UiLocale): string {
  if (locale === 'en') return tierLabelText;
  const tier = tierKeyFromLabel(tierLabelText);
  return tier === null ? tierLabelText : tierLabel(tier, 'ru');
}

export function localizedApplyAria(state: PillState, locale: UiLocale): string {
  return t('pill.applyAriaSpeed', locale, {
    mult: locale === 'ru' ? state.multiplier.toFixed(1).replace('.', ',') : state.multiplier.toFixed(1),
  });
}
