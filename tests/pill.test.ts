// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPill,
  warningNoteCopy,
  type PillApi,
  type PillMode,
  type PillState,
} from '../ui/pill';

describe('createPill stop-auto button', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function stopAutoOf(host: HTMLElement): HTMLButtonElement {
    const el = rootOf(host).querySelector<HTMLButtonElement>('.btn-stop-auto');
    if (el === null) throw new Error('expected a .btn-stop-auto element');
    return el;
  }

  it('renders ONLY for applied === auto in recommend mode (user/none/absent hide)', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const stopAuto = stopAutoOf(host);
    pill.update(state({ applied: 'user' }));
    expect(stopAuto.hidden).toBe(true);
    pill.update(state({ applied: 'none' }));
    expect(stopAuto.hidden).toBe(true);
    pill.update(state()); // absent ≡ none
    expect(stopAuto.hidden).toBe(true);
    pill.update(state({ applied: 'auto' }));
    expect(stopAuto.hidden).toBe(false);
    expect(stopAuto.textContent).toBe('Stop auto');
    expect(stopAuto.getAttribute('aria-label')).toBe(
      'Stop applying the recommended speed automatically',
    );
    // Non-recommend modes never show it, even while applied === auto.
    pill.update(state({ applied: 'auto', mode: 'warning', reason: 'above-zone' }));
    expect(stopAuto.hidden).toBe(true);
  });

  it('stale-hides after a NONE_STATE update', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const stopAuto = stopAutoOf(host);
    pill.update(state({ applied: 'auto' }));
    expect(stopAuto.hidden).toBe(false);
    pill.update(state({ mode: 'none', label: '', applied: 'none' }));
    expect(stopAuto.hidden).toBe(true);
  });

  it('fires onStopAuto on click; onApply and onDismiss stay silent', () => {
    const onStopAuto = vi.fn();
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onStopAuto, onApply, onDismiss }, { locale: 'en' });
    pill.mount();
    pill.update(state({ applied: 'auto' }));
    stopAutoOf(host).click();
    expect(onStopAuto).toHaveBeenCalledExactlyOnceWith();
    expect(onApply).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('localizes the stop-auto label for ru', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(state({ applied: 'auto' }));
    const stopAuto = stopAutoOf(host);
    expect(stopAuto.textContent).toBe('Остановить авто');
    expect(stopAuto.getAttribute('aria-label')).toBe(
      'Перестать автоматически применять рекомендованную скорость',
    );
  });

  it('becomes the undo affordance in the auto state: Apply hidden, Reset to {rate}× label', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const root = rootOf(host);
    pill.update(state({ applied: 'auto', undoRate: 1 }));
    const apply = root.querySelector<HTMLButtonElement>('.btn-apply')!;
    const stopAuto = stopAutoOf(host);
    // P1b: the redundant Apply is dropped in the auto-applied state.
    expect(apply.hidden).toBe(true);
    expect(stopAuto.hidden).toBe(false);
    // P1a: the undo restores the pre-auto rate — the button says what it
    // will do.
    expect(stopAuto.textContent).toBe('Reset to 1×');
    expect(stopAuto.getAttribute('aria-label')).toBe(
      'Restore the playback speed that played before auto-apply',
    );
    pill.update(state({ applied: 'auto', undoRate: 1.25 }));
    expect(stopAuto.textContent).toBe('Reset to 1.25×');
  });

  it('localizes the undo affordance and the auto label marker for ru', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    const root = rootOf(host);
    pill.update(state({ applied: 'auto', undoRate: 1 }));
    expect(stopAutoOf(host).textContent).toBe('Сбросить до 1×');
    expect(root.querySelector('.label')?.textContent).toBe('Авто · 1,55× ≈ 248 слов/мин');
  });

  it('leads the label line with the Auto marker and drops the arrow (P1b)', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ applied: 'auto', undoRate: 1 }));
    expect(rootOf(host).querySelector('.label')?.textContent).toBe('Auto · 1.55x ≈ 248 wpm');
    // Without the auto state the verbatim recommendation label stays.
    pill.update(state());
    expect(rootOf(host).querySelector('.label')?.textContent).toBe('→ 1.55x ≈ 248 wpm');
  });

  it('routes Enter to the undo in the auto-applied state, not Apply', () => {
    const onStopAuto = vi.fn();
    const onApply = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onStopAuto, onApply }, { locale: 'en' });
    pill.mount();
    pill.update(state({ applied: 'auto', undoRate: 1 }));
    rootOf(host).querySelector('.pill')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    expect(onStopAuto).toHaveBeenCalledExactlyOnceWith();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('keeps the stop-auto button outside the live-region main text', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ applied: 'auto' }));
    expect(rootOf(host).querySelector('.main-text .btn-stop-auto')).toBeNull();
    expect(rootOf(host).querySelector<HTMLDivElement>('.actions')?.contains(
      rootOf(host).querySelector('.btn-stop-auto')!,
    )).toBe(true);
  });
});

// The pill's shadow root is open (accessibility: closed roots are invisible
// to assistive tech), so tests reach the surface through host.shadowRoot.

/** Host whose appendChild treats shadow-root attachment as a no-op. happy-dom
 * 20 relocates the root's children into the host instead of attaching it,
 * which would empty the root; real browsers attach the root. */
function shadowHost(): HTMLElement {
  const host = document.createElement('div');
  const append = host.appendChild.bind(host);
  host.appendChild = function <T extends Node>(node: T): T {
    return node instanceof ShadowRoot ? node : append(node);
  };
  return host;
}

function rootOf(host: HTMLElement): ShadowRoot {
  const root = host.shadowRoot;
  if (root === null) throw new Error('expected an open shadow root');
  return root;
}

function state(overrides: Partial<PillState> = {}): PillState {
  return {
    mode: 'recommend',
    rateWpm: 160,
    multiplier: 1.55,
    effectiveWpm: 248,
    tierLabel: 'from captions',
    label: '→ 1.55x ≈ 248 wpm',
    ...overrides,
  };
}

describe('createPill', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders an open shadow root with the pill surface on mount', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    expect(host.shadowRoot).not.toBeNull(); // open: reachable from the host
    pill.mount();
    const root = rootOf(host);
    const surface = root.querySelector('.pill');
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute('data-mode')).toBe('hidden');
  });

  it('mounts twice without duplicating the shadow root', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const root = rootOf(host);
    pill.mount();
    expect(host.shadowRoot).toBe(root);
  });

  it('mounts exactly a style and the pill surface in the shadow root', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const root = rootOf(host);
    // Browser equivalent of `:scope > *` count === 2 (happy-dom has no
    // :scope): a relocation bug would orphan the style or the surface.
    expect(root.children).toHaveLength(2);
    const [style, surface] = [...root.children] as [HTMLElement, HTMLElement];
    expect(style.tagName).toBe('STYLE');
    expect(surface.classList.contains('pill')).toBe(true);
  });

  it('keeps the live region on the text and off the action buttons', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const root = rootOf(host);
    const surface = root.querySelector('.pill')!;
    expect(surface.getAttribute('role')).toBeNull();
    expect(surface.getAttribute('aria-live')).toBeNull();
    const mainText = root.querySelector<HTMLDivElement>('.main-text')!;
    expect(mainText.getAttribute('role')).toBe('status');
    expect(mainText.getAttribute('aria-live')).toBeNull(); // implied by role=status
    expect(root.querySelector('.main-text .actions')).toBeNull();
    expect(root.querySelector<HTMLDivElement>('.actions')?.contains(
      root.querySelector('.btn-apply')!,
    )).toBe(true);
  });

  it('maps recommend mode to label, tier, and an enabled Apply button', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    const root = rootOf(host);
    const surface = root.querySelector('.pill');
    expect(surface?.getAttribute('data-mode')).toBe('recommend');
    expect(surface?.getAttribute('aria-hidden')).toBeNull();
    expect(root.querySelector('.label')?.textContent).toBe('→ 1.55x ≈ 248 wpm');
    expect(root.querySelector<HTMLSpanElement>('.tier')?.textContent).toBe('from captions');
    expect(root.querySelector<HTMLSpanElement>('.tier')?.hidden).toBe(false);
    const apply = root.querySelector<HTMLButtonElement>('.btn-apply')!;
    expect(apply.hidden).toBe(false);
    expect(apply.dataset.variant).toBe('primary');
    expect(apply.getAttribute('aria-label')).toBe('Apply 1.6x playback speed');
  });

  it('appends the caption-collapse copy to the estimated tier badge', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ tierLabel: 'estimated', captionStatus: 'no-track' }));
    expect(rootOf(host).querySelector<HTMLSpanElement>('.tier')?.textContent).toBe('estimated · no captions found');
    pill.update(state({ tierLabel: 'estimated', captionStatus: 'fetch-failed' }));
    expect(rootOf(host).querySelector<HTMLSpanElement>('.tier')?.textContent).toBe('estimated · captions unavailable');
    pill.update(state({ tierLabel: 'estimated', captionStatus: 'capture-missed' }));
    expect(rootOf(host).querySelector<HTMLSpanElement>('.tier')?.textContent).toBe('estimated · captions empty');
    // A measured tier with no collapse keeps the plain badge.
    pill.update(state({ tierLabel: 'from captions' }));
    expect(rootOf(host).querySelector<HTMLSpanElement>('.tier')?.textContent).toBe('from captions');
  });

  it('renders the warning note for warning mode and picks the copy by reason', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ mode: 'warning', reason: 'above-zone', label: 'w', effectiveWpm: 280 }));
    const root = rootOf(host);
    expect(root.querySelector('.pill')?.getAttribute('data-mode')).toBe('warning');
    const note = root.querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(warningNoteCopy('above-zone'));
    expect(root.querySelector<HTMLButtonElement>('.btn-apply')?.dataset.variant).toBe('warning');
    pill.update(state({ mode: 'warning', reason: 'capped-below', label: 'w' }));
    expect(note.textContent).toBe(warningNoteCopy('capped-below'));
  });

  it('maps the pause-diluted reason to the articulatory note', () => {
    expect(warningNoteCopy('pause-diluted')).toBe(
      'Speech runs fast at this speed — estimate uncertain',
    );
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ mode: 'warning', reason: 'pause-diluted', label: 'w' }));
    const note = rootOf(host).querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(warningNoteCopy('pause-diluted'));
  });

  it('hides the warning note outside warning mode', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    const note = rootOf(host).querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.hidden).toBe(true);
  });

  it('hides Apply for music and unreachable modes', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const root = rootOf(host);
    for (const mode of ['music', 'unreachable'] as const) {
      pill.update(state({ mode, label: `m-${mode}` }));
      expect(root.querySelector<HTMLButtonElement>('.btn-apply')?.hidden).toBe(true);
      expect(root.querySelector('.pill')?.getAttribute('data-mode')).toBe(mode);
    }
  });

  it('hides the surface entirely for the none mode', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ mode: 'none', label: '' }));
    const surface = rootOf(host).querySelector('.pill')!;
    expect(surface.getAttribute('data-mode')).toBe('hidden');
    expect(surface.getAttribute('aria-hidden')).toBe('true');
  });

  it('fires onApply with the current multiplier on Apply click', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onApply, onDismiss }, { locale: 'en' });
    pill.mount();
    pill.update(state({ multiplier: 1.55 }));
    rootOf(host).querySelector<HTMLButtonElement>('.btn-apply')!.click();
    expect(onApply).toHaveBeenCalledExactlyOnceWith(1.55);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('never fires onApply for music or unreachable states', () => {
    const onApply = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onApply }, { locale: 'en' });
    pill.mount();
    const apply = rootOf(host).querySelector<HTMLButtonElement>('.btn-apply')!;
    pill.update(state({ mode: 'music', label: 'm' }));
    apply.click();
    pill.update(state({ mode: 'unreachable', label: 'u' }));
    apply.click();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('fires onDismiss on the dismiss button click', () => {
    const onDismiss = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onDismiss }, { locale: 'en' });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith();
  });

  it('applies on Enter keydown on the pill surface', () => {
    const onApply = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onApply }, { locale: 'en' });
    pill.mount();
    pill.update(state({ multiplier: 1.55 }));
    rootOf(host).querySelector('.pill')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    expect(onApply).toHaveBeenCalledExactlyOnceWith(1.55);
  });

  it('dismisses on Escape keydown on the pill surface', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onDismiss }, { locale: 'en' });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector('.pill')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape' }),
    );
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('restores focus to the player anchor after dismiss', () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    const host = shadowHost();
    const pill = createPill(host, { onDismiss: vi.fn() }, { locale: 'en' });
    pill.mount();
    pill.update(state());
    // The pre-click focus state is pinned by the chromium lane
    // (interaction.spec.ts (c)); here only the restore target is asserted.
    rootOf(host).querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(document.activeElement).toBe(player);
  });

  it('restores focus to the video element when there is no player anchor', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    const host = shadowHost();
    const pill = createPill(host, { onDismiss: vi.fn() }, { locale: 'en' });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(document.activeElement).toBe(video);
  });

  it('restores focus to body when neither player nor video exists', () => {
    const host = shadowHost();
    const pill = createPill(host, { onDismiss: vi.fn() }, { locale: 'en' });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(document.activeElement).toBe(document.body);
  });

  it('restores focus to the player anchor after apply', () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    const host = shadowHost();
    const pill = createPill(host, { onApply: vi.fn() }, { locale: 'en' });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector<HTMLButtonElement>('.btn-apply')!.click();
    expect(document.activeElement).toBe(player);
  });

  it('destroy is idempotent, clears the host, and makes update a no-op', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    const root = rootOf(host);
    pill.destroy();
    pill.destroy(); // second call must not throw
    expect(host.innerHTML).toBe('');
    expect(root.querySelector('.pill')).toBeNull();
    pill.update(state()); // no-op after destroy
    expect(root.querySelector('.pill')).toBeNull();
  });

  it('destroy detaches the host so the next pill mounts clean (video churn)', () => {
    const host = shadowHost();
    document.body.appendChild(host);
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.destroy();
    // The content scripts re-resolve the host after churn (querySelector
    // finds no .speedwatcher-pill-host): the destroyed host must be gone.
    expect(host.isConnected).toBe(false);
    const fresh = shadowHost();
    document.body.appendChild(fresh);
    // Remount on the fresh host — attachShadow on the old host would throw.
    expect(() => createPill(fresh, {})).not.toThrow();
    expect(fresh.shadowRoot).not.toBeNull();
  });

  it('renders the label with the language rate unit (cpm)', () => {
    const host = shadowHost();
    const pill = createPill(host, undefined, { locale: 'en' });
    pill.mount();
    pill.update(state({ label: '→ 1.9x ≈ 380 cpm' }));
    expect(rootOf(host).querySelector('.label')?.textContent).toBe('→ 1.9x ≈ 380 cpm');
    pill.destroy();
  });
});

describe('pill contract (lib-16 guard)', () => {
  it('keeps the mode union exactly the five contract modes', () => {
    // The tuple type-checks against the union: a removed or renamed mode
    // breaks compilation; the runtime set pins the exact list.
    const modes: PillMode[] = ['recommend', 'warning', 'unreachable', 'music', 'none'];
    expect(new Set(modes)).toEqual(new Set(['recommend', 'warning', 'unreachable', 'music', 'none']));
    // Every mode renders without throwing and lands in data-mode (none
    // hides the surface — the 'hidden' state is its render contract).
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    for (const mode of modes) {
      pill.update(state({ mode, label: mode }));
      const surface = rootOf(host).querySelector('.pill')!;
      expect(surface.getAttribute('data-mode')).toBe(mode === 'none' ? 'hidden' : mode);
    }
  });

  it('exposes exactly {mount, update, updateLiveRate, updateSavedSec, destroy} on PillApi', () => {
    const pill: PillApi = createPill(shadowHost(), {}, { locale: 'en' });
    expect(Object.keys(pill).sort()).toEqual([
      'destroy',
      'mount',
      'update',
      'updateLiveRate',
      'updateSavedSec',
    ]);
  });

  it('keeps PillState free of nudge fields — the nudge is a separate surface', () => {
    const pillState: PillState = state();
    expect(Object.keys(pillState).filter((key) => key.includes('nudge'))).toEqual([]);
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(pillState);
    // No nudge markup may appear inside the pill's shadow root.
    expect(rootOf(host).querySelector('.nudge')).toBeNull();
    expect(rootOf(host).querySelector('[data-nudge]')).toBeNull();
  });
});

describe('createPill — ru locale', () => {
  it('renders Russian strings: label, tier, buttons, warning note', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(
      state({ mode: 'warning', reason: 'above-zone', effectiveWpm: 248 }),
    );
    const root = rootOf(host);
    expect(root.querySelector('.label')?.textContent).toBe('→ 1,55× ≈ 248 слов/мин');
    expect(root.querySelector('.tier')?.textContent).toBe('по субтитрам');
    expect(root.querySelector('.warning-note')?.textContent).toBe(
      warningNoteCopy('above-zone', 'ru'),
    );
    const apply = root.querySelector<HTMLButtonElement>('.btn-apply')!;
    expect(apply.textContent).toBe('Применить');
    expect(apply.getAttribute('aria-label')).toBe('Применить скорость 1,6×');
    expect(root.querySelector<HTMLButtonElement>('.btn-dismiss')?.getAttribute('aria-label')).toBe(
      'Закрыть',
    );
  });

  it('localizes the unreachable and music labels', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(
      state({ mode: 'unreachable', label: 'safe zone unreachable — 2x ≈ 170 wpm', effectiveWpm: 170, multiplier: 2 }),
    );
    expect(rootOf(host).querySelector('.label')?.textContent).toBe(
      'комфортная зона недостижима — 2× ≈ 170 слов/мин',
    );
    pill.update(state({ mode: 'music', label: 'music — speed not recommended' }));
    expect(rootOf(host).querySelector('.label')?.textContent).toBe(
      'музыка — скорость не рекомендуется',
    );
  });

  it('renders the Russian live-rate line with the localized unit', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(state());
    // A live rate that duplicates the label's effective rate is hidden
    // (P2b) — push a divergent one so the localization is exercised.
    pill.updateLiveRate({ rate: 251, multiplier: 1.6, unit: 'wpm' });
    expect(rootOf(host).querySelector('.live-rate')?.textContent).toBe(
      'сейчас ≈ 251 слов/мин при 1,6×',
    );
    pill.updateLiveRate({ rate: 380, multiplier: 1.9, unit: 'morae/min' });
    expect(rootOf(host).querySelector('.live-rate')?.textContent).toBe(
      'сейчас ≈ 380 мор/мин при 1,9×',
    );
  });

  it('localizes the non-wpm units in the main label', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(state({ label: '→ 1.9x ≈ 380 morae/min', effectiveWpm: 380, multiplier: 1.9 }));
    expect(rootOf(host).querySelector('.label')?.textContent).toBe('→ 1,9× ≈ 380 мор/мин');
    pill.update(state({ label: '→ 1.5x ≈ 340 syl/min', effectiveWpm: 340, multiplier: 1.5 }));
    expect(rootOf(host).querySelector('.label')?.textContent).toBe('→ 1,5× ≈ 340 слогов/мин');
    pill.update(state({ label: '→ 1.5x ≈ 340 cpm', effectiveWpm: 340, multiplier: 1.5 }));
    expect(rootOf(host).querySelector('.label')?.textContent).toBe('→ 1,5× ≈ 340 симв/мин');
  });

  it('keeps the ru data model identical: same mode and multiplier as en', () => {
    const en = shadowHost();
    const ru = shadowHost();
    createPill(en, {}, { locale: 'en' }).mount();
    const pillRu = createPill(ru, {}, { locale: 'ru' });
    pillRu.mount();
    const input = state({ mode: 'warning', reason: 'capped-below', effectiveWpm: 240 });
    pillRu.update(input);
    expect(rootOf(ru).querySelector('.pill')?.getAttribute('data-mode')).toBe('warning');
    expect(rootOf(ru).querySelector('.label')?.textContent).toBe(
      '→ 1,55× ≈ 240 слов/мин (ниже комфортной зоны)',
    );
  });

  it('resolves the locale from settings.uiLanguage through the bridge', async () => {
    const host = shadowHost();
    const original = window.postMessage;
    // The bridge never answers in happy-dom; stub a response envelope so
    // the pill's locale fetch resolves to the stored uiLanguage.
    window.postMessage = ((message: unknown) => {
      const payload = (message as { payload?: { id?: number } }).payload ?? {};
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            channel: 'speedwatcher:bridge',
            direction: 'response',
            payload: {
              id: payload.id ?? 1,
              ok: true,
              result: { conservative: false, platformMax: 2, sites: {}, contentTypes: {}, uiLanguage: 'ru' },
            },
          },
        }),
      );
    }) as typeof window.postMessage;
    try {
      const pill = createPill(host, {});
      pill.mount();
      pill.update(state());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rootOf(host).querySelector('.label')?.textContent).toBe('→ 1,55× ≈ 248 слов/мин');
    } finally {
      window.postMessage = original;
    }
  });
});

describe('warningNoteCopy keys the range to the track language (P0)', () => {
  it('renders the en 250–275 defaults when no track range resolves', () => {
    expect(warningNoteCopy('above-zone')).toBe(
      'Past the 250–275 wpm range commonly cited for comfortable listening',
    );
    expect(warningNoteCopy('above-zone', 'ru')).toBe(
      'Скорость выше диапазона 250–275 слов/мин, который обычно считают комфортным',
    );
  });

  it('renders the ru track range (168–180 слов/мин), never the en 250–275', () => {
    const note = warningNoteCopy('above-zone', 'ru', { lo: 168, hi: 180, unit: 'wpm' });
    expect(note).toContain('168–180');
    expect(note).toContain('слов/мин');
    expect(note).not.toContain('250');
    // The en UI renders the same track range in English.
    expect(warningNoteCopy('above-zone', 'en', { lo: 168, hi: 180, unit: 'wpm' })).toContain(
      'Past the 168–180 wpm range',
    );
  });

  it('renders the resolved track range through the pill surface', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(
      state({
        mode: 'warning',
        reason: 'above-zone',
        label: 'w',
        effectiveWpm: 200,
        range: { lo: 168, hi: 180, unit: 'wpm' },
      }),
    );
    const note = rootOf(host).querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.textContent).toBe(
      'Скорость выше диапазона 168–180 слов/мин, который обычно считают комфортным',
    );
  });

  it('keeps capped-below and pause-diluted copy free of range params', () => {
    expect(warningNoteCopy('capped-below', 'ru', { lo: 168, hi: 180, unit: 'wpm' })).toBe(
      'Оценка неточна — для безопасности скорость ограничена 1,5×',
    );
    expect(warningNoteCopy('pause-diluted', 'en', { lo: 168, hi: 180, unit: 'wpm' })).toBe(
      'Speech runs fast at this speed — estimate uncertain',
    );
  });
});

describe('createPill first-run onboarding line (P1c)', () => {
  it('renders the measured-rate explainer when flagged and hides otherwise', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const line = rootOf(host).querySelector<HTMLDivElement>('.first-run')!;
    pill.update(state());
    expect(line.hidden).toBe(true);
    pill.update(state({ firstRun: true }));
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe(
      "We measured this video's speech at ~160 wpm — playing at 1.55× lands ~248 wpm, a comfortable rate. Apply or dismiss.",
    );
    // A later render without the flag hides it again.
    pill.update(state());
    expect(line.hidden).toBe(true);
  });

  it('localizes the first-run line for ru', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(state({ firstRun: true }));
    expect(rootOf(host).querySelector('.first-run')?.textContent).toBe(
      'Мы измерили темп речи в этом видео: ~160 слов/мин — воспроизведение на 1,55× даст ~248 слов/мин, комфортный темп. Применить или закрыть.',
    );
  });
});

describe('createPill saved-time line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function savedElOf(host: HTMLElement): HTMLSpanElement {
    const el = rootOf(host).querySelector<HTMLSpanElement>('.saved-time');
    if (el === null) throw new Error('expected a .saved-time element');
    return el;
  }

  it('renders the saved line in recommend mode when saved >= 30', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    pill.updateSavedSec(120);

    const saved = savedElOf(host);
    expect(saved.hidden).toBe(false);
    expect(saved.textContent).toBe('~2 minutes saved (estimate)');
  });

  it('hides the line below the 30 s floor and shows it at exactly 30', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    const saved = savedElOf(host);
    pill.updateSavedSec(29);
    expect(saved.hidden).toBe(true);
    pill.updateSavedSec(30);
    expect(saved.hidden).toBe(false);
    expect(saved.textContent).toBe('~30 seconds saved (estimate)');
  });

  it('shows the line in warning mode as well', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ mode: 'warning', reason: 'above-zone' }));
    pill.updateSavedSec(120);

    expect(savedElOf(host).hidden).toBe(false);
  });

  it('stays hidden in music, unreachable and none modes even with saved > 0', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    for (const mode of ['music', 'unreachable', 'none'] as const) {
      pill.update(state({ mode, label: `m-${mode}` }));
      pill.updateSavedSec(120);
      expect(savedElOf(host).hidden).toBe(true);
    }
  });

  it('hides the line for null and for sub-floor saved time', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    pill.updateSavedSec(120);
    expect(savedElOf(host).hidden).toBe(false);

    pill.updateSavedSec(null);
    expect(savedElOf(host).hidden).toBe(true);

    // A sub-floor amount is not worth a line.
    pill.updateSavedSec(0);
    expect(savedElOf(host).hidden).toBe(true);
    pill.updateSavedSec(20);
    expect(savedElOf(host).hidden).toBe(true);
  });

  it('throttles: an equal push is a no-op', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    const saved = savedElOf(host);

    pill.updateSavedSec(120);
    pill.updateSavedSec(120);
    expect(saved.textContent).toBe('~2 minutes saved (estimate)');
    expect(saved.hidden).toBe(false);
  });

  it('drops the stale value when a full update leaves recommend/warning', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state());
    pill.updateSavedSec(120);
    pill.update(state({ mode: 'none', label: '' }));
    expect(savedElOf(host).hidden).toBe(true);

    // Back to recommend without a fresh push: the stale line must not
    // resurrect itself.
    pill.update(state());
    expect(savedElOf(host).hidden).toBe(true);
  });

  it('localizes the saved line for ru', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(state());
    pill.updateSavedSec(120);
    expect(savedElOf(host).textContent).toBe('~2 минуты сэкономлено (оценка)');
  });
});

describe('createPill skip-silence indicator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function savedElOf(host: HTMLElement): HTMLSpanElement {
    const el = rootOf(host).querySelector<HTMLSpanElement>('.saved-time');
    if (el === null) throw new Error('expected a .saved-time element');
    return el;
  }

  it('shows the indicator in recommend mode while skipSlowed, even with no saved time', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ skipSlowed: true }));
    const saved = savedElOf(host);
    expect(saved.hidden).toBe(false);
    expect(saved.textContent).toBe('silence: slowed');
  });

  it('shows the indicator in warning mode too', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ mode: 'warning', reason: 'above-zone', skipSlowed: true }));
    expect(savedElOf(host).hidden).toBe(false);
  });

  it('hides the indicator outside recommend/warning even while skipSlowed', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ mode: 'none', label: '', skipSlowed: true }));
    expect(savedElOf(host).hidden).toBe(true);
  });

  it('a saved-time push during the gap keeps the indicator', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ skipSlowed: true }));
    const saved = savedElOf(host);
    expect(saved.textContent).toBe('silence: slowed');
    pill.updateSavedSec(null); // the content script's gate hides saved time in the gap
    expect(saved.hidden).toBe(false);
    expect(saved.textContent).toBe('silence: slowed');
  });

  it('returns to the saved-time text when the gap ends (state flip)', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ skipSlowed: true }));
    pill.update(state({ skipSlowed: false }));
    pill.updateSavedSec(120);
    expect(savedElOf(host).textContent).toBe('~2 minutes saved (estimate)');
  });

  it('localizes the indicator for ru', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(state({ skipSlowed: true }));
    expect(savedElOf(host).textContent).toBe('тишина: замедлено');
  });
});

describe('createPill live-line duplication (P2b)', () => {
  it('hides the live line when it duplicates the label (same rate, same multiplier)', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    pill.update(state({ effectiveWpm: 248, multiplier: 1.55 }));
    const live = rootOf(host).querySelector<HTMLSpanElement>('.live-rate')!;
    // Auto-applied state: the live rate equals the label's effective rate.
    pill.updateLiveRate({ rate: 248.3, multiplier: 1.55, unit: 'wpm' });
    expect(live.hidden).toBe(true);
    // A divergent rate is new information — the line shows.
    pill.updateLiveRate({ rate: 251, multiplier: 1.6, unit: 'wpm' });
    expect(live.hidden).toBe(false);
    expect(live.textContent).toBe('now ≈ 251 wpm at 1.6x');
  });
});

describe('createPill chapter consent toggle (chapters feature)', () => {
  function toggleOf(host: HTMLElement): HTMLButtonElement {
    const el = rootOf(host).querySelector<HTMLButtonElement>('.btn-chapter-toggle');
    if (el === null) throw new Error('expected a .btn-chapter-toggle element');
    return el;
  }
  function statusOf(host: HTMLElement): HTMLSpanElement {
    const el = rootOf(host).querySelector<HTMLSpanElement>('.chapter-status');
    if (el === null) throw new Error('expected a .chapter-status element');
    return el;
  }

  it('renders ONLY for chaptersAvailable in recommend/warning; other modes hide it', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const toggle = toggleOf(host);
    // Without chapters: never shown, whatever the mode.
    pill.update(state({ chaptersAvailable: false }));
    expect(toggle.hidden).toBe(true);
    pill.update(state({ chaptersAvailable: true }));
    expect(toggle.hidden).toBe(false);
    pill.update(state({ chaptersAvailable: true, mode: 'warning', reason: 'above-zone' }));
    expect(toggle.hidden).toBe(false);
    for (const mode of ['music', 'unreachable', 'none'] as const) {
      pill.update(state({ chaptersAvailable: true, mode, label: mode }));
      expect(toggle.hidden).toBe(true);
    }
    // A stale chaptersAvailable must flip back off when the surface hides.
    pill.update(state({ chaptersAvailable: true }));
    expect(toggle.hidden).toBe(false);
    pill.update(state({ mode: 'none', label: '', chaptersAvailable: true }));
    expect(toggle.hidden).toBe(true);
  });

  it('fires onAutoAdjust with the consent toggling; aria-pressed tracks the state', () => {
    const onAutoAdjust = vi.fn();
    const onApply = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onAutoAdjust, onApply }, { locale: 'en' });
    pill.mount();
    const toggle = toggleOf(host);
    pill.update(state({ chaptersAvailable: true }));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.textContent).toBe('Auto-adjust per chapter');
    expect(toggle.getAttribute('aria-label')).toBe(
      'Automatically adjust playback speed at chapter boundaries',
    );
    toggle.click();
    expect(onAutoAdjust).toHaveBeenCalledExactlyOnceWith(true);
    expect(onApply).not.toHaveBeenCalled();
    pill.update(state({ chaptersAvailable: true, autoAdjust: true }));
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(onAutoAdjust).toHaveBeenLastCalledWith(false);
  });

  it('Enter on the toggle does not route to Apply (the pill keydown stands down)', () => {
    const onAutoAdjust = vi.fn();
    const onApply = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onAutoAdjust, onApply }, { locale: 'en' });
    pill.mount();
    pill.update(state({ chaptersAvailable: true }));
    // A synthetic keydown cannot run the browser's native button activation;
    // the guard's half is that the pill's Enter routing stays off the toggle.
    toggleOf(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onAutoAdjust).not.toHaveBeenCalled();
  });

  it('status line: hidden off; active/yielded/music copy while on', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'en' });
    pill.mount();
    const status = statusOf(host);
    pill.update(state({ chaptersAvailable: true }));
    expect(status.hidden).toBe(true);
    pill.update(state({ chaptersAvailable: true, autoAdjust: true }));
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Chapter rates on');
    pill.update(state({ chaptersAvailable: true, autoAdjust: true, chapterStatus: 'yielded' }));
    expect(status.textContent).toBe('Paused chapter rates');
    pill.update(state({ chaptersAvailable: true, autoAdjust: true, chapterStatus: 'music' }));
    expect(status.textContent).toBe('1× in music chapter');
    // Consent off hides the status again; the string must not linger.
    pill.update(state({ chaptersAvailable: true, autoAdjust: false, chapterStatus: 'music' }));
    expect(status.hidden).toBe(true);
  });

  it('localizes the toggle and the status line for ru', () => {
    const host = shadowHost();
    const pill = createPill(host, {}, { locale: 'ru' });
    pill.mount();
    pill.update(state({ chaptersAvailable: true }));
    const toggle = toggleOf(host);
    expect(toggle.textContent).toBe('Авто-подстройка по главам');
    expect(toggle.getAttribute('aria-label')).toBe(
      'Автоматически менять скорость на границах глав',
    );
    pill.update(state({ chaptersAvailable: true, autoAdjust: true, chapterStatus: 'music' }));
    expect(statusOf(host).textContent).toBe('1× в музыкальной главе');
  });
});
