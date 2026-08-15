// Content-script glue for the recall nudge (entrypoints/content.ts), split
// out to keep that file under the aislop file-size budget — the same reason
// ui/pill-css.ts exists. Owns the nudge host element lifecycle and the
// bridge calls; ui/nudge.ts owns the component.

import { createNudge, type NudgeApi } from './nudge';
import { OVERLAY_Z_INDEX } from './styles';
import type { BridgeClient } from '../lib/messaging';
import type { RateRange } from '../lib/languages';

export interface NudgeSurface {
  /** Counts an apply toward the nudge; renders the overlay on {show:true}.
   * Report-only — never blocks or slows the apply path. range is the
   * current track language's safe zone, for the body copy. */
  reportApply(multiplier: number, range?: RateRange): void;
  /** 'Got it' (cooldown) or 'Don't show again' (permanent). */
  dismiss(forever: boolean): void;
  /** Navigation teardown: destroys the overlay and its host. */
  teardown(): void;
}

/** Host wrapper inside the player area; the nudge's shadow root lives here.
 * Positioning only — ui/nudge.ts owns the look. */
function nudgeHost(): HTMLElement {
  const anchor = document.querySelector<HTMLElement>('#movie_player') ?? document.body;
  const existing = anchor.querySelector<HTMLElement>(':scope > .speedwatcher-nudge-host');
  if (existing !== null) return existing;
  const wrapper = document.createElement('div');
  wrapper.className = 'speedwatcher-nudge-host';
  // Inline z-index only — positioning stays in the shadow :host rule.
  wrapper.style.zIndex = String(OVERLAY_Z_INDEX);
  anchor.appendChild(wrapper);
  return wrapper;
}

export function createNudgeHost(bridge: BridgeClient): NudgeSurface {
  let nudge: { api: NudgeApi; host: HTMLElement } | null = null;

  function ensureNudge(): NudgeApi {
    const host = nudgeHost();
    if (nudge !== null && nudge.host === host && host.isConnected) return nudge.api;
    // The player was replaced (SPA navigation): rebuild on the fresh host.
    nudge?.api.destroy();
    const api = createNudge(host, {
      onGotIt: () => dismiss(false),
      onDontShowAgain: () => dismiss(true),
    });
    nudge = { api, host };
    return nudge.api;
  }

  function dismiss(forever: boolean): void {
    // Best-effort: a dead bridge must not keep the nudge from hiding.
    void bridge.request({ type: 'nudge:dismiss', forever }).catch(() => undefined);
  }

  return {
    reportApply(multiplier: number, range?: RateRange): void {
      void bridge
        .request({ type: 'nudge:recordApply', multiplier })
        .then((result) => {
          if (result.show) ensureNudge().show({ range });
        })
        .catch(() => undefined);
    },
    dismiss,
    teardown(): void {
      nudge?.api.destroy();
      nudge = null;
    },
  };
}
