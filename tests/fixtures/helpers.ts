import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readFixture(path: string): unknown {
  const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));
  return JSON.parse(readFileSync(join(fixtureRoot, path), 'utf8')) as unknown;
}
