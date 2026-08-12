#!/usr/bin/env node
// Generate Speed Watcher icons at all manifest sizes from an SVG source,
// plus the 440×280 Chrome Web Store promo tile (same motif + wordmark).
// Uses sharp (available as a transitive dep) for rasterization. SVG <text>
// renders via fontconfig — needs a sans-serif font installed.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ICON_DIR = join(ROOT, "public/icon");
const PROMO_DIR = join(ROOT, "public/promo");
mkdirSync(ICON_DIR, { recursive: true });
mkdirSync(PROMO_DIR, { recursive: true });

const PRIMARY = "#1a9c8f";
const WHITE = "#ffffff";

function iconSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" ry="28" fill="${PRIMARY}"/>
  <path d="M 28 80 A 48 48 0 1 1 100 80" fill="none" stroke="${WHITE}" stroke-width="9" stroke-linecap="round"/>
  <line x1="64" y1="64" x2="92" y2="36" stroke="${WHITE}" stroke-width="5" stroke-linecap="round"/>
  <polygon points="90,30 102,22 96,40" fill="${WHITE}"/>
  <circle cx="64" cy="64" r="5" fill="${WHITE}"/>
</svg>`;
}

function promoSVG() {
  // 440×280 CWS small promo tile: flat teal background, the speedometer
  // motif scaled 1.4× around (220, 112), wordmark centered below it.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
  <rect width="440" height="280" fill="${PRIMARY}"/>
  <g transform="translate(220 112) scale(1.4) translate(-64 -64)">
    <path d="M 28 80 A 48 48 0 1 1 100 80" fill="none" stroke="${WHITE}" stroke-width="9" stroke-linecap="round"/>
    <line x1="64" y1="64" x2="92" y2="36" stroke="${WHITE}" stroke-width="5" stroke-linecap="round"/>
    <polygon points="90,30 102,22 96,40" fill="${WHITE}"/>
    <circle cx="64" cy="64" r="5" fill="${WHITE}"/>
  </g>
  <text x="220" y="232" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" font-weight="bold" fill="${WHITE}">Speed Watcher</text>
</svg>`;
}

async function main() {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.error("sharp not available");
    process.exit(1);
  }

  const sizes = [16, 32, 48, 96, 128];
  for (const s of sizes) {
    const renderSize = Math.max(s * 2, 64);
    const svg = iconSVG(renderSize);
    const buf = await sharp(Buffer.from(svg))
      .resize(s, s, { kernel: "lanczos3" })
      .png()
      .toBuffer();
    writeFileSync(join(ICON_DIR, `${s}.png`), buf);
    console.log(`wrote ${s}.png (${buf.length} bytes)`);
  }

  const promo = await sharp(Buffer.from(promoSVG())).png().toBuffer();
  writeFileSync(join(PROMO_DIR, "440x280.png"), promo);
  console.log(`wrote promo/440x280.png (${promo.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
