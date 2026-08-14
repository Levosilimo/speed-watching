// Bundle-level gate: the built userscript must carry the ==UserScript==
// metadata block and must never reference chrome.* (incl. GM_xmlhttpRequest)
// — the port replaces the extension APIs with page-world fetches and GM
// storage. Skipped (not failed) when the bundle is absent so CI without a
// pre-build stays green.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bundlePath = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'userscript',
  'dist',
  'speed-watcher.user.js',
);

const bundleExists = existsSync(bundlePath);
if (!bundleExists) {
  console.warn(
    `SKIP userscript bundle test: ${bundlePath} not found — run \`bun run build:userscript\` first`,
  );
}

describe('userscript bundle', () => {
  it.skipIf(!bundleExists)('has the userscript header and no chrome.* references', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('==UserScript==');
    expect(bundle).toMatch(/@match\s+\*:\/\/\*\.youtube\.com\/\*/);
    expect(bundle).toMatch(/@grant\s+GM_setValue/);
    expect(bundle).toMatch(/@grant\s+GM_getValue/);
    expect(bundle).toMatch(/@run-at\s+document-start/);
    expect(bundle).not.toMatch(/chrome\./);
    expect(bundle).not.toContain('GM_xmlhttpRequest');
  });
});
