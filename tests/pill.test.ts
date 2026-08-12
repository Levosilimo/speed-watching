// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPill, warningNoteCopy, type PillState } from '../ui/pill';

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
    const pill = createPill(host, {});
    expect(host.shadowRoot).not.toBeNull(); // open: reachable from the host
    pill.mount();
    const root = rootOf(host);
    const surface = root.querySelector('.pill');
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute('data-mode')).toBe('hidden');
  });

  it('mounts twice without duplicating the shadow root', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    const root = rootOf(host);
    pill.mount();
    expect(host.shadowRoot).toBe(root);
  });

  it('keeps the live region on the text and off the action buttons', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
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
    const pill = createPill(host, {});
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

  it('renders the warning note for warning mode and picks the copy by reason', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
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
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state({ mode: 'warning', reason: 'pause-diluted', label: 'w' }));
    const note = rootOf(host).querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(warningNoteCopy('pause-diluted'));
  });

  it('hides the warning note outside warning mode', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    const note = rootOf(host).querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.hidden).toBe(true);
  });

  it('hides Apply for music and unreachable modes', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
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
    const pill = createPill(host, {});
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
    const pill = createPill(host, { onApply, onDismiss });
    pill.mount();
    pill.update(state({ multiplier: 1.55 }));
    rootOf(host).querySelector<HTMLButtonElement>('.btn-apply')!.click();
    expect(onApply).toHaveBeenCalledExactlyOnceWith(1.55);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('never fires onApply for music or unreachable states', () => {
    const onApply = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onApply });
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
    const pill = createPill(host, { onDismiss });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith();
  });

  it('applies on Enter keydown on the pill surface', () => {
    const onApply = vi.fn();
    const host = shadowHost();
    const pill = createPill(host, { onApply });
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
    const pill = createPill(host, { onApply, onDismiss });
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
    const pill = createPill(host, { onDismiss: vi.fn() });
    pill.mount();
    pill.update(state());
    // happy-dom cannot focus elements inside a shadow root, so the pre-click
    // focus assertion is skipped; the restore target lives in the light DOM.
    rootOf(host).querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(document.activeElement).toBe(player);
  });

  it('restores focus to the video element when there is no player anchor', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    const host = shadowHost();
    const pill = createPill(host, { onDismiss: vi.fn() });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(document.activeElement).toBe(video);
  });

  it('restores focus to body when neither player nor video exists', () => {
    const host = shadowHost();
    const pill = createPill(host, { onDismiss: vi.fn() });
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
    const pill = createPill(host, { onApply: vi.fn() });
    pill.mount();
    pill.update(state());
    rootOf(host).querySelector<HTMLButtonElement>('.btn-apply')!.click();
    expect(document.activeElement).toBe(player);
  });

  it('destroy is idempotent, clears the host, and makes update a no-op', () => {
    const host = shadowHost();
    const pill = createPill(host, {});
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
    const pill = createPill(host, {});
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
    const pill = createPill(host);
    pill.mount();
    pill.update(state({ label: '→ 1.9x ≈ 380 cpm' }));
    expect(rootOf(host).querySelector('.label')?.textContent).toBe('→ 1.9x ≈ 380 cpm');
    pill.destroy();
  });
});
