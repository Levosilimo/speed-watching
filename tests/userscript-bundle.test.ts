// Bundle-level gate: the built userscript must carry the ==UserScript==
// metadata block and must never reference chrome.* (incl. GM_xmlhttpRequest)
// — the port replaces the extension APIs with page-world fetches and GM
// storage. The test fails when the bundle is absent: CI and run-ci build it
// before the suite runs, so a missing bundle is a broken pipeline, not a
// reason to skip.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundlePath = join(repoRoot, 'userscript', 'dist', 'speed-watcher.user.js');

describe('userscript bundle', () => {
  it('has the userscript header and no chrome.* references', () => {
    expect(existsSync(bundlePath), `run \`bun run build:userscript\` first: ${bundlePath}`).toBe(true);
    const bundle = readFileSync(bundlePath, 'utf8');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    expect(bundle).toContain('==UserScript==');
    expect(bundle).toMatch(/@match\s+\*:\/\/\*\.youtube\.com\/\*/);
    expect(bundle).toMatch(/@grant\s+GM_setValue/);
    expect(bundle).toMatch(/@grant\s+GM_getValue/);
    expect(bundle).toMatch(/@run-at\s+document-start/);
    // The header must track the package version and point update checks at
    // the GitHub release asset (publish.yml attaches it under this name).
    expect(bundle).toContain(`@version      ${pkg.version}`);
    expect(bundle).toContain(
      '@updateURL    https://github.com/levosilimo/speed-watching/releases/latest/download/speed-watcher.user.js',
    );
    expect(bundle).toContain(
      '@downloadURL  https://github.com/levosilimo/speed-watching/releases/latest/download/speed-watcher.user.js',
    );
    expect(bundle).not.toMatch(/chrome\./);
    expect(bundle).not.toContain('GM_xmlhttpRequest');
  });
});
