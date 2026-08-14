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
  /** Auto-applied this video; shows the Stop-auto button in recommend mode. */
  applied?: AppliedSource;
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

  mainText.append(labelEl, tierEl, liveEl, savedEl, warningNote);

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

  // Keyboard: Enter applies, Escape dismisses. Both route through the
  // button handlers so the focus restoration is shared with clicks.
  dom.pill.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.defaultPrevented) {
      dom.applyBtn.click();
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      dom.dismissBtn.click();
    }
  });
}

export function warningNoteCopy(
  reason?: 'above-zone' | 'capped-below' | 'pause-diluted',
  locale: UiLocale = 'en',
): string {
  if (locale === 'ru') {
    const key =
      reason === 'capped-below'
        ? 'pill.warning.cappedBelow'
        : reason === 'pause-diluted'
          ? 'pill.warning.pauseDiluted'
          : 'pill.warning.aboveZone';
    return t(key, 'ru');
  }
  if (reason === 'capped-below') {
    return 'Estimate uncertain — capped at 1.5x for safety';
  }
  if (reason === 'pause-diluted') {
    return 'Speech runs fast at this speed — estimate uncertain';
  }
  return 'Past the 250–275 wpm range commonly cited for comfortable listening';
}

/** Formats the live-rate line, e.g. 'now ≈ 248 wpm at 1.55x'. */
export function liveRateText(live: LiveRate, locale: UiLocale = 'en'): string {
  if (locale === 'ru') {
    return t('pill.liveRate', 'ru', {
      rate: Math.round(live.rate),
      unit: unitLabel(extractUnit(live.unit), 'ru'),
      mult: formatMultiplier(live.multiplier, 'ru'),
    });
  }
  const multiplier = String(Math.round(live.multiplier * 100) / 100);
  return `now ≈ ${Math.round(live.rate)} ${live.unit} at ${multiplier}x`;
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
 * live rate is pushed. Full state updates re-evaluate it via render(). */
function renderLive(dom: PillDom, mode: PillMode, live: LiveRate | null, locale: UiLocale): void {
  const visible = live !== null && (mode === 'recommend' || mode === 'warning');
  dom.liveEl.hidden = !visible;
  if (visible) dom.liveEl.textContent = liveRateText(live, locale);
}

/** Saved-time line visibility: recommend/warning modes only, and only while
 * a positive amount is pushed — a fresh session at 0 saved is not worth a
 * line, and null hides it (before apply, paused, rate diverged). Full state
 * updates re-evaluate it via render(). */
function renderSaved(dom: PillDom, mode: PillMode, saved: number | null, locale: UiLocale): void {
  const visible = saved !== null && saved > 0 && (mode === 'recommend' || mode === 'warning');
  dom.savedEl.hidden = !visible;
  if (visible) dom.savedEl.textContent = t('pill.savedTime', locale, formatTimeSaved(saved, locale));
}

/** Localized main line: English renders the recommendation verbatim; ru
 * rebuilds it from the structured state (unit recovered from the label). */
function localizedLabel(state: PillState, locale: UiLocale): string {
  if (locale === 'en') return state.label;
  const mult = formatMultiplier(state.multiplier, 'ru');
  const rate = Math.round(state.effectiveWpm);
  const unit = unitLabel(extractUnit(state.label), 'ru');
  switch (state.mode) {
    case 'music':
      return t('pill.label.music', 'ru');
    case 'unreachable':
      return t('pill.label.unreachable', 'ru', { mult, rate, unit });
    default:
      return (
        t('pill.label.recommend', 'ru', { mult, rate, unit }) +
        (state.reason === 'capped-below' ? t('pill.label.cappedSuffix', 'ru') : '')
      );
  }
}

/** Localized tier badge; unknown labels pass through unchanged. */
function localizedTier(tierLabelText: string, locale: UiLocale): string {
  if (locale === 'en') return tierLabelText;
  const tier = tierKeyFromLabel(tierLabelText);
  return tier === null ? tierLabelText : tierLabel(tier, 'ru');
}

function localizedApplyAria(state: PillState, locale: UiLocale): string {
  const mult =
    locale === 'ru' ? state.multiplier.toFixed(1).replace('.', ',') : state.multiplier.toFixed(1);
  return locale === 'ru'
    ? t('pill.applyAriaSpeed', 'ru', { mult })
    : `Apply ${mult}x playback speed`;
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
  // video's rate was applied automatically. Computed before the none
  // early-return so a hide flips it back even when the surface goes dark.
  const showStopAuto = state.applied === 'auto' && mode === 'recommend';
  dom.stopAutoBtn.hidden = !showStopAuto;
  if (showStopAuto) {
    dom.stopAutoBtn.textContent = t('pill.stopAuto', locale);
    dom.stopAutoBtn.setAttribute('aria-label', t('pill.stopAutoAria', locale));
  }

  // Hide the live and saved lines outside recommend/warning, even in the
  // none branch below (the pill surface itself is invisible there, but the
  // elements must not keep stale text).
  if (mode !== 'recommend' && mode !== 'warning') {
    renderLive(dom, mode, null, locale);
    renderSaved(dom, mode, null, locale);
  }

  if (mode === 'none') {
    dom.pill.dataset.mode = 'hidden';
    dom.pill.setAttribute('aria-hidden', 'true');
    return;
  }

  dom.pill.removeAttribute('aria-hidden');
  dom.pill.dataset.mode = mode;
  renderLive(dom, mode, live, locale);
  renderSaved(dom, mode, saved, locale);

  // Label
  dom.labelEl.textContent = localizedLabel(state, locale);

  // Tier
  if (state.tierLabel) {
    dom.tierEl.textContent = localizedTier(state.tierLabel, locale);
    dom.tierEl.hidden = false;
  } else {
    dom.tierEl.hidden = true;
  }

  // Warning note (only for warning mode; copy picked by reason)
  if (mode === 'warning') {
    dom.warningNote.textContent = warningNoteCopy(state.reason, locale);
    dom.warningNote.hidden = false;
  } else {
    dom.warningNote.hidden = true;
  }

  // Apply button variant + visibility
  if (mode === 'unreachable' || mode === 'music') {
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
  let locale: UiLocale = opts?.locale ?? 'en';
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
      renderLive(dom, currentState?.mode ?? 'none', live, locale);
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
