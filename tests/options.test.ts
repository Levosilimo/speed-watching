// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from './chrome-mock';
import type { OverrideLogEntry } from '../lib/override-log';

// happy-dom rewrites import.meta.url to an http origin, so resolve the page
// markup from the process cwd instead of the module URL.
const optionsHtml = readFileSync(join(process.cwd(), 'entrypoints/options/index.html'), 'utf8');
const LOG_KEY = 'sw.overrideLog';
const DEMAND_KEY = 'sw.demand';

let storageData = new Map<string, unknown>();
type OnChangedListener = (changes: Record<string, { newValue?: unknown }>) => void;
let onChangedListeners: OnChangedListener[] = [];

function logEntry(overrides: Partial<OverrideLogEntry> = {}): OverrideLogEntry {
  return {
    ts: Date.now(),
    site: 'youtube.com',
    contentType: 'lecture',
    naturalRate: 150,
    multiplier: 1.5,
    mode: 'recommend',
    userAction: 'apply',
    ...overrides,
  };
}

function fireOnChanged(key: string, newValue: unknown): void {
  for (const listener of onChangedListeners) listener({ [key]: { newValue } });
}

/** Flushes the mock storage's promise chains (module init + re-renders). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = optionsHtml;
  storageData = new Map();
  onChangedListeners = [];
  chromeMock.storage.local.get.mockImplementation(async (keys: string | null) => {
    if (keys === null) return Object.fromEntries(storageData);
    return { [keys]: storageData.get(keys) };
  });
  chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) storageData.set(key, value);
  });
  chromeMock.storage.local.onChanged.addListener.mockImplementation((listener: OnChangedListener) => {
    onChangedListeners.push(listener);
  });
  chromeMock.runtime.sendMessage.mockResolvedValue({ state: 'idle', level: 0 });
});

describe('options habits report', () => {
  it('averages only applied multipliers, matching OverrideLog.report semantics', async () => {
    storageData.set(LOG_KEY, [
      logEntry({ multiplier: 1.5 }),
      logEntry({ multiplier: 1.7 }),
      logEntry({ multiplier: 1.9, userAction: 'dismiss' }),
      logEntry({ multiplier: 1.2, userAction: 'adjust', finalMultiplier: 1.2 }),
    ]);
    await import('../entrypoints/options/main');
    await flush();
    expect(document.getElementById('habit-total')?.textContent).toBe('4');
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('1.60×');
  });

  it('shows an em dash when every entry is a dismiss or adjust', async () => {
    storageData.set(LOG_KEY, [
      logEntry({ userAction: 'dismiss' }),
      logEntry({ userAction: 'adjust', finalMultiplier: 1.3 }),
    ]);
    await import('../entrypoints/options/main');
    await flush();
    expect(document.getElementById('habit-total')?.textContent).toBe('2');
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('—');
  });
});

describe('options storage refresh wiring', () => {
  it('re-renders habits from the onChanged listener', async () => {
    storageData.set(LOG_KEY, []);
    await import('../entrypoints/options/main');
    await flush();
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('—');
    storageData.set(LOG_KEY, [logEntry({ multiplier: 1.4 }), logEntry({ multiplier: 1.6 })]);
    fireOnChanged(LOG_KEY, storageData.get(LOG_KEY));
    await flush();
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('1.50×');
  });

  it('re-renders the demand counter from the onChanged listener', async () => {
    storageData.set(DEMAND_KEY, { estimatedCount: 2, byContentType: { generic: 2 } });
    // dev.ts owns both the demand markup and its onChanged listener; import
    // it directly so this test does not depend on main.ts's guarded dynamic
    // import re-running (vitest's module cache makes that nondeterministic).
    await import('../entrypoints/options/dev');
    await flush();
    expect(document.getElementById('demand-total')?.textContent).toBe('2');
    storageData.set(DEMAND_KEY, { estimatedCount: 5, byContentType: { generic: 5 } });
    fireOnChanged(DEMAND_KEY, storageData.get(DEMAND_KEY));
    await flush();
    expect(document.getElementById('demand-total')?.textContent).toBe('5');
  });

  it('refreshes from storage on window focus (missed onChanged fallback)', async () => {
    storageData.set(LOG_KEY, []);
    await import('../entrypoints/options/main');
    await flush();
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('—');
    storageData.set(LOG_KEY, [logEntry({ multiplier: 1.5 }), logEntry({ multiplier: 1.7 })]);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('1.60×');
  });

  it('refreshes from storage when the tab becomes visible again', async () => {
    storageData.set(LOG_KEY, []);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await import('../entrypoints/options/main');
    await flush();
    storageData.set(LOG_KEY, [logEntry({ multiplier: 1.5 })]);
    document.dispatchEvent(new Event('visibilitychange')); // still hidden: no refresh
    await flush();
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('—');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(document.getElementById('habit-avg-mult')?.textContent).toBe('1.50×');
  });
});

describe('options external API toggle', () => {
  function toggle(): HTMLInputElement {
    return document.getElementById('external-api-toggle') as HTMLInputElement;
  }

  it('defaults to off', async () => {
    await import('../entrypoints/options/main');
    await flush();
    expect(toggle().checked).toBe(false);
  });

  it('persists a user toggle through the settings store', async () => {
    await import('../entrypoints/options/main');
    await flush();
    toggle().checked = true;
    toggle().dispatchEvent(new Event('change'));
    await flush();
    expect(storageData.get('sw.settings')).toMatchObject({ externalApiEnabled: true });
  });

  it('reflects a persisted true setting on load', async () => {
    storageData.set('sw.settings', { externalApiEnabled: true });
    await import('../entrypoints/options/main');
    await flush();
    expect(toggle().checked).toBe(true);
  });
});
