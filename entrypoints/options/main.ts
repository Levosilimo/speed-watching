import '../../ui/options-styles.css';
import { browser } from 'wxt/browser';
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

// The estimated-usage report, STT demand gate, and audio probe are dev-only
// diagnostics (lib-13: store-review liabilities); ./dev.ts is imported only
// in dev builds, so the store bundle ships none of them.
if (import.meta.env.DEV) {
  void import('./dev');
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

// ── Settings: single storage namespace ───────────────────────────────────
// chrome.storage.local holds exactly two keys — 'sw.settings' (SettingsStore)
// and 'sw.overrideLog' (OverrideLog); see the lib/settings.ts module doc.
// ui/storage.ts's parallel 'sw:' schema is retired.

const settingsStore = new SettingsStore(browser.storage.local, SETTINGS_STORAGE_KEY);
const overrideLog = new OverrideLog(browser.storage.local);

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

// ── Load persisted state ─────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const [settings, habits] = await Promise.all([
    settingsStore.load(),
    overrideLog.entries(),
  ]);
  const target = settings.target ?? DEFAULT_TARGET_WPM;
  wpmSlider.value = String(target);
  wpmValue.textContent = String(target);
  setActivePreset(settings.contentType ?? 'generic');
  renderOverrides(siteList(settings));
  renderHabits(habits);
}

void loadSettings();

// Listen for storage changes from other contexts (e.g., pill apply), with a
// focus/visibility fallback: a backgrounded or discarded options tab can
// miss onChanged events while the log moves.
browser.storage.local.onChanged.addListener((changes) => {
  if (changes[OVERRIDE_LOG_STORAGE_KEY] !== undefined) {
    void overrideLog.entries().then(renderHabits);
  }
});

function refreshFromStorage(): void {
  void overrideLog.entries().then(renderHabits);
}

window.addEventListener('focus', refreshFromStorage);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFromStorage();
});
