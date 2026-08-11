import { browser } from 'wxt/browser';
import type { ProbeState } from '../../lib/audio-probe';
import {
  KEY_TARGET_WPM,
  KEY_CONTENT_TYPE,
  KEY_SITE_OVERRIDES,
  KEY_HABITS,
  read,
  write,
  type ContentType,
  type SiteOverride,
  type HabitEntry,
} from '../../ui/storage';

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
  void write(KEY_TARGET_WPM, Number(wpmSlider.value));
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
    void write(KEY_CONTENT_TYPE, type);
  });
});

// ── Settings: Per-site Overrides ──────────────────────────────────────────

const overrideList = el('override-list');
const overrideEmpty = el('override-empty');
const overrideInput = el('override-input') as HTMLInputElement;
const overrideAdd = el('override-add');

function renderOverrides(overrides: SiteOverride[]): void {
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
      const next = overrides.filter((o) => o.hostname !== item.hostname);
      void write(KEY_SITE_OVERRIDES, next).then(() => renderOverrides(next));
    });

    li.append(left, removeBtn);
    overrideList.appendChild(li);
  }
}

overrideAdd.addEventListener('click', () => {
  const hostname = overrideInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!hostname) return;

  void read(KEY_SITE_OVERRIDES).then((current) => {
    if (current.some((o) => o.hostname === hostname)) {
      overrideInput.value = '';
      return;
    }
    const contentType = document.querySelector<HTMLButtonElement>('.preset-btn[aria-pressed="true"]')?.dataset.type as ContentType ?? 'generic';
    const next = [...current, { hostname, contentType, addedAt: Date.now() }];
    void write(KEY_SITE_OVERRIDES, next).then(() => {
      renderOverrides(next);
      overrideInput.value = '';
    });
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

function renderHabits(habits: HabitEntry[]): void {
  habitTotal.textContent = String(habits.length);

  if (habits.length === 0) {
    habitAvgMult.textContent = '—';
    habitList.innerHTML = '';
    return;
  }

  const avg = habits.reduce((sum, h) => sum + h.multiplier, 0) / habits.length;
  habitAvgMult.textContent = `${avg.toFixed(2)}×`;

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

// ── Load persisted state ─────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const [targetWpm, contentType, overrides, habits] = await Promise.all([
    read(KEY_TARGET_WPM),
    read(KEY_CONTENT_TYPE),
    read(KEY_SITE_OVERRIDES),
    read(KEY_HABITS),
  ]);

  wpmSlider.value = String(targetWpm);
  wpmValue.textContent = String(targetWpm);
  setActivePreset(contentType);
  renderOverrides(overrides);
  renderHabits(habits);
}

void loadSettings();

// Listen for storage changes from other contexts (e.g., pill apply)
browser.storage.local.onChanged.addListener((changes) => {
  const keys = Object.keys(changes);
  if (keys.some((k) => k.startsWith('sw:habits'))) {
    void read(KEY_HABITS).then(renderHabits);
  }
});
