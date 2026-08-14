// Nudge overlay stylesheet — the component's shadow-root CSS, split out of
// ui/nudge.ts to keep the component file under the aislop file-size budget
// (complexity/file-too-large), mirroring ui/pill-css.ts.

import { TOKENS, type Theme } from './styles';

export function nudgeCss(t: Theme): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :host {
      all: initial;
      display: block;
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 999999;
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textBase};
      line-height: 1.45;
      color: ${t.text};
      pointer-events: none;
    }

    .nudge {
      pointer-events: auto;
      width: min(480px, calc(100vw - 36px));
      padding: ${TOKENS.sp4} ${TOKENS.sp5};
      background: ${t.bg};
      border: 1px solid ${t.border};
      border-radius: ${TOKENS.rLg};
      box-shadow: ${t.shadowMd};
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }

    .nudge[hidden] { display: none; }

    .nudge-title {
      font-size: ${TOKENS.textMd};
      font-weight: 600;
      margin-bottom: ${TOKENS.sp2};
    }

    .nudge-body {
      color: ${t.textSecondary};
      margin-bottom: ${TOKENS.sp3};
    }

    .nudge-actions {
      display: flex;
      gap: ${TOKENS.sp2};
      justify-content: flex-end;
    }

    .btn-got-it {
      padding: ${TOKENS.sp1} ${TOKENS.sp3};
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textSm};
      font-weight: 600;
      border: none;
      border-radius: ${TOKENS.rPill};
      cursor: pointer;
      background: ${t.primary};
      color: ${t.bg};
      transition: background ${TOKENS.durationFast} ease;
    }

    .btn-got-it:hover { background: ${t.primaryHover}; }

    .btn-dont-again {
      padding: ${TOKENS.sp1} ${TOKENS.sp3};
      font-family: ${TOKENS.fontSans};
      font-size: ${TOKENS.textSm};
      color: ${t.textSecondary};
      background: transparent;
      border: none;
      border-radius: ${TOKENS.rPill};
      cursor: pointer;
      transition: background ${TOKENS.durationFast} ease,
                  color ${TOKENS.durationFast} ease;
    }

    .btn-dont-again:hover { background: ${t.border}; color: ${t.text}; }

    .btn-got-it:focus-visible,
    .btn-dont-again:focus-visible {
      outline: 2px solid ${t.primary};
      outline-offset: 2px;
      box-shadow: 0 0 0 4px ${t.focusRing};
    }
  `;
}
