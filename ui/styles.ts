// Shared design tokens and CSS for Speed Watcher UI.
// All visual decisions live here — pill and options page consume these.

export const TOKENS = {
  // Spacing (4px base)
  sp1: '4px',
  sp2: '8px',
  sp3: '12px',
  sp4: '16px',
  sp5: '20px',
  sp6: '24px',
  sp8: '32px',
  sp10: '40px',
  sp12: '48px',

  // Type scale
  fontSans:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontMono: 'ui-monospace, "Cascadia Code", "Fira Code", Menlo, monospace',

  textXs: '0.6875rem',   // 11px
  textSm: '0.75rem',     // 12px
  textBase: '0.8125rem', // 13px — extension UI sweet spot
  textMd: '0.875rem',    // 14px
  textLg: '1rem',        // 16px
  textXl: '1.25rem',     // 20px
  text2xl: '1.5rem',     // 24px

  // Radii
  rSm: '4px',
  rMd: '6px',
  rLg: '8px',
  rPill: '999px',

  // Transitions
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  durationFast: '120ms',
  durationNorm: '200ms',
} as const;

// Light theme (options page default)
export const LIGHT = {
  bg: '#ffffff',
  bgSubtle: '#f8f9fa',
  bgMuted: '#f1f3f5',
  border: '#dee2e6',
  borderSubtle: '#e9ecef',
  text: '#212529',
  textSecondary: '#5a6268',
  textMuted: '#6c757d',
  primary: '#12796b',
  primaryHover: '#116960',
  primarySubtle: '#e6f7f5',
  warning: '#b45309',
  warningSubtle: '#fef3c7',
  danger: '#dc3545',
  dangerSubtle: '#fee2e2',
  focusRing: 'rgba(26, 156, 143, 0.35)',
  shadow: '0 1px 3px rgba(0,0,0,0.08)',
  shadowMd: '0 4px 12px rgba(0,0,0,0.1)',
} as const;

// Dark theme (YouTube pages, or system preference)
export const DARK = {
  bg: '#1e1e1e',
  bgSubtle: '#272727',
  bgMuted: '#2d2d2d',
  border: '#3a3a3a',
  borderSubtle: '#333333',
  text: '#e8eaed',
  textSecondary: '#9aa0a6',
  textMuted: '#8b949e',
  primary: '#2dd4bf',
  primaryHover: '#5eead4',
  primarySubtle: 'rgba(45, 212, 191, 0.12)',
  warning: '#fbbf24',
  warningSubtle: 'rgba(251, 191, 36, 0.12)',
  danger: '#f87171',
  dangerSubtle: 'rgba(248, 113, 113, 0.12)',
  focusRing: 'rgba(45, 212, 191, 0.35)',
  shadow: '0 1px 3px rgba(0,0,0,0.3)',
  shadowMd: '0 4px 12px rgba(0,0,0,0.4)',
} as const;

export type Theme = Record<keyof typeof LIGHT, string>;

/** Overlay-host z-index (pill + nudge): the host anchors absolutely inside
 * the player, so the value only needs to top the player chrome (controls
 * bar, captions) — kept near the 2147483647 cap as defense in depth.
 * Applied in the shadow :host rule AND inline on the host element: the
 * inline style is page-visible and survives page stylesheet overrides
 * that could flatten the shadow rule. */
export const OVERLAY_Z_INDEX = 2147483000;

/** Overlay-host bottom inset (pill + nudge): the hosts anchor this far
 * above the player's bottom edge to clear the right-cluster control
 * buttons (settings/fullscreen), which the 2026 player places 12–60px
 * above the bottom (48px button + 12px top margin). */
export const HOST_BOTTOM_OFFSET_PX = 68;

/** Compact single-line pill cap (recommend mode): the label + tier + the
 * Apply/Dismiss buttons fit one line at this width. */
export const PILL_COMPACT_MAX_WIDTH = 300;

