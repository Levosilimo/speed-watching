import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageLike } from '../../lib/settings';

export function readFixture(path: string): unknown {
  const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));
  return JSON.parse(readFileSync(join(fixtureRoot, path), 'utf8')) as unknown;
}

/** In-memory chrome.storage.local stand-in, same get/set shape. */
export function mockStorage(initial: Record<string, unknown> = {}): StorageLike {
  let data = { ...initial };
  return {
    async get(keys: string | null) {
      if (keys === null) return { ...data };
      return { [keys]: data[keys] };
    },
    async set(items: Record<string, unknown>) {
      data = { ...data, ...items };
    },
  };
}
