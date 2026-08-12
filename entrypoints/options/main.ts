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
import type { ContentType } from '../../lib/music';
import {
  OVERRIDE_LOG_STORAGE_KEY,
  OverrideLog,
  type OverrideLogEntry,
} from '../../lib/override-log';
import {
  DEFAULT_TARGET_WPM,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  type Settings,
} from '../../lib/settings';

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

// ── Settings: single storage namespace ───────────────────────────────────
// chrome.storage.local holds exactly three keys — 'sw.settings' (SettingsStore),
// 'sw.overrideLog' (OverrideLog), and 'sw.demand' (DemandStore); see the
// lib/settings.ts module doc. ui/storage.ts's parallel 'sw:' schema is retired.

const settingsStore = new SettingsStore(browser.storage.local, SETTINGS_STORAGE_KEY);
const overrideLog = new OverrideLog(browser.storage.local);
const demandStore = new DemandStore(browser.storage.local);

// ── Settings: WPM Slider ─────────────────────────────────────────────────

const wpmSlider = el('wpm-slider') as HTMLInputElement;
const wpmValue = el('wpm-value');
const safeZone = el('safe-zone');

function positionSafeZone(): void {
  const min = Number(wpmSlider.min);
  const max = Number(wpmSlider.max);
  const range = max - min;
  const left = ((250 - min) / range) * 100;
  const right = ((275 - min) / range) * 100;
  safeZone.style.left = `${left}%`;
  safeZone.style.width = `${right - left}%`;
}

positionSafeZone();

wpmSlider.addEventListener('input', () => {
  wpmValue.textContent = wpmSlider.value;
  void settingsStore.update((settings) => ({ ...settings, target: Number(wpmSlider.value) }));
});

// ── Settings: Content Type Presets ────────────────────────────────────────

const presetBtns = document.querySelectorAll<HTMLButtonElement>('.preset-btn');

function setActivePreset(type: ContentType): void {
  presetBtns.forEach((btn) => {
    const isActive = btn.dataset.type === type;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

presetBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type as ContentType;
    setActivePreset(type);
    void settingsStore.update((settings) => ({ ...settings, contentType: type }));
  });
});

// ── Settings: Per-site Overrides ──────────────────────────────────────────

const overrideList = el('override-list');
const overrideEmpty = el('override-empty');
const overrideInput = el('override-input') as HTMLInputElement;
const overrideAdd = el('override-add');

interface DisplayedOverride {
  hostname: string;
  contentType: ContentType;
}

function siteList(settings: Settings): DisplayedOverride[] {
  return Object.entries(settings.sites).map(([hostname, override]) => ({
    hostname,
    contentType: override.contentType ?? 'generic',
  }));
}

function renderOverrides(overrides: DisplayedOverride[]): void {
  overrideList.innerHTML = '';
  if (overrides.length === 0) {
    overrideEmpty.hidden = false;
    return;
  }
  overrideEmpty.hidden = true;

  for (const item of overrides) {
    const li = document.createElement('li');
    li.className = 'override-item';

    const left = document.createElement('span');
    const hostname = document.createElement('span');
    hostname.className = 'override-hostname';
    hostname.textContent = item.hostname;
    const typeBadge = document.createElement('span');
    typeBadge.className = 'override-type';
    typeBadge.textContent = item.contentType;
    left.append(hostname, typeBadge);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'override-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.setAttribute('aria-label', `Remove override for ${item.hostname}`);
    removeBtn.addEventListener('click', () => {
      void settingsStore
        .update((settings) => {
          const next = { ...settings, sites: { ...settings.sites } };
          delete next.sites[item.hostname];
          return next;
        })
        .then((next) => renderOverrides(siteList(next)));
    });

    li.append(left, removeBtn);
    overrideList.appendChild(li);
  }
}

overrideAdd.addEventListener('click', () => {
  const hostname = overrideInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!hostname) return;

  void settingsStore
    .update((settings) => {
      if (settings.sites[hostname] !== undefined) return settings;
      const contentType =
        (document.querySelector<HTMLButtonElement>('.preset-btn[aria-pressed="true"]')
          ?.dataset.type as ContentType) ?? 'generic';
      return { ...settings, sites: { ...settings.sites, [hostname]: { contentType } } };
    })
    .then((next) => {
      renderOverrides(siteList(next));
      overrideInput.value = '';
    });
});

overrideInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    overrideAdd.click();
  }
});

// ── Settings: Habits Report ──────────────────────────────────────────────

const habitTotal = el('habit-total');
const habitAvgMult = el('habit-avg-mult');
const habitList = el('habit-list');

function renderHabits(habits: OverrideLogEntry[]): void {
  habitTotal.textContent = String(habits.length);

  // Same semantics as OverrideLog.report(): the average covers only applied
  // multipliers — dismisses and adjusts never set the playback speed.
  const applied = habits.filter((h) => h.userAction === 'apply');
  const avg =
    applied.length === 0
      ? null
      : applied.reduce((sum, h) => sum + h.multiplier, 0) / applied.length;
  habitAvgMult.textContent = avg === null ? '—' : `${avg.toFixed(2)}×`;

  if (habits.length === 0) {
    habitList.innerHTML = '';
    return;
  }

  // Group by content type
  const byType = new Map<ContentType, number>();
  for (const h of habits) {
    byType.set(h.contentType, (byType.get(h.contentType) ?? 0) + 1);
  }

  habitList.innerHTML = '';
  const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = type;
    const countEl = document.createElement('span');
    countEl.textContent = `${count}×`;
    li.append(name, countEl);
    habitList.appendChild(li);
  }
}

// ── Estimated Usage (STT demand proxy) ───────────────────────────────────

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

// ── STT Demand Gate (lib-9 interpretation of the raw counts above) ───────

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

// ── Load persisted state ─────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const [settings, habits, demand] = await Promise.all([
    settingsStore.load(),
    overrideLog.entries(),
    demandStore.get(),
  ]);
  const target = settings.target ?? DEFAULT_TARGET_WPM;
  wpmSlider.value = String(target);
  wpmValue.textContent = String(target);
  setActivePreset(settings.contentType ?? 'generic');
  renderOverrides(siteList(settings));
  renderHabits(habits);
  renderDemand(demand);
  renderGate(demand);
}

void loadSettings();

// Listen for storage changes from other contexts (e.g., pill apply), with a
// focus/visibility fallback: a backgrounded or discarded options tab can
// miss onChanged events while the log or demand counter moves.
browser.storage.local.onChanged.addListener((changes) => {
  if (changes[OVERRIDE_LOG_STORAGE_KEY] !== undefined) {
    void overrideLog.entries().then(renderHabits);
  }
  if (changes[DEMAND_STORAGE_KEY] !== undefined) {
    void refreshDemand();
  }
});

function refreshFromStorage(): void {
  void overrideLog.entries().then(renderHabits);
  void refreshDemand();
}

window.addEventListener('focus', refreshFromStorage);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFromStorage();
});
