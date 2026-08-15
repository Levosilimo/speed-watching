// Overlay pill component — the primary user-facing surface.
// Self-contained vanilla TS DOM. Open shadow root for style isolation:
// closed roots hide their content and ARIA from the accessibility tree.
// No chrome.* imports. The two lib imports are the i18n layer (display
// strings) and the bridge client it uses to resolve the UI language.
// Split into ui/pill-parts.ts (DOM + renderers + locale bootstrap) and
// ui/pill-strings.ts (copy/format helpers) to stay under the aislop
// file-size budget; this file keeps the seam contract (types, createPill,
// the exported helper values) with its exact exports.

import { DARK, LIGHT, OVERLAY_Z_INDEX, type Theme } from './styles';
import { pillCss } from './pill-css';
import type { RateRange } from '../lib/languages';
import { resolveUiLanguage, type UiLocale } from '../lib/i18n';
import {
  bootstrapLocale,
  buildDom,
  render,
  renderLive,
  renderSaved,
  watchTheme,
  wireEvents,
} from './pill-parts';
import {
  CAPTION_STATUS_KEYS,
  liveRateText,
  shouldRefreshLive,
  warningNoteCopy,
} from './pill-strings';

// ── Types (matches the seam contract exactly) ────────────────────────────
export type PillMode = 'recommend' | 'warning' | 'unreachable' | 'music' | 'none';

/** Why the estimated tier rendered instead of a measurement: the video has
 * no caption tracks, the caption chain collapsed, or the payload parsed
 * empty. Absent from every measured-tier state. */
export type CaptionStatus = 'no-track' | 'fetch-failed' | 'capture-missed';

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
  /** The caption-collapse reason on the estimated tier; the tier badge
   * appends its copy ('estimated · no captions found'). Absent on measured
   * tiers and on estimated renders without a collapse (uncountable cues). */
  captionStatus?: CaptionStatus;
  /** Auto-applied this video; shows the Stop-auto button in recommend mode. */
  applied?: AppliedSource;
  /** The rate the stop-auto/dismiss undo restores (the pre-auto rate);
   * absent → plain 'Stop auto' with no rate change. */
  undoRate?: number;
  /** P1c: the one-time first-run explainer line shows on this render. */
  firstRun?: boolean;
  /** The page exposed chapter markers; the consent toggle renders only then. */
  chaptersAvailable?: boolean;
  /** Chapter consent state: the scheduler is armed for this video. */
  autoAdjust?: boolean;
  /** Scheduler status line copy picker; absent ≡ 'active'. */
  chapterStatus?: 'active' | 'yielded' | 'music';
  /** Skip-silence active and inside a caption gap: the saved-time line
   * area shows the slowed-silence indicator instead of saved time. */
  skipSlowed?: boolean;
}

export interface PillEvents {
  onApply?: (multiplier: number) => void;
  onDismiss?: () => void;
  /** Stop-auto: disengage auto-apply for this video (rate untouched). */
  onStopAuto?: () => void;
  /** Chapter consent toggle: enabled = arm the per-chapter scheduler. */
  onAutoAdjust?: (enabled: boolean) => void;
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

// The copy/format helpers (ui/pill-strings.ts) — the seam contract's value
// exports, kept reachable from '../ui/pill'.
export { CAPTION_STATUS_KEYS, liveRateText, shouldRefreshLive, warningNoteCopy };

// ── Component ────────────────────────────────────────────────────────────

export function createPill(host: HTMLElement, events?: PillEvents, opts?: PillOptions): PillApi {
  // Inline z-index: the shadow :host rule is capped by the player's
  // stacking context; the page-visible inline value tops the chart.
  host.style.zIndex = String(OVERLAY_Z_INDEX);
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

  bootstrapLocale(opts, host, (resolved) => {
    if (destroyed || resolved === locale) return;
    locale = resolved;
    if (currentState !== null) render(dom, currentState, liveRate, savedSec, locale, destroyed);
  });

  const doc = host.ownerDocument;
  let dark = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
  const theme = (): Theme => (dark ? DARK : LIGHT);

  const dom = buildDom();

  const style = doc.createElement('style');
  style.textContent = pillCss(theme());
  shadow.append(style, dom.pill);

  wireEvents(dom, host, events, () => currentState);
  const disposeTheme = watchTheme(doc, style, (isDark) => {
    dark = isDark;
    style.textContent = pillCss(theme());
  });

  return {
    mount() {
      if (destroyed || mounted) return;
      // The shadow root (with the pill DOM inside) attaches in createPill;
      // appending the root node to the host again would relocate the pill
      // into the host's light DOM, where shadow hosts render nothing.
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
      renderSaved(dom, currentState?.mode ?? 'none', saved, locale, currentState?.skipSlowed === true);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      mounted = false;
      disposeTheme();
      shadow.innerHTML = '';
      // The host keeps its shadow root after destroy; a second attachShadow
      // on it would throw, so the content scripts re-resolve the host after
      // video churn. Detach it (with the root) so the next pill mounts clean.
      host.remove();
    },
  };
}
