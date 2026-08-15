import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { StorageLike } from '../../lib/settings';

export function readFixture(path: string): unknown {
  const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));
  return JSON.parse(readFileSync(join(fixtureRoot, path), 'utf8')) as unknown;
}

/** In-memory chrome.storage.local via fakeBrowser, same get/set shape. Each
 * call clears the shared fake storage first, so instances stay isolated like
 * the Map stand-in they replaced (several tests build multiple stores per
 * test, each seeded independently). */
export function mockStorage(initial: Record<string, unknown> = {}): StorageLike {
  void fakeBrowser.storage.local.clear();
  void fakeBrowser.storage.local.set(initial);
  return {
    async get(keys: string | null) {
      return fakeBrowser.storage.local.get(keys);
    },
    async set(items: Record<string, unknown>) {
      await fakeBrowser.storage.local.set(items);
    },
  };
}
