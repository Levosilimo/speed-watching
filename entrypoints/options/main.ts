import '../../ui/options-styles.css';
import { browser } from 'wxt/browser';
import type { ProbeState } from '../../lib/audio-probe';
import type { ContentType } from '../../lib/music';
import {
  OVERRIDE_LOG_STORAGE_KEY,
  OverrideLog,
  type OverrideLogEntry,
} from '../../lib/override-log';
import {
  DEFAULT_AUTO_TYPES,
} from '../../lib/auto-apply';
import {
  DEFAULT_TARGET_WPM,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  isUiLanguageSetting,
  type Settings,
  type UiLanguageSetting,
} from '../../lib/settings';
import { TIME_SAVED_STORAGE_KEY, TimeSavedStore } from '../../lib/time-saved';
import {
  applyI18n,
  formatTimeSaved,
  resolveUiLanguage,
  t,
  type I18nKey,
  type UiLocale,
} from '../../lib/i18n';

// The STT demand-gate diagnostics are dev-only (lib-13: store-review
// liabilities); ./dev.ts is imported only in dev builds, so the store bundle
// ships none of them. The audio capture test below ships.
// Awaited so the dynamic import cannot float past the importing context's
// teardown (the vitest module-cache quirk documented in options-a11y.test.ts).
// The auto-apply section (lib-14) pushed the file past the 440-line
// reviewability budget; the suppression mirrors content.ts's — a reviewed
// exception, not license to grow further.
// aislop-ignore-file file-too-large
if (import.meta.env.DEV) {
  await import('./dev');
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

// ── Settings: single storage namespace ───────────────────────────────────
// chrome.storage.local holds exactly five keys — 'sw.settings'
// (SettingsStore), 'sw.overrideLog' (OverrideLog), 'sw.demand' (DemandStore),
// 'sw.channelRates' (ChannelMemory), and 'sw.timeSavedSec' (TimeSavedStore);
// see the lib/settings.ts module doc. ui/storage.ts's parallel 'sw:' schema
// is retired.

const settingsStore = new SettingsStore(browser.storage.local, SETTINGS_STORAGE_KEY);
const overrideLog = new OverrideLog(browser.storage.local);
const timeSavedStore = new TimeSavedStore(browser.storage.local);

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

// ── Settings: Interface Language ──────────────────────────────────────────

const uiLangSelect = el('ui-language') as HTMLSelectElement;

let uiLocale: UiLocale = 'en';

function renderLocale(): void {
  document.documentElement.lang = uiLocale;
  applyI18n(document, uiLocale);
  renderProbe();
  // The saved-time headline is localized text (the other habit stats are
  // numbers) — re-render it on a language switch.
  void refreshHabits();
}

uiLangSelect.addEventListener('change', () => {
  const setting: UiLanguageSetting = isUiLanguageSetting(uiLangSelect.value)
    ? uiLangSelect.value
    : 'auto';
  void settingsStore.update((settings) => ({ ...settings, uiLanguage: setting })).then(() => {
    uiLocale = resolveUiLanguage(setting, navigator.language);
    renderLocale();
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
    removeBtn.textContent = t('options.remove', uiLocale);
    removeBtn.setAttribute('aria-label', t('options.removeAria', uiLocale, { host: item.hostname }));
    removeBtn.addEventListener('click', () => {
      void settingsStore
        .update((settings) => {
          const next = { ...settings, sites: { ...settings.sites } };
          delete next.sites[item.hostname];
          return next;
        })
        .then((next) => {
          renderOverrides(siteList(next));
          // The removed button is gone; land focus on the stable add-input.
          overrideInput.focus();
        });
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

// ── Settings: External API toggle (measured-rate provider) ──────────────

const externalApiToggle = el('external-api-toggle') as HTMLInputElement;

externalApiToggle.addEventListener('change', () => {
  void settingsStore.update((settings) => ({
    ...settings,
    externalApiEnabled: externalApiToggle.checked,
  }));
});

// ── Settings: Auto-apply (per-video opt-in) ─────────────────────────────

const autoToggle = el('auto-toggle') as HTMLInputElement;
const autoTypeBoxes = document.querySelectorAll<HTMLInputElement>(
  '.auto-type-group input[type="checkbox"]',
);

autoToggle.addEventListener('change', () => {
  void settingsStore.update((settings) => ({
    ...settings,
    autoApply: { ...settings.autoApply, enabled: autoToggle.checked },
  }));
});

autoTypeBoxes.forEach((box) => {
  box.addEventListener('change', () => {
    const type = box.dataset.type as ContentType;
    void settingsStore.update((settings) => ({
      ...settings,
      autoApply: {
        ...settings.autoApply,
        contentTypes: { ...settings.autoApply.contentTypes, [type]: box.checked },
      },
    }));
  });
});

// ── Settings: Habits Report ──────────────────────────────────────────────

const habitTotal = el('habit-total');
const habitAvgMult = el('habit-avg-mult');
const habitSaved = el('habit-saved');
const habitList = el('habit-list');

function renderHabits(habits: OverrideLogEntry[], savedSec: number): void {
  habitTotal.textContent = String(habits.length);
  // The saved-time stat: the 'tracking started' line until the first accrue
  // (no sw.timeSavedSec yet — never fabricate a value).
  habitSaved.textContent =
    savedSec === 0
      ? t('options.timeSavedStarted', uiLocale)
      : t('options.timeSavedHeadline', uiLocale, formatTimeSaved(savedSec, uiLocale));

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

/** Habits and the saved-time stat share one refresh (both render from
 * chrome.storage.local, and the onChanged branches below re-render both). */
async function refreshHabits(): Promise<void> {
  const [habits, savedSec] = await Promise.all([overrideLog.entries(), timeSavedStore.get()]);
  renderHabits(habits, savedSec);
}

// ── Audio Capture Test (shipped; the tabCapture/offscreen justification) ──
// probe-start/stop/state are answered by the background orchestrator, the
// meter by its offscreen 'level' events. Chrome-only: Firefox has no
// offscreen API, so the section is hidden and inert there.

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

// ── Load persisted state ─────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const [settings, habits, savedSec] = await Promise.all([
    settingsStore.load(),
    overrideLog.entries(),
    timeSavedStore.get(),
  ]);
  uiLocale = resolveUiLanguage(settings.uiLanguage, navigator.language);
  uiLangSelect.value = settings.uiLanguage ?? 'auto';
  renderLocale();
  const target = settings.target ?? DEFAULT_TARGET_WPM;
  wpmSlider.value = String(target);
  wpmValue.textContent = String(target);
  setActivePreset(settings.contentType ?? 'generic');
  externalApiToggle.checked = settings.externalApiEnabled;
  autoToggle.checked = settings.autoApply.enabled;
  autoTypeBoxes.forEach((box) => {
    const type = box.dataset.type as ContentType;
    box.checked = settings.autoApply.contentTypes[type] ?? DEFAULT_AUTO_TYPES.has(type);
  });
  renderOverrides(siteList(settings));
  renderHabits(habits, savedSec);
}

// Render the browser-language default immediately, then refine with the
// stored setting once it loads (no English flash for ru users).
uiLocale = resolveUiLanguage('auto', navigator.language);
renderLocale();
void loadSettings();

// Listen for storage changes from other contexts (e.g., pill apply), with a
// focus/visibility fallback: a backgrounded or discarded options tab can
// miss onChanged events while the log moves.
browser.storage.local.onChanged.addListener((changes) => {
  if (changes[OVERRIDE_LOG_STORAGE_KEY] !== undefined) {
    void refreshHabits();
  }
  if (changes[TIME_SAVED_STORAGE_KEY] !== undefined) {
    void refreshHabits();
  }
});

function refreshFromStorage(): void {
  void refreshHabits();
}

window.addEventListener('focus', refreshFromStorage);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFromStorage();
});
