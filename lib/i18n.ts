// UI-localization layer. The data model stays English — the labels
// lib/recommend.ts builds, the tier and unit labels (TIER_LABELS,
// UNIT_LABELS) — and this layer localizes at render time only. Locale
// resolution: settings.uiLanguage ('auto' default), falling back to the
// browser UI language (navigator.language) when auto.
//
// ru unit labels: the ru speech model is word-unit, so wpm reads naturally
// as 'слов/мин' rather than a transliteration of 'wpm'; the non-word units
// are transliterated the same way — симв/мин, слогов/мин, мор/мин
// (сокращения от «символов в минуту», «слогов в минуту», «мор в минуту»).

import { UNIT_LABELS, type RateUnit } from './languages';
import { TIER_LABELS, type RateTier } from './recommend';
import type { UiLanguageSetting } from './settings';
import { RU } from './i18n-ru';

export type UiLocale = 'en' | 'ru';

const EN = {
  'pill.apply': 'Apply',
  'pill.applyAria': 'Apply recommended playback speed',
  'pill.applyAriaSpeed': 'Apply {mult}x playback speed',
  'pill.dismissAria': 'Dismiss',
  'pill.warning.aboveZone': 'Past the 250–275 wpm range commonly cited for comfortable listening',
  'pill.warning.cappedBelow': 'Estimate uncertain — capped at 1.5x for safety',
  'pill.warning.pauseDiluted': 'Speech runs fast at this speed — estimate uncertain',
  'pill.liveRate': 'now ≈ {rate} {unit} at {mult}x',
  'pill.label.recommend': '→ {mult}x ≈ {rate} {unit}',
  'pill.label.unreachable': 'safe zone unreachable — {mult}x ≈ {rate} {unit}',
  'pill.label.music': 'music — speed not recommended',
  'pill.label.cappedSuffix': ' (capped below safe zone)',
  'nudge.title': 'At a glance, was that still fully clear?',
  'nudge.body':
    'Fast playback can feel as clear as normal speed even when recall dips — speed-watching mostly affects how confident you feel about understanding, not what you objectively catch. If anything felt rushed, 250–275 wpm is the comfortable range to fall back to.',
  'nudge.gotIt': 'Got it',
  'nudge.dontShowAgain': "Don't show again",
  'tier.asrWord': 'from captions',
  'tier.asrCue': 'from captions',
  'tier.manualCue': 'from captions (corrected)',
  'tier.estimated': 'estimated',
  'unit.wpm': 'wpm',
  'unit.cpm': 'cpm',
  'unit.syl': 'syl/min',
  'unit.mora': 'morae/min',
  'options.title': 'Speed Watcher — Options',
  'options.tagline': 'WPM-based playback speed recommendations',
  'options.targetLabel': 'Target speech rate',
  'options.slow': 'Slow',
  'options.safeZone': 'Comfortable range (250–275)',
  'options.why250':
    'Why 250? Listening comprehension stays comfortable through about 275 wpm — the range commonly cited for speech — and silent reading runs roughly 240–260 wpm. 250 matches your reading rate and leaves a ~9% buffer below that ceiling: a comfortable default, not a maximum to push.',
  'options.fast': 'Fast',
  'options.contentTypeLabel': 'Content type',
  'options.contentTypeAria': 'Content type presets',
  'options.preset.lecture': 'Lecture',
  'options.preset.talk': 'Talk',
  'options.preset.podcast': 'Podcast',
  'options.preset.music': 'Music',
  'options.preset.generic': 'Generic',
  'options.languageLabel': 'Interface language',
  'options.languageAuto': 'Auto',
  'options.overridesLabel': 'Per-site overrides',
  'options.overridesEmpty': 'No site overrides set.',
  'options.overridePlaceholder': 'e.g. ted.com',
  'options.overrideAria': 'Hostname to override',
  'options.add': 'Add',
  'options.remove': 'Remove',
  'options.removeAria': 'Remove override for {host}',
  'options.habitsLabel': 'Your habits',
  'options.habitsApplied': 'Recommendations applied',
  'options.habitsAvgMult': 'Average multiplier',
  'options.probeLabel': 'Test audio capture',
  'options.probeNote':
    'Verifies that the extension can capture audio from a video tab. The meter shows the live audio level of the captured tab while the test runs. No audio is recorded, stored, or transmitted — the meter is the only output.',
  'options.probeStart': 'Test audio capture',
  'options.probeStop': 'Stop audio capture',
  'options.probeIdle': 'Idle',
  'options.probeStarting': 'Starting…',
  'options.probeCapturing': 'Capturing',
  'options.probeDegraded': 'Capture degraded',
  'options.probeError': 'Capture failed',
  'options.probeFail': 'Capture failed — {error}',
  'options.integrationLabel': 'Integration',
  'options.integrationNote':
    'Allow other extensions you install to ask Speed Watcher for the measured speech rate of the current video. Off by default; only approved partner extensions can query.',
  'options.integrationToggle': 'Allow measurement requests from partner extensions',
  'options.tiersLabel': 'Tier labels',
  'options.tier.asrWordDesc':
    'Word-timed ASR captions. The most common tier — ~94% of sampled videos with speech captions in our measurements.',
  'options.tier.manualCueDesc': 'Manual captions with silence correction applied. Higher confidence, clamped to 1.5× max.',
  'options.tier.estimatedDesc':
    'Heuristic estimate from content type and video metadata. Used when captions are unavailable.',
} as const;

export type I18nKey = keyof typeof EN;

const RU_MAP: Record<I18nKey, string> = RU;

/** Every UI string per locale; `ru` is type-checked to cover all of `en`. */
export const STRINGS: Record<UiLocale, Record<I18nKey, string>> = { en: EN, ru: RU_MAP };

export function t(
  key: I18nKey,
  locale: UiLocale,
  params?: Record<string, string | number>,
): string {
  let text = STRINGS[locale][key];
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** settings.uiLanguage, then navigator.language when 'auto' (or unset):
 * a language tag starting with 'ru' resolves to Russian, anything else to
 * English. */
export function resolveUiLanguage(
  setting: UiLanguageSetting | undefined,
  browserLanguage: string,
): UiLocale {
  if (setting === 'ru' || setting === 'en') return setting;
  return browserLanguage.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

const UNIT_KEYS: Record<RateUnit, I18nKey> = {
  wpm: 'unit.wpm',
  cpm: 'unit.cpm',
  syl: 'unit.syl',
  mora: 'unit.mora',
};

export function unitLabel(unit: RateUnit, locale: UiLocale): string {
  return t(UNIT_KEYS[unit], locale);
}

const TIER_KEYS: Record<RateTier, I18nKey> = {
  'asr-word': 'tier.asrWord',
  'asr-cue': 'tier.asrCue',
  'manual-cue': 'tier.manualCue',
  estimated: 'tier.estimated',
};

export function tierLabel(tier: RateTier, locale: UiLocale): string {
  return t(TIER_KEYS[tier], locale);
}

/** Decimal comma for ru (1,55×), ASCII dot for en — the ru pill line keeps
 * Russian typographic conventions. */
export function formatMultiplier(value: number, locale: UiLocale): string {
  const text = String(Math.round(value * 100) / 100);
  return locale === 'ru' ? text.replace('.', ',') : text;
}

/** The rate unit embedded in a recommend() label ('→ 1.9x ≈ 380 morae/min'
 * → 'mora'); also maps a LiveRate.unit string. Unknown → 'wpm'. */
export function extractUnit(label: string): RateUnit {
  for (const unit of Object.keys(UNIT_LABELS) as RateUnit[]) {
    if (label.includes(UNIT_LABELS[unit])) return unit;
  }
  return 'wpm';
}

/** English tier label → tier key. PillState carries the display string, not
 * the key, so render-time localization looks the label back up. */
export function tierKeyFromLabel(label: string): RateTier | null {
  for (const [tier, text] of Object.entries(TIER_LABELS) as [RateTier, string][]) {
    if (label === text) return tier;
  }
  return null;
}

/** Applies a locale to every [data-i18n] text node, [data-i18n-aria]
 * aria-label and [data-i18n-placeholder] placeholder under root. */
export function applyI18n(root: ParentNode, locale: UiLocale): void {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n') as I18nKey, locale);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria') as I18nKey, locale));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder') as I18nKey, locale));
  });
}
