// Options-page audio capture test — the shipped justification for the
// tabCapture/offscreen permissions. Split out of entrypoints/options/main.ts
// to keep that file under the aislop size budget (the dev.ts precedent).
// Chrome-only: Firefox has no offscreen API, so the section is hidden and
// inert there. probe-start/stop/state are answered by the background
// orchestrator, the meter by its offscreen 'level' events.

import { browser } from 'wxt/browser';
import type { ProbeState } from '../lib/audio-probe';
import { t, type I18nKey, type UiLocale } from '../lib/i18n';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

const probeSection = el('probe-section');
const probeSupported = import.meta.env.BROWSER === 'chrome';
probeSection.hidden = !probeSupported;

const toggle = el('toggle') as HTMLButtonElement;
const status = el('status');
const meterFill = el('meter-fill');

const POLL_INTERVAL_MS = 400;

const STATE_LABELS: Record<ProbeState['state'], I18nKey> = {
  idle: 'options.probeIdle',
  starting: 'options.probeStarting',
  capturing: 'options.probeCapturing',
  degraded: 'options.probeDegraded',
  error: 'options.probeError',
};

let probeState: ProbeState = { state: 'idle', level: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;
let uiLocale: UiLocale = 'en';

function sendProbe(kind: 'probe-start' | 'probe-stop' | 'probe-state'): Promise<ProbeState> {
  return browser.runtime.sendMessage({ kind }) as Promise<ProbeState>;
}

function probeActive(): boolean {
  return probeState.state === 'starting' || probeState.state === 'capturing';
}

function renderProbe(): void {
  toggle.textContent = probeActive()
    ? t('options.probeStop', uiLocale)
    : t('options.probeStart', uiLocale);
  toggle.disabled = probeState.state === 'starting';
  status.textContent = probeState.error
    ? t('options.probeFail', uiLocale, { error: probeState.error })
    : t(STATE_LABELS[probeState.state], uiLocale);
  meterFill.style.width = `${Math.min(100, probeState.level * 300)}%`;
}

function startProbePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshProbe(), POLL_INTERVAL_MS);
}

function stopProbePolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshProbe(): Promise<void> {
  let next: ProbeState;
  try {
    next = await sendProbe('probe-state');
  } catch (error) {
    status.textContent = t('options.probeFail', uiLocale, { error: String(error) });
    stopProbePolling();
    return;
  }
  probeState = next;
  renderProbe();
  if (probeActive()) {
    startProbePolling();
  } else {
    stopProbePolling();
  }
}

async function onProbeToggle(): Promise<void> {
  try {
    await sendProbe(probeActive() ? 'probe-stop' : 'probe-start');
  } catch (error) {
    status.textContent = t('options.probeFail', uiLocale, { error: String(error) });
  }
  await refreshProbe();
}

if (probeSupported) {
  toggle.addEventListener('click', () => void onProbeToggle());
  void refreshProbe();
}

export interface AudioProbeUi {
  /** Re-renders the section in the options page's current UI language. */
  setLocale(locale: UiLocale): void;
}

export function createAudioProbeUi(): AudioProbeUi {
  return {
    setLocale(locale: UiLocale): void {
      uiLocale = locale;
      renderProbe();
    },
  };
}
