// Pill DOM + renderers + locale bootstrap — split out of ui/pill.ts so the
// component file stays under the aislop file-size budget
// (complexity/file-too-large). Types and the PillApi contract stay in
// ui/pill.ts (imported type-only here); the copy/format helpers live in
// ui/pill-strings.ts. createPill (ui/pill.ts) wires these together.

import type { LiveRate, PillEvents, PillMode, PillOptions, PillState } from './pill';
import {
  CAPTION_STATUS_KEYS,
  liveRateText,
  localizedApplyAria,
  localizedLabel,
  localizedTier,
  warningNoteCopy,
} from './pill-strings';
import { createBridgeClient } from '../lib/messaging';
import {
  extractUnit,
  formatMultiplier,
  formatTimeSaved,
  resolveUiLanguage,
  t,
  unitLabel,
  type UiLocale,
} from '../lib/i18n';
import type { UiLanguageSetting } from '../lib/settings';

interface PillDom {
  pill: HTMLDivElement;
  labelEl: HTMLSpanElement;
  tierEl: HTMLSpanElement;
  liveEl: HTMLSpanElement;
  savedEl: HTMLSpanElement;
  warningNote: HTMLDivElement;
  firstRunEl: HTMLDivElement;
  chapterStatusEl: HTMLSpanElement;
  applyBtn: HTMLButtonElement;
  dismissBtn: HTMLButtonElement;
  stopAutoBtn: HTMLButtonElement;
  chapterToggleBtn: HTMLButtonElement;
}

/** The live-region line elements; buildDom appends the container first. */
function buildMainText(): {
  mainText: HTMLDivElement;
  labelEl: HTMLSpanElement;
  tierEl: HTMLSpanElement;
  liveEl: HTMLSpanElement;
  savedEl: HTMLSpanElement;
  warningNote: HTMLDivElement;
  firstRunEl: HTMLDivElement;
  chapterStatusEl: HTMLSpanElement;
} {
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

  const chapterStatusEl = document.createElement('span');
  chapterStatusEl.className = 'chapter-status';
  chapterStatusEl.hidden = true;

  mainText.append(labelEl, tierEl, liveEl, savedEl, warningNote, firstRunEl, chapterStatusEl);

  return { mainText, labelEl, tierEl, liveEl, savedEl, warningNote, firstRunEl, chapterStatusEl };
}

/** The action buttons; buildDom appends the container second. */
function buildActions(): {
  actions: HTMLDivElement;
  applyBtn: HTMLButtonElement;
  dismissBtn: HTMLButtonElement;
  stopAutoBtn: HTMLButtonElement;
  chapterToggleBtn: HTMLButtonElement;
} {
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

  const chapterToggleBtn = document.createElement('button');
  chapterToggleBtn.type = 'button';
  chapterToggleBtn.className = 'btn-chapter-toggle';
  chapterToggleBtn.hidden = true;

  actions.append(applyBtn, dismissBtn, stopAutoBtn, chapterToggleBtn);

  return { actions, applyBtn, dismissBtn, stopAutoBtn, chapterToggleBtn };
}

export function buildDom(): PillDom {
  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.dataset.mode = 'hidden';

  const mainText = buildMainText();
  const actions = buildActions();
  pill.append(mainText.mainText, actions.actions);

  return { pill, ...mainText, ...actions };
}

/** The player area that hosted the pill — #movie_player on YouTube, else the
 * video element, else body. Moving focus here after Apply/Dismiss/Escape
 * keeps it from stranding inside a pill that just hid itself. Real players
 * only take focus when the anchor carries tabindex (YouTube's #movie_player
 * has tabindex=-1; a bare <video> or div does not, and .focus() on a
 * non-focusable element is a silent no-op), so each candidate is made
 * programmatically focusable and verified to have taken focus before the
 * next fallback. */
function restoreFocus(host: HTMLElement): void {
  const doc = host.ownerDocument;
  const candidates = [
    doc.querySelector<HTMLElement>('#movie_player'),
    doc.querySelector<HTMLVideoElement>('video'),
    doc.body,
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    candidate.setAttribute('tabindex', '-1');
    candidate.focus();
    if (doc.activeElement === candidate) return;
  }
}

export function wireEvents(
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

  dom.chapterToggleBtn.addEventListener('click', () => {
    events?.onAutoAdjust?.(getState()?.autoAdjust !== true);
    restoreFocus(host);
  });

  // Keyboard: Enter applies (or undoes auto in the auto-applied state),
  // Escape dismisses — both route through the button handlers so focus
  // restoration is shared with clicks. Enter routes only from the pill
  // surface: focused buttons activate natively (their single apply path).
  dom.pill.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      dom.dismissBtn.click();
    } else if (e.key === 'Enter' && !e.defaultPrevented && e.target === dom.pill) {
      e.preventDefault();
      const state = getState();
      if (state?.applied === 'auto' && state.mode === 'recommend') {
        dom.stopAutoBtn.click();
      } else {
        dom.applyBtn.click();
      }
    }
  });
}

/** Live line visibility: recommend/warning modes only, and only while a
 * live rate is pushed. A live rate that equals the label's effective rate
 * at the same multiplier duplicates the label (P2b) — hidden. Full state
 * updates re-evaluate it via render(). */
export function renderLive(dom: PillDom, state: PillState | null, live: LiveRate | null, locale: UiLocale): void {
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
 * re-evaluate it via render(). While skip-silence holds a gap (slowed) the
 * line shows the indicator instead. */
export function renderSaved(
  dom: PillDom,
  mode: PillMode,
  saved: number | null,
  locale: UiLocale,
  slowed = false,
): void {
  if (slowed && (mode === 'recommend' || mode === 'warning')) {
    dom.savedEl.hidden = false;
    dom.savedEl.textContent = t('pill.skipSilence', locale);
    return;
  }
  const visible = saved !== null && saved >= 30 && (mode === 'recommend' || mode === 'warning');
  dom.savedEl.hidden = !visible;
  if (visible) dom.savedEl.textContent = t('pill.savedTime', locale, formatTimeSaved(saved, locale));
}

/** One-time onboarding line: measured rate → applied multiplier → effective
 * rate, rendered only on the first recommend-mode render (P1c). */
export function renderFirstRun(dom: PillDom, state: PillState, locale: UiLocale): void {
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

/** Button strings + aria live here so a late locale resolution re-labels
 * them (buildDom only supplies the structural defaults). */
export function renderActionLabels(dom: PillDom, locale: UiLocale): void {
  dom.applyBtn.textContent = t('pill.apply', locale);
  dom.applyBtn.setAttribute('aria-label', t('pill.applyAria', locale));
  dom.dismissBtn.setAttribute('aria-label', t('pill.dismissAria', locale));
}

/** Stop-auto button: only while the recommendation is showing AND this
 * video's rate was applied automatically. In that state it is the undo
 * affordance — 'Reset to {rate}×' restoring the pre-auto rate when the
 * content script captured one, plain 'Stop auto' otherwise. */
export function renderStopAuto(dom: PillDom, state: PillState, locale: UiLocale): void {
  const showStopAuto = state.applied === 'auto' && state.mode === 'recommend';
  dom.stopAutoBtn.hidden = !showStopAuto;
  if (showStopAuto) {
    const undo = state.undoRate !== undefined;
    dom.stopAutoBtn.textContent = undo
      ? t('pill.resetTo', locale, { rate: formatMultiplier(state.undoRate ?? 1, locale) })
      : t('pill.stopAuto', locale);
    dom.stopAutoBtn.setAttribute('aria-label', undo ? t('pill.resetToAria', locale) : t('pill.stopAutoAria', locale));
  }
}

/** Chapter consent toggle: only when the page exposed chapter markers and
 * the recommendation is actionable. aria-pressed mirrors the consent state. */
export function renderChapterToggle(dom: PillDom, state: PillState, locale: UiLocale): void {
  const showChapterToggle =
    state.chaptersAvailable === true && (state.mode === 'recommend' || state.mode === 'warning');
  dom.chapterToggleBtn.hidden = !showChapterToggle;
  if (showChapterToggle) {
    dom.chapterToggleBtn.textContent = t('pill.chapter.toggle', locale);
    dom.chapterToggleBtn.setAttribute('aria-label', t('pill.chapter.toggleAria', locale));
    dom.chapterToggleBtn.setAttribute('aria-pressed', state.autoAdjust === true ? 'true' : 'false');
  }
}

/** Scheduler status line: while consent is on, the current segment's state
 * (active / paused after a manual override / a music chapter at 1x). */
export function renderChapterStatus(dom: PillDom, state: PillState, locale: UiLocale): void {
  const showChapterStatus =
    state.chaptersAvailable === true &&
    (state.mode === 'recommend' || state.mode === 'warning') &&
    state.autoAdjust === true;
  dom.chapterStatusEl.hidden = !showChapterStatus;
  if (showChapterStatus) {
    const statusKey =
      state.chapterStatus === 'yielded'
        ? 'pill.chapter.yielded'
        : state.chapterStatus === 'music'
          ? 'pill.chapter.music'
          : 'pill.chapter.active';
    dom.chapterStatusEl.textContent = t(statusKey, locale);
  }
}

export function render(
  dom: PillDom,
  state: PillState,
  live: LiveRate | null,
  saved: number | null,
  locale: UiLocale,
  destroyed: boolean,
): void {
  if (destroyed) return;

  renderActionLabels(dom, locale);

  const mode = state.mode;

  // Stop-auto and the chapter affordances render before the none
  // early-return so a hide flips them back even when the surface goes dark.
  renderStopAuto(dom, state, locale);
  renderChapterToggle(dom, state, locale);
  renderChapterStatus(dom, state, locale);

  // Hide the live and saved lines outside recommend/warning, even in the
  // none branch below (the pill surface itself is invisible there, but the
  // elements must not keep stale text).
  if (mode !== 'recommend' && mode !== 'warning') {
    renderLive(dom, state, null, locale);
    renderSaved(dom, mode, null, locale, state.skipSlowed === true);
  }

  if (mode === 'none') {
    dom.pill.dataset.mode = 'hidden';
    dom.pill.setAttribute('aria-hidden', 'true');
    return;
  }

  dom.pill.removeAttribute('aria-hidden');
  dom.pill.dataset.mode = mode;
  renderLive(dom, state, live, locale);
  renderSaved(dom, mode, saved, locale, state.skipSlowed === true);

  // Label
  dom.labelEl.textContent = localizedLabel(state, locale);

  // First-run onboarding line
  renderFirstRun(dom, state, locale);

  // Tier; the estimated tier appends the caption-collapse reason when one
  // exists ('estimated · no captions found').
  if (state.tierLabel) {
    const collapse =
      state.captionStatus === undefined
        ? ''
        : ` · ${t(CAPTION_STATUS_KEYS[state.captionStatus], locale)}`;
    dom.tierEl.textContent = localizedTier(state.tierLabel, locale) + collapse;
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

/** Bridge round-trip for settings.uiLanguage; no-op when the caller pinned
 * a locale. onResolved runs after the round-trip, so the caller guards
 * against its own post-destroy/state drift. */
export function bootstrapLocale(
  opts: PillOptions | undefined,
  host: HTMLElement,
  onResolved: (resolved: UiLocale) => void,
): void {
  if (opts?.locale !== undefined) return;
  void resolvePillLocale(host.ownerDocument.defaultView).then(onResolved);
}

/** (prefers-color-scheme) listener that re-injects the stylesheet on theme
 * change; returns a disposer. */
export function watchTheme(
  doc: Document,
  style: HTMLStyleElement,
  onDark: (dark: boolean) => void,
): () => void {
  const mq = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  const onChange = (e: MediaQueryListEvent): void => onDark(e.matches);
  mq?.addEventListener('change', onChange);
  return () => mq?.removeEventListener('change', onChange);
}
