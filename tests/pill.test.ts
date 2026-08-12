// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPill, warningNoteCopy, type PillState } from '../ui/pill';

// The pill's shadow root is closed, so tests capture the root by replacing
// attachShadow on the prototype and querying the captured instance.
const originalAttachShadow = Element.prototype.attachShadow;

function capturedRoots(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    const root = originalAttachShadow.call(this, init);
    roots.push(root);
    return root;
  });
  return roots;
}

/** Host whose appendChild treats shadow-root attachment as a no-op. happy-dom
 * 20 relocates the root's children into the host instead of attaching it,
 * which would empty the captured root; real browsers attach the root. */
function shadowHost(): HTMLElement {
  const host = document.createElement('div');
  const append = host.appendChild.bind(host);
  host.appendChild = function <T extends Node>(node: T): T {
    return node instanceof ShadowRoot ? node : append(node);
  };
  return host;
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
  });

  it('renders a closed shadow root with the pill surface on mount', () => {
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    expect(roots).toHaveLength(1);
    expect(host.shadowRoot).toBeNull(); // closed: not reachable from the host
    pill.mount();
    expect(host.shadowRoot).toBeNull();
    const surface = roots[0]?.querySelector('.pill');
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute('role')).toBe('status');
    expect(surface?.getAttribute('aria-live')).toBe('polite');
  });

  it('mounts twice without duplicating the shadow root', () => {
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.mount();
    expect(roots).toHaveLength(1);
  });

  it('maps recommend mode to label, tier, and an enabled Apply button', () => {
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    const root = roots[0]!;
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
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state({ mode: 'warning', reason: 'above-zone', label: 'w', effectiveWpm: 280 }));
    const root = roots[0]!;
    expect(root.querySelector('.pill')?.getAttribute('data-mode')).toBe('warning');
    const note = root.querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(warningNoteCopy('above-zone'));
    expect(root.querySelector<HTMLButtonElement>('.btn-apply')?.dataset.variant).toBe('warning');
    pill.update(state({ mode: 'warning', reason: 'capped-below', label: 'w' }));
    expect(note.textContent).toBe(warningNoteCopy('capped-below'));
  });

  it('hides the warning note outside warning mode', () => {
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    const note = roots[0]!.querySelector<HTMLDivElement>('.warning-note')!;
    expect(note.hidden).toBe(true);
  });

  it('hides Apply for music and unreachable modes', () => {
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    const root = roots[0]!;
    for (const mode of ['music', 'unreachable'] as const) {
      pill.update(state({ mode, label: `m-${mode}` }));
      expect(root.querySelector<HTMLButtonElement>('.btn-apply')?.hidden).toBe(true);
      expect(root.querySelector('.pill')?.getAttribute('data-mode')).toBe(mode);
    }
  });

  it('hides the surface entirely for the none mode', () => {
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state({ mode: 'none', label: '' }));
    const surface = roots[0]!.querySelector('.pill')!;
    expect(surface.getAttribute('data-mode')).toBe('hidden');
    expect(surface.getAttribute('aria-hidden')).toBe('true');
  });

  it('fires onApply with the current multiplier on Apply click', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, { onApply, onDismiss });
    pill.mount();
    pill.update(state({ multiplier: 1.55 }));
    roots[0]!.querySelector<HTMLButtonElement>('.btn-apply')!.click();
    expect(onApply).toHaveBeenCalledExactlyOnceWith(1.55);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('never fires onApply for music or unreachable states', () => {
    const onApply = vi.fn();
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, { onApply });
    pill.mount();
    const apply = roots[0]!.querySelector<HTMLButtonElement>('.btn-apply')!;
    pill.update(state({ mode: 'music', label: 'm' }));
    apply.click();
    pill.update(state({ mode: 'unreachable', label: 'u' }));
    apply.click();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('fires onDismiss on the dismiss button click', () => {
    const onDismiss = vi.fn();
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, { onDismiss });
    pill.mount();
    pill.update(state());
    roots[0]!.querySelector<HTMLButtonElement>('.btn-dismiss')!.click();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith();
  });

  it('applies on Enter keydown on the pill surface', () => {
    const onApply = vi.fn();
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, { onApply });
    pill.mount();
    pill.update(state({ multiplier: 1.55 }));
    roots[0]!.querySelector('.pill')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(1.55);
  });

  it('destroy is idempotent, clears the host, and makes update a no-op', () => {
    const roots = capturedRoots();
    const host = shadowHost();
    const pill = createPill(host, {});
    pill.mount();
    pill.update(state());
    pill.destroy();
    pill.destroy(); // second call must not throw
    expect(host.innerHTML).toBe('');
    expect(roots[0]!.querySelector('.pill')).toBeNull();
    pill.update(state()); // no-op after destroy
    expect(roots[0]!.querySelector('.pill')).toBeNull();
  });
});
