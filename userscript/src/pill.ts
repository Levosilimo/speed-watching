// Minimal userscript pill: plain position:fixed div (no shadow root, no
// framework). Mirrors the extension pill's state contract (ui/pill.ts types)
// and carries the inline target prompt behind the Dismiss button.

import { TARGET_WPM_MAX, TARGET_WPM_MIN } from '../../lib/settings';
import type { LiveRate, PillState } from '../../ui/pill';

export interface PillApi {
  update(state: PillState): void;
  updateLiveRate(live: LiveRate | null): void;
  closeMenu(): void;
  isMenuOpen(): boolean;
}

export interface PillHandlers {
  onApply(): void;
  onSaveTarget(target: number): void;
  onClearTarget(): void;
}

interface PillDom {
  root: HTMLDivElement;
  label: HTMLDivElement;
  meta: HTMLDivElement;
  live: HTMLDivElement;
  applyBtn: HTMLButtonElement;
  dismissBtn: HTMLButtonElement;
  menu: HTMLDivElement;
  targetInput: HTMLInputElement;
  saveBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
}

const PILL_CSS = [
  'position:fixed',
  'top:64px',
  'right:16px',
  'z-index:2147483647',
  'display:none',
  'max-width:340px',
  'padding:10px 12px',
  'background:#212121',
  'color:#fff',
  'border-radius:8px',
  'box-shadow:0 2px 10px rgba(0,0,0,.5)',
  'font:13px/1.5 Roboto, Arial, sans-serif',
].join(';');

const BUTTON_CSS = 'padding:3px 10px;border:0;border-radius:4px;cursor:pointer';
const GHOST_BUTTON_CSS =
  'padding:3px 10px;border:0;border-radius:4px;background:transparent;color:#aaa;cursor:pointer';

function buildPillDom(): PillDom {
  const root = document.createElement('div');
  root.className = 'speedwatcher-pill';
  root.style.cssText = PILL_CSS;

  const label = document.createElement('div');
  const meta = document.createElement('div');
  meta.style.cssText = 'color:#aaa;font-size:11px';
  const live = document.createElement('div');
  live.style.cssText = 'color:#3ea6ff;font-size:11px;margin-top:2px;display:none';

  const actions = document.createElement('div');
  actions.style.cssText = 'margin-top:8px;text-align:right';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.textContent = 'Apply';
  applyBtn.style.cssText = `${BUTTON_CSS}background:#3ea6ff;color:#000`;
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.style.cssText = GHOST_BUTTON_CSS;
  actions.append(applyBtn, dismissBtn);

  const menu = document.createElement('div');
  menu.style.cssText = 'margin-top:8px;border-top:1px solid #444;padding-top:8px;display:none';
  const prompt = document.createElement('div');
  prompt.textContent = 'Target (wpm)';
  prompt.style.cssText = 'font-size:11px;color:#aaa';
  const targetInput = document.createElement('input');
  targetInput.type = 'number';
  targetInput.min = String(TARGET_WPM_MIN);
  targetInput.max = String(TARGET_WPM_MAX);
  targetInput.style.cssText =
    'width:70px;padding:3px;border:1px solid #555;border-radius:4px;background:#000;color:#fff';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = `${BUTTON_CSS}background:#3ea6ff;color:#000`;
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.style.cssText = GHOST_BUTTON_CSS;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px';
  row.append(targetInput, saveBtn, clearBtn);
  menu.append(prompt, row);

  root.append(label, meta, live, actions, menu);
  return { root, label, meta, live, applyBtn, dismissBtn, menu, targetInput, saveBtn, clearBtn };
}

export function createPill(
  handlers: PillHandlers,
  readStoredTarget: () => number | undefined,
): PillApi {
  const dom = buildPillDom();
  document.body.appendChild(dom.root);
  let state: PillState = { mode: 'none', rateWpm: 0, multiplier: 1, effectiveWpm: 0, label: '' };
  let menuOpen = false;

  const setMenuOpen = (open: boolean): void => {
    menuOpen = open;
    dom.menu.style.display = open ? 'block' : 'none';
  };

  dom.applyBtn.addEventListener('click', () => handlers.onApply());
  dom.dismissBtn.addEventListener('click', () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    dom.targetInput.value = readStoredTarget()?.toString() ?? '';
    setMenuOpen(true);
  });
  dom.saveBtn.addEventListener('click', () => {
    const parsed = Number(dom.targetInput.value);
    if (Number.isFinite(parsed) && parsed >= TARGET_WPM_MIN && parsed <= TARGET_WPM_MAX) {
      handlers.onSaveTarget(parsed);
    }
    setMenuOpen(false);
  });
  dom.clearBtn.addEventListener('click', () => {
    handlers.onClearTarget();
    setMenuOpen(false);
  });

  return {
    update(next: PillState): void {
      state = next;
      dom.label.textContent = state.label;
      dom.meta.textContent = state.tierLabel ?? '';
      dom.root.style.display = state.mode === 'none' ? 'none' : 'block';
      dom.applyBtn.style.display =
        state.mode === 'music' || state.mode === 'unreachable' ? 'none' : '';
    },
    updateLiveRate(live: LiveRate | null): void {
      dom.live.style.display = live === null ? 'none' : '';
      if (live !== null) {
        dom.live.textContent = `live ≈ ${Math.round(live.rate)} ${live.unit} @ ${live.multiplier}x`;
      }
    },
    closeMenu(): void {
      setMenuOpen(false);
    },
    isMenuOpen(): boolean {
      return menuOpen;
    },
  };
}
