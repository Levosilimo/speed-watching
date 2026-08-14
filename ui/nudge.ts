// Recall-nudge overlay — a separate dismissible surface from the pill,
// with its own open shadow root (closed roots hide their content and ARIA
// from the accessibility tree). No chrome.* imports. The two lib imports
// are the i18n layer (display strings) and the bridge client it uses to
// resolve the UI language.

import { DARK, LIGHT, type Theme } from './styles';
import { nudgeCss } from './nudge-css';
import { createBridgeClient } from '../lib/messaging';
import { resolveUiLanguage, t, unitLabel, type UiLocale } from '../lib/i18n';
import type { RateRange } from '../lib/languages';
import type { UiLanguageSetting } from '../lib/settings';

export interface NudgeState {
  /** UI locale; unset → resolved from settings.uiLanguage via the bridge,
   * falling back to the browser UI language. */
  locale?: UiLocale;
  /** The current track language's safe zone, for the body's range copy;
   * absent → the en 250–275 wpm defaults. */
  range?: RateRange;
}

export interface NudgeEvents {
  /** 'Got it': 7-day cooldown dismiss. */
  onGotIt?: () => void;
  /** 'Don't show again': permanent dismiss. */
  onDontShowAgain?: () => void;
}

export interface NudgeOptions {
  /** UI locale; unset → resolved like the pill's locale. */
  locale?: UiLocale;
}

export interface NudgeApi {
  /** Renders the overlay (attaching the shadow root on first show) and
   * moves focus into it. Idempotent while shown. */
  show(state: NudgeState): void;
  /** Hides the overlay and restores focus to the player anchor. */
  dismiss(): void;
  /** Idempotent teardown; detaches the host so the next show mounts clean. */
  destroy(): void;
}

interface NudgeDom {
  overlay: HTMLDivElement;
  titleEl: HTMLHeadingElement;
  bodyEl: HTMLParagraphElement;
  gotItBtn: HTMLButtonElement;
  dontShowAgainBtn: HTMLButtonElement;
}

function buildDom(): NudgeDom {
  const overlay = document.createElement('div');
  overlay.className = 'nudge';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-labelledby', 'nudge-title');
  overlay.hidden = true;

  const titleEl = document.createElement('h2');
  titleEl.className = 'nudge-title';
  titleEl.id = 'nudge-title';

  const bodyEl = document.createElement('p');
  bodyEl.className = 'nudge-body';

  const actions = document.createElement('div');
  actions.className = 'nudge-actions';

  const gotItBtn = document.createElement('button');
  gotItBtn.type = 'button';
  gotItBtn.className = 'btn-got-it';
  gotItBtn.dataset.variant = 'primary';

  const dontShowAgainBtn = document.createElement('button');
  dontShowAgainBtn.type = 'button';
  dontShowAgainBtn.className = 'btn-dont-again';

  actions.append(gotItBtn, dontShowAgainBtn);
  overlay.append(titleEl, bodyEl, actions);

  return { overlay, titleEl, bodyEl, gotItBtn, dontShowAgainBtn };
}

/** The player area that hosted the nudge — the same anchor the pill's
 * restoreFocus uses: #movie_player on YouTube, else the video element,
 * else body. */
function restoreFocus(host: HTMLElement): void {
  const doc = host.ownerDocument;
  const anchor = doc.querySelector<HTMLElement>('#movie_player');
  const video = doc.querySelector<HTMLVideoElement>('video');
  (anchor ?? video ?? doc.body).focus();
}

function wireEvents(dom: NudgeDom, host: HTMLElement, events: NudgeEvents | undefined): void {
  const dismissWith = (action: () => void): void => {
    action();
    dom.overlay.hidden = true;
    restoreFocus(host);
  };

  dom.gotItBtn.addEventListener('click', () => dismissWith(() => events?.onGotIt?.()));
  dom.dontShowAgainBtn.addEventListener('click', () =>
    dismissWith(() => events?.onDontShowAgain?.()),
  );

  // Keyboard mirrors the pill: Enter triggers the primary action, Escape
  // dismisses. Both route through the button handler so the focus
  // restoration is shared with clicks. Escape never triggers 'Don't show
  // again' — the permanent choice stays an explicit click.
  dom.overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === 'Escape') && !e.defaultPrevented) {
      dom.gotItBtn.click();
    }
  });
}

function render(dom: NudgeDom, locale: UiLocale, range?: RateRange): void {
  dom.titleEl.textContent = t('nudge.title', locale);
  // The body's fallback range keys to the TRACK language (P0), not the UI
  // locale — absent range → the en 250–275 wpm defaults.
  dom.bodyEl.textContent = t('nudge.body', locale, {
    lo: range?.lo ?? 250,
    hi: range?.hi ?? 275,
    unit: unitLabel(range?.unit ?? 'wpm', locale),
  });
  dom.gotItBtn.textContent = t('nudge.gotIt', locale);
  dom.dontShowAgainBtn.textContent = t('nudge.dontShowAgain', locale);
}

/** Reads settings.uiLanguage through the page bridge; bridge failure or
 * timeout falls back to 'auto' → the browser UI language. */
async function resolveNudgeLocale(win: Window | null): Promise<UiLocale> {
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

export function createNudge(host: HTMLElement, events?: NudgeEvents, opts?: NudgeOptions): NudgeApi {
  const shadow = host.attachShadow({ mode: 'open' });
  let destroyed = false;
  let shown = false;
  let currentRange: RateRange | undefined;
  // Browser-language seed (no English flash for ru users); the bridge
  // round-trip refines it with settings.uiLanguage when unpinned.
  let locale: UiLocale = opts?.locale ?? resolveUiLanguage(undefined, navigator.language);

  const dom = buildDom();

  if (opts?.locale === undefined) {
    void resolveNudgeLocale(host.ownerDocument.defaultView).then((resolved) => {
      if (destroyed || resolved === locale) return;
      locale = resolved;
      if (shown) render(dom, locale);
    });
  }

  const doc = host.ownerDocument;
  const mq = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  let dark = mq?.matches ?? false;

  function theme(): Theme {
    return dark ? DARK : LIGHT;
  }

  const style = doc.createElement('style');
  style.textContent = nudgeCss(theme());
  shadow.append(style, dom.overlay);

  wireEvents(dom, host, events);

  const onThemeChange = (e: MediaQueryListEvent): void => {
    dark = e.matches;
    style.textContent = nudgeCss(theme());
  };
  mq?.addEventListener('change', onThemeChange);

  return {
    show(state) {
      if (destroyed) return;
      if (state.locale !== undefined) locale = state.locale;
      if (state.range !== undefined) currentRange = state.range;
      shown = true;
      host.appendChild(shadow);
      render(dom, locale, currentRange);
      dom.overlay.hidden = false;
      // Move focus into the overlay so Enter/Escape work without a click.
      dom.gotItBtn.focus();
    },

    dismiss() {
      if (destroyed) return;
      dom.overlay.hidden = true;
      restoreFocus(host);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      shown = false;
      mq?.removeEventListener('change', onThemeChange);
      shadow.innerHTML = '';
      host.innerHTML = '';
      // Same contract as the pill: the host keeps its shadow root after
      // destroy, so the content scripts re-resolve the host after churn;
      // detach it (with the root) so the next show mounts clean.
      host.remove();
    },
  };
}
