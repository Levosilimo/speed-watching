#!/usr/bin/env node
// Capture a 1280×800 screenshot of the options page for the Chrome Web Store.
// Usage: node tools/capture-screenshot.mjs

import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HTML_PATH = join(__dirname, "cws-screenshot.html");
const OUT_PATH = join(ROOT, "docs/store-screenshot.png");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });

  await page.goto(`file://${HTML_PATH}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  await page.screenshot({
    path: OUT_PATH,
    fullPage: false,
    type: "png",
    clip: { x: 0, y: 0, width: 1280, height: 800 },
  });

  console.log(`screenshot saved to ${OUT_PATH}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
