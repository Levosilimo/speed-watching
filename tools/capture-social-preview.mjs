#!/usr/bin/env node
// Render the 1280x640 social preview card (tools/social-preview.html) to
// docs/social-preview.png. Requires docs/watch-page.png (run
// tools/capture-watch-page.mjs first).
//
// Usage: node tools/capture-social-preview.mjs

import { chromium } from 'playwright';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const HTML_PATH = join(__dirname, 'social-preview.html');
const OUT_PATH = join(ROOT, 'docs', 'social-preview.png');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${HTML_PATH}`, { waitUntil: 'networkidle' });
  await page.screenshot({
    path: OUT_PATH,
    type: 'png',
    clip: { x: 0, y: 0, width: 1280, height: 640 },
  });
  console.log(`screenshot saved to ${OUT_PATH}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
