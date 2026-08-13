// Overlay pill component — the primary user-facing surface.
// Self-contained vanilla TS DOM. Open shadow root for style isolation:
// closed roots hide their content and ARIA from the accessibility tree.
// No chrome.* imports. No lib/ logic imports.

import { DARK, LIGHT, type Theme } from './styles';
import { pillCss } from './pill-css';

// ── Types (matches the seam contract exactly) ────────────────────────────
export type PillMode = 'recommend' | 'warning' | 'unreachable' | 'music' | 'none';

export interface PillState {
  mode: PillMode;
  rateWpm: number;
  multiplier: number;
  effectiveWpm: number;
  tierLabel?: string;
  label: string;
  /** Warning-mode copy selector: cliff crossing vs clamp cap vs articulatory load. */
  reason?: 'above-zone' | 'capped-below' | 'pause-diluted';
}

export interface PillEvents {
  onApply?: (multiplier: number) => void;
  onDismiss?: () => void;
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
  destroy(): void;
}

// ── Component ────────────────────────────────────────────────────────────

interface PillDom {
  pill: HTMLDivElement;
  labelEl: HTMLSpanElement;
  tierEl: HTMLSpanElement;
  liveEl: HTMLSpanElement;
  warningNote: HTMLDivElement;
  applyBtn: HTMLButtonElement;
  dismissBtn: HTMLButtonElement;
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

  const warningNote = document.createElement('div');
  warningNote.className = 'warning-note';

  mainText.append(labelEl, tierEl, liveEl, warningNote);

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

  actions.append(applyBtn, dismissBtn);
  pill.append(mainText, actions);

  return { pill, labelEl, tierEl, liveEl, warningNote, applyBtn, dismissBtn };
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
): string {
  if (reason === 'capped-below') {
    return 'Estimate uncertain — capped at 1.5x for safety';
  }
  if (reason === 'pause-diluted') {
    return 'Speech runs fast at this speed — estimate uncertain';
  }
  return 'Past the 250–275 wpm range commonly cited for comfortable listening';
}

/** Formats the live-rate line, e.g. 'now ≈ 248 wpm at 1.55x'. */
export function liveRateText(live: LiveRate): string {
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
function renderLive(dom: PillDom, mode: PillMode, live: LiveRate | null): void {
  const visible = live !== null && (mode === 'recommend' || mode === 'warning');
  dom.liveEl.hidden = !visible;
  if (visible) dom.liveEl.textContent = liveRateText(live);
}

function render(
  dom: PillDom,
  state: PillState,
  live: LiveRate | null,
  destroyed: boolean,
): void {
  if (destroyed) return;

  const mode = state.mode;

  // Hide the live line outside recommend/warning, even in the none branch
  // below (the pill surface itself is invisible there, but the element must
  // not keep stale text).
  if (mode !== 'recommend' && mode !== 'warning') renderLive(dom, mode, null);

  if (mode === 'none') {
    dom.pill.dataset.mode = 'hidden';
    dom.pill.setAttribute('aria-hidden', 'true');
    return;
  }

  dom.pill.removeAttribute('aria-hidden');
  dom.pill.dataset.mode = mode;
  renderLive(dom, mode, live);

  // Label
  dom.labelEl.textContent = state.label;

  // Tier
  if (state.tierLabel) {
    dom.tierEl.textContent = state.tierLabel;
    dom.tierEl.hidden = false;
  } else {
    dom.tierEl.hidden = true;
  }

  // Warning note (only for warning mode; copy picked by reason)
  if (mode === 'warning') {
    dom.warningNote.textContent = warningNoteCopy(state.reason);
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
    dom.applyBtn.setAttribute(
      'aria-label',
      `Apply ${state.multiplier.toFixed(1)}x playback speed`,
    );
  }
}

export function createPill(host: HTMLElement, events?: PillEvents): PillApi {
  const shadow = host.attachShadow({ mode: 'open' });
  let mounted = false;
  let destroyed = false;
  let currentState: PillState | null = null;
  // Throttled live-rate state: render()/updateLiveRate() both drive
  // renderLive() so a live update never re-renders the recommendation and
  // a recommendation update re-evaluates the line's visibility.
  let liveRate: LiveRate | null = null;

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
      // Drop stale live rates outside recommend/warning so a later mode flip
      // cannot resurrect a paused video's line (render only sees the value).
      if (state.mode !== 'recommend' && state.mode !== 'warning') liveRate = null;
      render(dom, state, liveRate, destroyed);
    },

    updateLiveRate(live: LiveRate | null) {
      if (destroyed || !shouldRefreshLive(liveRate, live)) return;
      liveRate = live;
      renderLive(dom, currentState?.mode ?? 'none', live);
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
