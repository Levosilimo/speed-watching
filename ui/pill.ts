// Overlay pill component — the primary user-facing surface.
// Self-contained vanilla TS DOM. Closed shadow root for style isolation.
// No chrome.* imports. No lib/ logic imports.

import { DARK, LIGHT, TOKENS, type Theme } from './styles';

// ── Types (matches the seam contract exactly) ────────────────────────────

export type PillMode = 'recommend' | 'warning' | 'unreachable' | 'music' | 'none';

export interface PillState {
  mode: PillMode;
  rateWpm: number;
  multiplier: number;
  effectiveWpm: number;
  tierLabel?: string;
  label: string;
  /** Warning-mode copy selector: cliff crossing vs clamp cap. */
  reason?: 'above-zone' | 'capped-below';
}

export interface PillEvents {
  onApply?: (multiplier: number) => void;
  onDismiss?: () => void;
}

export interface PillApi {
  mount(): void;
  update(state: PillState): void;
  destroy(): void;
}

// ── Styles (injected into shadow root) ───────────────────────────────────

function pillCss(t: Theme): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :host {
      all: initial;
      display: block;
      position: fixed;
      bottom: 18px;
      right: 18px;
      z-index: 999999;
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textBase};
      line-height: 1.45;
      color: ${t.text};
      pointer-events: none;
    }

    .pill {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: ${TOKENS.sp3};
      padding: ${TOKENS.sp2} ${TOKENS.sp3};
      background: ${t.bgSubtle};
      border: 1px solid ${t.border};
      border-radius: ${TOKENS.rPill};
      box-shadow: ${t.shadowMd};
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      max-width: 420px;
      transition: opacity ${TOKENS.durationNorm} ${TOKENS.easeOut},
                  transform ${TOKENS.durationNorm} ${TOKENS.easeOut};
    }

    .pill[data-mode="hidden"] {
      opacity: 0;
      transform: translateY(6px) scale(0.96);
      pointer-events: none;
    }

    .pill[data-mode="recommend"] {
      border-color: ${t.primary};
      background: ${t.primarySubtle};
    }

    .pill[data-mode="warning"] {
      border-color: ${t.warning};
      background: ${t.warningSubtle};
    }

    .pill[data-mode="unreachable"],
    .pill[data-mode="music"] {
      border-color: ${t.border};
      background: ${t.bgMuted};
    }

    .main-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .label {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tier {
      font-size: ${TOKENS.textXs};
      color: ${t.textSecondary};
      white-space: nowrap;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: ${TOKENS.sp1};
      flex-shrink: 0;
    }

    .btn-apply {
      padding: ${TOKENS.sp1} ${TOKENS.sp3};
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textSm};
      font-weight: 600;
      border: none;
      border-radius: ${TOKENS.rPill};
      cursor: pointer;
      transition: background ${TOKENS.durationFast} ease,
                  color ${TOKENS.durationFast} ease;
    }

    .btn-apply[data-variant="primary"] {
      background: ${t.primary};
      color: ${t.bg};
    }
    .btn-apply[data-variant="primary"]:hover {
      background: ${t.primaryHover};
    }

    .btn-apply[data-variant="warning"] {
      background: ${t.warning};
      color: ${t.bg};
    }
    .btn-apply[data-variant="warning"]:hover {
      opacity: 0.9;
    }

    .btn-apply[data-variant="muted"] {
      background: ${t.border};
      color: ${t.textSecondary};
      cursor: default;
    }

    .btn-apply:focus-visible {
      outline: 2px solid ${t.primary};
      outline-offset: 2px;
      box-shadow: 0 0 0 4px ${t.focusRing};
    }

    .btn-dismiss {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textSm};
      color: ${t.textSecondary};
      background: transparent;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      transition: background ${TOKENS.durationFast} ease,
                  color ${TOKENS.durationFast} ease;
    }

    .btn-dismiss:hover {
      background: ${t.border};
      color: ${t.text};
    }

    .btn-dismiss:focus-visible {
      outline: 2px solid ${t.primary};
      outline-offset: 1px;
      box-shadow: 0 0 0 3px ${t.focusRing};
    }

    .warning-note {
      font-size: ${TOKENS.textXs};
      color: ${t.warning};
      padding: 0 ${TOKENS.sp3};
      margin-top: -2px;
      line-height: 1.3;
    }
  `;
}

// ── Component ────────────────────────────────────────────────────────────

interface PillDom {
  pill: HTMLDivElement;
  labelEl: HTMLSpanElement;
  tierEl: HTMLSpanElement;
  warningNote: HTMLDivElement;
  applyBtn: HTMLButtonElement;
  dismissBtn: HTMLButtonElement;
}

function buildDom(): PillDom {
  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  pill.dataset.mode = 'hidden';

  const mainText = document.createElement('div');
  mainText.className = 'main-text';

  const labelEl = document.createElement('span');
  labelEl.className = 'label';

  const tierEl = document.createElement('span');
  tierEl.className = 'tier';

  const warningNote = document.createElement('div');
  warningNote.className = 'warning-note';

  mainText.append(labelEl, tierEl, warningNote);

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

  return { pill, labelEl, tierEl, warningNote, applyBtn, dismissBtn };
}

function wireEvents(
  dom: PillDom,
  events: PillEvents | undefined,
  getState: () => PillState | null,
): void {
  dom.applyBtn.addEventListener('click', () => {
    const state = getState();
    if (state && state.mode !== 'unreachable' && state.mode !== 'music') {
      events?.onApply?.(state.multiplier);
    }
  });

  dom.dismissBtn.addEventListener('click', () => {
    events?.onDismiss?.();
  });

  // Keyboard: Enter on focused pill triggers apply
  dom.pill.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.defaultPrevented) {
      dom.applyBtn.click();
    }
  });
}

export function warningNoteCopy(reason?: 'above-zone' | 'capped-below'): string {
  return reason === 'capped-below'
    ? 'Estimate uncertain — capped at 1.5x for safety'
    : 'Past the safe zone — comprehension drops above ~275 wpm';
}

function render(dom: PillDom, state: PillState, destroyed: boolean): void {
  if (destroyed) return;

  const mode = state.mode;

  if (mode === 'none') {
    dom.pill.dataset.mode = 'hidden';
    dom.pill.setAttribute('aria-hidden', 'true');
    return;
  }

  dom.pill.removeAttribute('aria-hidden');
  dom.pill.dataset.mode = mode;

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
  const shadow = host.attachShadow({ mode: 'closed' });
  let mounted = false;
  let destroyed = false;
  let currentState: PillState | null = null;

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

  wireEvents(dom, events, () => currentState);

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
      render(dom, state, destroyed);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      mounted = false;
      mq?.removeEventListener('change', onThemeChange);
      shadow.innerHTML = '';
      host.innerHTML = '';
    },
  };
}
