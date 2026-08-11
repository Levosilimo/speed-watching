import { browser } from 'wxt/browser';
import type { ProbeState } from '../../lib/audio-probe';

const POLL_INTERVAL_MS = 400;
const LOG_LIMIT = 200;

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

const toggle = el('toggle') as HTMLButtonElement;
const status = el('status');
const meterFill = el('meter-fill');
const wasmLine = el('wasm');
const logEl = el('log') as HTMLPreElement;

let state: ProbeState = { state: 'idle', level: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;
const logLines: string[] = [];

function log(line: string): void {
  logLines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (logLines.length > LOG_LIMIT) logLines.shift();
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

async function send(kind: 'probe-start' | 'probe-stop' | 'probe-state'): Promise<ProbeState> {
  return (await browser.runtime.sendMessage({ kind })) as ProbeState;
}

function active(): boolean {
  return state.state === 'starting' || state.state === 'capturing';
}

function render(): void {
  toggle.textContent = active() ? 'Stop audio capture' : 'Test audio capture';
  toggle.disabled = state.state === 'starting';
  status.textContent = state.state + (state.error ? ` — ${state.error}` : '');
  meterFill.style.width = `${Math.min(100, state.level * 300)}%`;
  wasmLine.textContent = state.wasm
    ? `wasm: ${state.wasm.ok ? 'ok' : `BLOCKED (${state.wasm.error ?? 'unknown'})`} · SharedArrayBuffer: ${state.wasm.sab ? 'available' : 'not available (no cross-origin isolation)'}`
    : 'wasm: not yet checked (runs on capture start)';
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refresh(): Promise<void> {
  let next: ProbeState;
  try {
    next = await send('probe-state');
  } catch (error) {
    log(`probe-state failed: ${String(error)}`);
    return;
  }
  if (next.state !== state.state) {
    log(`state → ${next.state}${next.error ? ` (${next.error})` : ''}`);
  }
  state = next;
  render();
  if (active()) {
    startPolling();
  } else {
    stopPolling();
  }
}

async function onToggle(): Promise<void> {
  try {
    await send(active() ? 'probe-stop' : 'probe-start');
  } catch (error) {
    log(`toggle failed: ${String(error)}`);
  }
  await refresh();
}

toggle.addEventListener('click', () => void onToggle());
void refresh();
