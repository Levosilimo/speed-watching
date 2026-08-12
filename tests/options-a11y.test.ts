// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeMock } from './chrome-mock';
import { SETTINGS_STORAGE_KEY } from '../lib/settings';

// Loaded from the process cwd like options.test.ts (happy-dom rewrites
// import.meta.url to an http origin).
const optionsHtml = readFileSync(join(process.cwd(), 'entrypoints/options/index.html'), 'utf8');

let storageData = new Map<string, unknown>();

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// One import for the whole file: options.test.ts re-imports main.ts per test,
// and each dynamic import re-runs dev.ts's top-level DOM injection an
// unpredictable number of times (vitest module-cache quirk), which
// destabilizes the demand-counter test over there. These tests do not need a
// fresh module per test, so they live apart and import once.
beforeAll(async () => {
  document.body.innerHTML = optionsHtml;
  storageData.set(SETTINGS_STORAGE_KEY, {
    target: 250,
    conservative: false,
    platformMax: 2,
    sites: { 'ted.com': { contentType: 'talk' } },
    contentTypes: {},
  });
  chromeMock.storage.local.get.mockImplementation(async (keys: string | null) => {
    if (keys === null) return Object.fromEntries(storageData);
    return { [keys]: storageData.get(keys) };
  });
  chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) storageData.set(key, value);
  });
  chromeMock.storage.local.onChanged.addListener.mockImplementation(() => {});
  chromeMock.runtime.sendMessage.mockResolvedValue({ state: 'idle', level: 0 });
  await import('../entrypoints/options/main');
  await flush();
});

describe('options accessibility structure', () => {
  it('names the target-wpm slider through the section label', () => {
    const slider = document.getElementById('wpm-slider');
    expect(slider?.getAttribute('aria-labelledby')).toBe('target-rate-label');
    expect(document.getElementById('target-rate-label')?.textContent).toBe('Target speech rate');
  });

  it('marks the shipped section labels as headings', () => {
    // dev.ts injects its own div.section-label sections; the shipped six
    // are the only h2s with the class.
    expect(document.querySelectorAll('h2.section-label')).toHaveLength(6);
  });

  it('pairs the habits stats as a description list', () => {
    const grid = document.querySelector('.habits-grid');
    expect(grid?.tagName).toBe('DL');
    expect(document.getElementById('habit-total')?.tagName).toBe('DT');
    expect(document.getElementById('habit-avg-mult')?.tagName).toBe('DT');
    expect(document.querySelectorAll('.habit-stat dd')).toHaveLength(2);
  });

  it('moves focus to the add-input after removing an override', async () => {
    const remove = document.querySelector<HTMLButtonElement>('.override-remove');
    expect(remove).not.toBeNull();
    remove!.click();
    await flush();
    expect(document.querySelector('.override-remove')).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('override-input'));
  });
});
