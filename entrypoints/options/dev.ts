// Dev-only diagnostics, imported from main.ts only inside
// `if (import.meta.env.DEV)`. The estimated-usage report, STT demand gate,
// and audio probe are engineering surfaces (lib-13: store-review
// liabilities), so production builds never bundle this module; the sections
// below are injected here rather than shipped in options/index.html.
import { browser } from 'wxt/browser';
import type { ProbeState } from '../../lib/audio-probe';
import {
  computeDemandGate,
  DAYS_THRESHOLD,
  DEMAND_STORAGE_KEY,
  DemandStore,
  ELAPSED_CAP_DAYS,
  RENDER_THRESHOLD,
  SPEECH_ELIGIBLE_TYPES,
  type DemandGateState,
  type DemandRecord,
} from '../../lib/demand';

const SECTIONS_HTML = `
  <div class="section">
    <div class="section-label">Estimated usage</div>
    <div class="section-card">
      <p class="section-note">
        Videos where no captions were found, so the rate was estimated. Stored
        locally only — this powers the Phase-2 speech-to-text decision.
      </p>
      <div class="habits-grid">
        <div class="habit-stat">
          <span class="stat-value" id="demand-total">0</span>
          <span class="stat-label">Estimated recommendations</span>
        </div>
      </div>
      <p class="empty-note" id="demand-empty" hidden>No estimated recommendations yet.</p>
      <ul class="habit-list" id="demand-list"></ul>
    </div>
  </div>

  <div class="section">
    <div class="section-label">STT demand gate</div>
    <div class="section-card">
      <p class="section-note">
        Interprets the estimated usage above: when enough speech-eligible
        renders accumulate across enough distinct render days — or six
        weeks pass — this flags for review whether on-device
        speech-to-text is worth building. Music is excluded (captionless
        music has no speech to transcribe). A trip only flags; nothing
        starts automatically.
      </p>
      <p class="gate-status" id="gate-status">Not tripped</p>
      <div class="habits-grid">
        <div class="habit-stat">
          <span class="stat-value" id="gate-count">0</span>
          <span class="stat-label" id="gate-count-label">Speech-eligible renders</span>
        </div>
        <div class="habit-stat">
          <span class="stat-value" id="gate-days">0</span>
          <span class="stat-label" id="gate-days-label">Distinct render days</span>
        </div>
        <div class="habit-stat">
          <span class="stat-value" id="gate-elapsed">—</span>
          <span class="stat-label" id="gate-elapsed-label">Days since first render</span>
        </div>
        <div class="habit-stat">
          <span class="stat-value" id="gate-span">—</span>
          <span class="stat-label">First → last render</span>
        </div>
      </div>
      <ul class="habit-list" id="gate-list"></ul>
    </div>
  </div>

  <div class="probe-section">
    <h2>Audio capture probe</h2>
    <p>
      Phase 0 throwaway: proves the tab → offscreen document → AudioContext
      path that Phase 2 STT depends on.
    </p>
    <button id="toggle" type="button">Test audio capture</button>
    <div id="status">idle</div>
    <div id="meter"><div id="meter-fill"></div></div>
    <div id="wasm"></div>
    <pre id="log"></pre>
  </div>
`;

document.body.insertAdjacentHTML('beforeend', SECTIONS_HTML);

// ── Audio probe (preserved from Lane B, unchanged) ───────────────────────

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

function renderProbe(): void {
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
  pollTimer = setInterval(() => void refreshProbe(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshProbe(): Promise<void> {
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
  renderProbe();
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
  await refreshProbe();
}

toggle.addEventListener('click', () => void onToggle());
void refreshProbe();

// ── Estimated usage + STT demand gate ────────────────────────────────────

const demandStore = new DemandStore(browser.storage.local);

const demandTotal = el('demand-total');
const demandEmpty = el('demand-empty');
const demandList = el('demand-list');

function renderDemand(record: DemandRecord): void {
  demandTotal.textContent = String(record.estimatedCount);

  const byType = Object.entries(record.byContentType).sort((a, b) => b[1] - a[1]);
  demandList.innerHTML = '';
  if (byType.length === 0) {
    demandEmpty.hidden = false;
    return;
  }
  demandEmpty.hidden = true;
  for (const [type, count] of byType) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = type;
    const countEl = document.createElement('span');
    countEl.textContent = String(count);
    li.append(name, countEl);
    demandList.appendChild(li);
  }
}

const gateStatus = el('gate-status');
const gateCount = el('gate-count');
const gateDays = el('gate-days');
const gateElapsed = el('gate-elapsed');
const gateSpan = el('gate-span');
const gateList = el('gate-list');

el('gate-count-label').textContent = `Speech-eligible renders (of ${RENDER_THRESHOLD})`;
el('gate-days-label').textContent = `Distinct render days (of ${DAYS_THRESHOLD})`;
el('gate-elapsed-label').textContent = `Days since first render (of ${ELAPSED_CAP_DAYS})`;

function formatRenderDate(ts: number | undefined): string {
  if (ts === undefined) return '—';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function gateStatusText(gate: DemandGateState): string {
  if (gate.reason === 'elapsed') {
    return `Tripped — ${ELAPSED_CAP_DAYS}+ days since the first estimated render without reaching the adoption threshold. Review whether to close the STT question.`;
  }
  if (gate.reason !== null) {
    return `Tripped — ${RENDER_THRESHOLD}+ speech-eligible renders across ${DAYS_THRESHOLD}+ render days. Review the evidence; nothing starts automatically.`;
  }
  if (gate.elapsedDays === null) {
    return 'Not tripped — no estimated renders yet.';
  }
  return `Not tripped — ${gate.speechEligibleCount}/${RENDER_THRESHOLD} speech-eligible renders across ${gate.renderDays}/${DAYS_THRESHOLD} days, ${gate.elapsedDays}/${ELAPSED_CAP_DAYS} days elapsed.`;
}

function renderGate(record: DemandRecord): void {
  const gate = computeDemandGate(record, Date.now());
  gateCount.textContent = String(gate.speechEligibleCount);
  gateDays.textContent = String(gate.renderDays);
  gateElapsed.textContent = gate.elapsedDays === null ? '—' : String(gate.elapsedDays);
  gateSpan.textContent =
    record.firstSeenTs === undefined
      ? '—'
      : `${formatRenderDate(record.firstSeenTs)} → ${formatRenderDate(record.lastSeenTs)}`;
  gateStatus.textContent = gateStatusText(gate);
  gateStatus.classList.toggle('tripped', gate.tripped);

  gateList.innerHTML = '';
  for (const type of SPEECH_ELIGIBLE_TYPES) {
    const count = record.byContentType[type] ?? 0;
    if (count === 0) continue;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = type;
    const countEl = document.createElement('span');
    countEl.textContent = String(count);
    li.append(name, countEl);
    gateList.appendChild(li);
  }
}

async function refreshDemand(): Promise<void> {
  const record = await demandStore.get();
  renderDemand(record);
  renderGate(record);
}

void refreshDemand();

browser.storage.local.onChanged.addListener((changes) => {
  if (changes[DEMAND_STORAGE_KEY] !== undefined) {
    void refreshDemand();
  }
});

window.addEventListener('focus', () => void refreshDemand());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshDemand();
});
