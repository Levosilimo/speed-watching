#!/usr/bin/env bun
// Builds the userscript bundle: bun build (no new deps) from
// userscript/src/main.ts to userscript/dist/speed-watcher.user.js with the
// ==UserScript== metadata block prepended and the e2e relay hook appended.
// The artifact is gitignored — it must never sit in the gate-scanned tree.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outPath = join(root, 'userscript', 'dist', 'speed-watcher.user.js');

const METADATA = `// ==UserScript==
// @name         Speed Watcher
// @namespace    speed-watcher
// @version      0.0.2
// @description  Sets YouTube playback speed so effective speech rate lands in the ~250-275 wpm safe zone
// @match        *://*.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

`;

const E2E_HOOK = `
;(function () {
  // E2E relay (appended at build): when the page set
  // window.__speedwatcherE2E = true before the bundle ran, main() exposes
  // the speedwatcher:measure event and the pill hook; this stores the last
  // payload so specs can read it without the fixture page's own listener.
  if (window.__speedwatcherE2E !== true) return;
  window.addEventListener('speedwatcher:measure', function (event) {
    window.__speedwatcherLastMeasure = event.detail;
  });
})();
`;

mkdirSync(dirname(outPath), { recursive: true });
const result = spawnSync(
  'bun',
  [
    'build',
    join(root, 'userscript', 'src', 'main.ts'),
    '--outfile',
    outPath,
    '--target',
    'browser',
    // minify stays off (bun's default) so the gate-scanned source and the
    // shipped bundle stay readable side by side.
    '--define',
    '__E2E__:false',
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const bundle = readFileSync(outPath, 'utf8');
writeFileSync(outPath, `${METADATA}${bundle}${E2E_HOOK}`);
console.log(`built ${outPath} (${METADATA.length + bundle.length + E2E_HOOK.length} bytes)`);
