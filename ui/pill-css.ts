// Pill stylesheet — the component's shadow-root CSS, split out of
// ui/pill.ts to keep the component file under the aislop file-size
// budget (complexity/file-too-large).

import { TOKENS, type Theme } from './styles';

// ── Styles (injected into shadow root) ───────────────────────────────────

export function pillCss(t: Theme): string {
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

    .live-rate {
      font-size: ${TOKENS.textXs};
      color: ${t.textSecondary};
      white-space: nowrap;
    }

    .saved-time {
      font-size: ${TOKENS.textXs};
      color: ${t.textSecondary};
      white-space: nowrap;
    }

    .chapter-status {
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
      width: 24px;
      height: 24px;
      padding: 1px;
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

    .btn-stop-auto {
      padding: ${TOKENS.sp1} ${TOKENS.sp2};
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textXs};
      color: ${t.textSecondary};
      background: transparent;
      border: 1px solid ${t.border};
      border-radius: ${TOKENS.rPill};
      cursor: pointer;
      transition: background ${TOKENS.durationFast} ease,
                  color ${TOKENS.durationFast} ease;
    }

    .btn-stop-auto:hover {
      background: ${t.border};
      color: ${t.text};
    }

    .btn-stop-auto:focus-visible {
      outline: 2px solid ${t.primary};
      outline-offset: 1px;
      box-shadow: 0 0 0 3px ${t.focusRing};
    }

    .btn-chapter-toggle {
      padding: ${TOKENS.sp1} ${TOKENS.sp2};
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textXs};
      color: ${t.textSecondary};
      background: transparent;
      border: 1px solid ${t.border};
      border-radius: ${TOKENS.rPill};
      cursor: pointer;
      transition: background ${TOKENS.durationFast} ease,
                  color ${TOKENS.durationFast} ease;
    }

    .btn-chapter-toggle[aria-pressed="true"] {
      background: ${t.primary};
      border-color: ${t.primary};
      color: ${t.bg};
    }

    .btn-chapter-toggle:hover {
      background: ${t.border};
      color: ${t.text};
    }

    .btn-chapter-toggle:focus-visible {
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
