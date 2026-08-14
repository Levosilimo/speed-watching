// Overlay pill component — the primary user-facing surface.
// Self-contained vanilla TS DOM. Open shadow root for style isolation:
// closed roots hide their content and ARIA from the accessibility tree.
// No chrome.* imports. The two lib imports are the i18n layer (display
// strings) and the bridge client it uses to resolve the UI language.
// The saved-time line (lib-13) pushed the file and createPill past the
// reviewability budgets — suppressed like entrypoints/content.ts.
// aislop-ignore-file file-too-large, function-too-long

import { DARK, LIGHT, type Theme } from './styles';
import { pillCss } from './pill-css';
import { createBridgeClient } from '../lib/messaging';
import type { RateRange } from '../lib/languages';
import {
  extractUnit,
  formatMultiplier,
  formatTimeSaved,
  resolveUiLanguage,
  t,
  tierKeyFromLabel,
  tierLabel,
  unitLabel,
  type UiLocale,
} from '../lib/i18n';
import type { UiLanguageSetting } from '../lib/settings';

// ── Types (matches the seam contract exactly) ────────────────────────────
export type PillMode = 'recommend' | 'warning' | 'unreachable' | 'music' | 'none';

/** How the current rate got applied: by auto-apply, by the user, or not
 * applied. Absent from a PillState ≡ 'none'. */
export type AppliedSource = 'auto' | 'user' | 'none';

export interface PillState {
  mode: PillMode;
  rateWpm: number;
  multiplier: number;
  effectiveWpm: number;
  tierLabel?: string;
  label: string;
  /** Warning-mode copy selector: cliff crossing vs clamp cap vs articulatory load. */
  reason?: 'above-zone' | 'capped-below' | 'pause-diluted';
  /** The resolved track language's safe zone (target–ceiling, its unit);
   * absent → the en 250–275 wpm defaults. Drives the warning copy and the
   * first-run line's unit. */
  range?: RateRange;
  /** Auto-applied this video; shows the Stop-auto button in recommend mode. */
  applied?: AppliedSource;
  /** The rate the stop-auto/dismiss undo restores (the pre-auto rate);
   * absent → plain 'Stop auto' with no rate change. */
  undoRate?: number;
  /** P1c: the one-time first-run explainer line shows on this render. */
  firstRun?: boolean;
}

export interface PillEvents {
  onApply?: (multiplier: number) => void;
  onDismiss?: () => void;
  /** Stop-auto: disengage auto-apply for this video (rate untouched). */
  onStopAuto?: () => void;
}

export interface PillOptions {
  /** UI locale; unset → resolved from settings.uiLanguage via the bridge,
   * falling back to the browser UI language. */
  locale?: UiLocale;
}

/** Current presentation rate for the live line: measured natural rate ×
 * playbackRate, in the rate unit the recommendation label uses. */
export interface LiveRate {
  rate: number;
  multiplier: number;
  unit: string;
}

export interface PillApi {
  mount(): void;
  update(state: PillState): void;
  /** Live-rate line; null hides it. Throttled: no-op while unchanged. */
  updateLiveRate(live: LiveRate | null): void;
  /** Saved-time line (seconds reclaimed by the applied rate); null hides
   * it. Throttled: no-op while unchanged. */
  updateSavedSec(saved: number | null): void;
  destroy(): void;
}

// ── Component ────────────────────────────────────────────────────────────

interface PillDom {
  pill: HTMLDivElement;
  labelEl: HTMLSpanElement;
  tierEl: HTMLSpanElement;
  liveEl: HTMLSpanElement;
  savedEl: HTMLSpanElement;
  warningNote: HTMLDivElement;
  firstRunEl: HTMLDivElement;
  applyBtn: HTMLButtonElement;
  dismissBtn: HTMLButtonElement;
  stopAutoBtn: HTMLButtonElement;
}

function buildDom(): PillDom {
  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.dataset.mode = 'hidden';

  const mainText = document.createElement('div');
  mainText.className = 'main-text';
  // Live region covers only the text: status regions announce atomically
  // and swallow interactive children, so the buttons live outside it.
  // role=status already implies aria-live=polite.
  mainText.setAttribute('role', 'status');

  const labelEl = document.createElement('span');
  labelEl.className = 'label';

  const tierEl = document.createElement('span');
  tierEl.className = 'tier';

  const liveEl = document.createElement('span');
  liveEl.className = 'live-rate';
  liveEl.hidden = true;

  const savedEl = document.createElement('span');
  savedEl.className = 'saved-time';
  savedEl.hidden = true;

  const warningNote = document.createElement('div');
  warningNote.className = 'warning-note';

  const firstRunEl = document.createElement('div');
  firstRunEl.className = 'first-run';
  firstRunEl.hidden = true;

  mainText.append(labelEl, tierEl, liveEl, savedEl, warningNote, firstRunEl);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn-apply';
  applyBtn.dataset.variant = 'primary';
  applyBtn.textContent = 'Apply';
  applyBtn.setAttribute('aria-label', 'Apply recommended playback speed');

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn-dismiss';
  dismissBtn.textContent = '×';
  dismissBtn.setAttribute('aria-label', 'Dismiss');

  const stopAutoBtn = document.createElement('button');
  stopAutoBtn.type = 'button';
  stopAutoBtn.className = 'btn-stop-auto';
  stopAutoBtn.hidden = true;

  actions.append(applyBtn, dismissBtn, stopAutoBtn);
  pill.append(mainText, actions);

  return {
    pill,
    labelEl,
    tierEl,
    liveEl,
    savedEl,
    warningNote,
    firstRunEl,
    applyBtn,
    dismissBtn,
    stopAutoBtn,
  };
}

/** The player area that hosted the pill — #movie_player on YouTube, else the
 * video element, else body. Moving focus here after Apply/Dismiss/Escape
 * keeps it from stranding inside a pill that just hid itself. */
function restoreFocus(host: HTMLElement): void {
  const doc = host.ownerDocument;
  const anchor = doc.querySelector<HTMLElement>('#movie_player');
  const video = doc.querySelector<HTMLVideoElement>('video');
  (anchor ?? video ?? doc.body).focus();
}

function wireEvents(
  dom: PillDom,
  host: HTMLElement,
  events: PillEvents | undefined,
  getState: () => PillState | null,
): void {
  dom.applyBtn.addEventListener('click', () => {
    const state = getState();
    if (state && state.mode !== 'unreachable' && state.mode !== 'music') {
      events?.onApply?.(state.multiplier);
      restoreFocus(host);
    }
  });

  dom.dismissBtn.addEventListener('click', () => {
    events?.onDismiss?.();
    restoreFocus(host);
  });

  dom.stopAutoBtn.addEventListener('click', () => {
    events?.onStopAuto?.();
    restoreFocus(host);
  });

  // Keyboard: Enter applies (or undoes auto in the auto-applied state),
  // Escape dismisses. Both route through the button handlers so the focus
  // restoration is shared with clicks.
  dom.pill.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.defaultPrevented) {
      const state = getState();
      if (state?.applied === 'auto' && state.mode === 'recommend') {
        dom.stopAutoBtn.click();
      } else {
        dom.applyBtn.click();
      }
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      dom.dismissBtn.click();
    }
  });
}

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

/** Live line visibility: recommend/warning modes only, and only while a
 * live rate is pushed. A live rate that equals the label's effective rate
 * at the same multiplier duplicates the label (P2b) — hidden. Full state
 * updates re-evaluate it via render(). */
function renderLive(dom: PillDom, state: PillState | null, live: LiveRate | null, locale: UiLocale): void {
  let visible =
    live !== null && state !== null && (state.mode === 'recommend' || state.mode === 'warning');
  if (visible && state !== null && live !== null) {
    const duplicates =
      Math.round(live.rate) === Math.round(state.effectiveWpm) &&
      Math.round(live.multiplier * 100) === Math.round(state.multiplier * 100);
    visible = !duplicates;
  }
  dom.liveEl.hidden = !visible;
  if (visible && live !== null) dom.liveEl.textContent = liveRateText(live, locale);
}

/** Saved-time line visibility: recommend/warning modes only, and only once
 * a meaningful amount accumulated (P2c: the per-video floor is 30 s — a
 * sub-minute gain is not worth a line) and a positive amount is pushed —
 * null hides it (before apply, paused, rate diverged). Full state updates
 * re-evaluate it via render(). */
function renderSaved(dom: PillDom, mode: PillMode, saved: number | null, locale: UiLocale): void {
  const visible = saved !== null && saved >= 30 && (mode === 'recommend' || mode === 'warning');
  dom.savedEl.hidden = !visible;
  if (visible) dom.savedEl.textContent = t('pill.savedTime', locale, formatTimeSaved(saved, locale));
}

/** Localized main line: English renders the recommendation verbatim; ru
 * rebuilds it from the structured state (unit recovered from the label).
 * In the auto-applied state the line leads with the 'Auto · ' marker and
 * drops the leading arrow (P1b: 'Auto · 1.6x ≈ 240 wpm'). */
function localizedLabel(state: PillState, locale: UiLocale): string {
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

/** Localized tier badge; unknown labels pass through unchanged. */
function localizedTier(tierLabelText: string, locale: UiLocale): string {
  if (locale === 'en') return tierLabelText;
  const tier = tierKeyFromLabel(tierLabelText);
  return tier === null ? tierLabelText : tierLabel(tier, 'ru');
}

function localizedApplyAria(state: PillState, locale: UiLocale): string {
  return t('pill.applyAriaSpeed', locale, {
    mult: locale === 'ru' ? state.multiplier.toFixed(1).replace('.', ',') : state.multiplier.toFixed(1),
  });
}

/** One-time onboarding line: measured rate → applied multiplier → effective
 * rate, rendered only on the first recommend-mode render (P1c). */
function renderFirstRun(dom: PillDom, state: PillState, locale: UiLocale): void {
  if (state.firstRun !== true) {
    dom.firstRunEl.hidden = true;
    return;
  }
  dom.firstRunEl.hidden = false;
  dom.firstRunEl.textContent = t('pill.firstRun', locale, {
    rate: Math.round(state.rateWpm),
    mult: formatMultiplier(state.multiplier, locale),
    effective: Math.round(state.effectiveWpm),
    unit: unitLabel(extractUnit(state.label), locale),
  });
}

function render(
  dom: PillDom,
  state: PillState,
  live: LiveRate | null,
  saved: number | null,
  locale: UiLocale,
  destroyed: boolean,
): void {
  if (destroyed) return;

  // Button strings live in render so a late locale resolution re-labels
  // them (buildDom only supplies the structural defaults).
  dom.applyBtn.textContent = t('pill.apply', locale);
  dom.applyBtn.setAttribute('aria-label', t('pill.applyAria', locale));
  dom.dismissBtn.setAttribute('aria-label', t('pill.dismissAria', locale));

  const mode = state.mode;

  // Stop-auto button: only while the recommendation is showing AND this
  // video's rate was applied automatically. In that state it is the undo
  // affordance — 'Reset to {rate}×' restoring the pre-auto rate when the
  // content script captured one, plain 'Stop auto' otherwise. Computed
  // before the none early-return so a hide flips it back even when the
  // surface goes dark.
  const showStopAuto = state.applied === 'auto' && mode === 'recommend';
  dom.stopAutoBtn.hidden = !showStopAuto;
  if (showStopAuto) {
    const undo = state.undoRate !== undefined;
    dom.stopAutoBtn.textContent = undo
      ? t('pill.resetTo', locale, { rate: formatMultiplier(state.undoRate ?? 1, locale) })
      : t('pill.stopAuto', locale);
    dom.stopAutoBtn.setAttribute('aria-label', undo ? t('pill.resetToAria', locale) : t('pill.stopAutoAria', locale));
  }

  // Hide the live and saved lines outside recommend/warning, even in the
  // none branch below (the pill surface itself is invisible there, but the
  // elements must not keep stale text).
  if (mode !== 'recommend' && mode !== 'warning') {
    renderLive(dom, state, null, locale);
    renderSaved(dom, mode, null, locale);
  }

  if (mode === 'none') {
    dom.pill.dataset.mode = 'hidden';
    dom.pill.setAttribute('aria-hidden', 'true');
    return;
  }

  dom.pill.removeAttribute('aria-hidden');
  dom.pill.dataset.mode = mode;
  renderLive(dom, state, live, locale);
  renderSaved(dom, mode, saved, locale);

  // Label
  dom.labelEl.textContent = localizedLabel(state, locale);

  // First-run onboarding line
  renderFirstRun(dom, state, locale);

  // Tier
  if (state.tierLabel) {
    dom.tierEl.textContent = localizedTier(state.tierLabel, locale);
    dom.tierEl.hidden = false;
  } else {
    dom.tierEl.hidden = true;
  }

  // Warning note (only for warning mode; copy picked by reason)
  if (mode === 'warning') {
    dom.warningNote.textContent = warningNoteCopy(state.reason, locale, state.range);
    dom.warningNote.hidden = false;
  } else {
    dom.warningNote.hidden = true;
  }

  // Apply button variant + visibility: hidden for unreachable/music and in
  // the auto-applied state, where the undo affordance replaces it (P1b).
  if (mode === 'unreachable' || mode === 'music' || state.applied === 'auto') {
    dom.applyBtn.hidden = true;
  } else {
    dom.applyBtn.hidden = false;
    dom.applyBtn.dataset.variant = mode === 'warning' ? 'warning' : 'primary';
    dom.applyBtn.setAttribute('aria-label', localizedApplyAria(state, locale));
  }
}

/** Reads settings.uiLanguage through the page bridge; bridge failure or
 * timeout falls back to 'auto' → the browser UI language. */
async function resolvePillLocale(win: Window | null): Promise<UiLocale> {
  let setting: UiLanguageSetting | undefined;
  if (win !== null) {
    try {
      setting = (await createBridgeClient(win).request({ type: 'settings:get' })).uiLanguage;
    } catch {
      setting = undefined;
    }
  }
  return resolveUiLanguage(setting, navigator.language);
}

export function createPill(host: HTMLElement, events?: PillEvents, opts?: PillOptions): PillApi {
  const shadow = host.attachShadow({ mode: 'open' });
  let mounted = false;
  let destroyed = false;
  let currentState: PillState | null = null;
  // Browser-language seed (no English flash for ru users); the bridge
  // round-trip refines it with settings.uiLanguage when the caller did not
  // pin a locale — the same two-step the options page uses.
  let locale: UiLocale = opts?.locale ?? resolveUiLanguage(undefined, navigator.language);
  // Throttled live-rate and saved-time state: render()/updateLiveRate()/
  // updateSavedSec() all drive the lines so a line update never re-renders
  // the recommendation and a recommendation update re-evaluates visibility.
  let liveRate: LiveRate | null = null;
  let savedSec: number | null = null;

  if (opts?.locale === undefined) {
    void resolvePillLocale(host.ownerDocument.defaultView).then((resolved) => {
      if (destroyed || resolved === locale) return;
      locale = resolved;
      if (currentState !== null) render(dom, currentState, liveRate, savedSec, locale, destroyed);
    });
  }

  // Detect theme from host's document or system
  const doc = host.ownerDocument;
  const mq = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  let dark = mq?.matches ?? false;

  function theme(): Theme {
    return dark ? DARK : LIGHT;
  }

  const dom = buildDom();

  // Inject styles
  const style = doc.createElement('style');
  style.textContent = pillCss(theme());
  shadow.append(style, dom.pill);

  wireEvents(dom, host, events, () => currentState);

  // Theme listener
  const onThemeChange = (e: MediaQueryListEvent): void => {
    dark = e.matches;
    style.textContent = pillCss(theme());
  };
  mq?.addEventListener('change', onThemeChange);

  return {
    mount() {
      if (destroyed || mounted) return;
      host.appendChild(shadow);
      mounted = true;
    },

    update(state: PillState) {
      if (destroyed) return;
      currentState = state;
      // Drop stale live rates and saved times outside recommend/warning so a
      // later mode flip cannot resurrect a paused video's line (render only
      // sees the values).
      if (state.mode !== 'recommend' && state.mode !== 'warning') {
        liveRate = null;
        savedSec = null;
      }
      render(dom, state, liveRate, savedSec, locale, destroyed);
    },

    updateLiveRate(live: LiveRate | null) {
      if (destroyed || !shouldRefreshLive(liveRate, live)) return;
      liveRate = live;
      renderLive(dom, currentState, live, locale);
    },

    updateSavedSec(saved: number | null) {
      if (destroyed || saved === savedSec) return;
      savedSec = saved;
      renderSaved(dom, currentState?.mode ?? 'none', saved, locale);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      mounted = false;
      mq?.removeEventListener('change', onThemeChange);
      shadow.innerHTML = '';
      host.innerHTML = '';
      // The host keeps its shadow root after destroy; a second attachShadow
      // on it would throw, so the content scripts re-resolve the host after
      // video churn. Detach it (with the root) so the next pill mounts clean.
      host.remove();
    },
  };
}
