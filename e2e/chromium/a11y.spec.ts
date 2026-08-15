// A11y gate: axe-core scans of the rendered pill (WCAG 2 A/AA), light and
// dark. The scan is scoped to the pill host's own surface (.speedwatcher-
// pill-host + its open shadow root) so the fixture page's bare video never
// leaks into the result; the fixture background is the plain body (white),
// so the pill's contrast pairs are computed against a known backdrop, not
// arbitrary video content.
//
// Incomplete findings are pinned, not ignored: the pill's backdrop-filter
// blur (ui/pill-css.ts) leaves axe unable to resolve text backgrounds, so
// each scan reports exactly ONE color-contrast incomplete. The finding's
// node set is theme/order-dependent and logged, not asserted:
//   - light (first scan, fresh profile): the one-time .first-run explainer
//     is up, and its wrapped text at the pill's rounded edge is
//     unresolvable → the finding carries .first-run.
//   - dark (second scan, same profile): the first-run flag already
//     persisted (settings:seenFirstRun), and the dark pill's translucent
//     primarySubtle background forces axe to composite through the blur,
//     so the finding carries .label/.tier/.btn-dismiss instead.
// A count !== 1 (or a non-color-contrast id) means the backdrop-filter
// limitation changed — a real contrast regression behind the blur, a new
// unresolvable element, or the limitation lifted — and the gate fails with
// the finding data instead of passing silently.
//
// Two scans: the pill themes itself off (prefers-color-scheme), so each
// scan emulates the scheme BEFORE navigation and the pill is born in the
// theme under test.

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURE_PORT } from '../server';

const extensionPath = resolve('.output/chrome-mv3-e2e');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl =
  'http://www.youtube.com/watch?v=e2e-fixture&fixture=real/manual-cue.json';

let context: BrowserContext;
let page: Page;

test.beforeAll(async () => {
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `built extension not found at ${extensionPath} — run \`bun run build:e2e\` first (the e2e build keeps the window test hooks)`,
    );
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-a11y-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  // Same youtube-origin fixture interception as the main suite: the watch
  // page and the caption fetch are fulfilled from the local fixture server.
  await context.route('**://www.youtube.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/timedtext') {
      const fixture = url.searchParams.get('fixture');
      const response = await fetch(`${fixtureBase}/api/timedtext?fixture=${fixture}`);
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      });
      return;
    }
    if (request.resourceType() !== 'document') {
      await route.abort();
      return;
    }
    const fixture = url.searchParams.get('fixture');
    const response = await fetch(`${fixtureBase}/watch?fixture=${fixture}`);
    await route.fulfill({
      status: response.status,
      contentType: 'text/html',
      body: await response.text(),
    });
  });
  page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
  await context?.close();
});

/** Navigate (theme already emulated), wait for the recommend-mode pill. */
async function renderPill(colorScheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await page.goto(watchUrl);
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state?.mode === 'recommend',
    undefined,
    { timeout: 15_000 },
  );
}

async function scanPill(): Promise<{
  violations: number;
  incomplete: number;
  incompleteIds: string[];
  detail: string;
  incompleteDetail: string;
}> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .include('.speedwatcher-pill-host')
    .analyze();
  const detail = results.violations
    .map(
      (v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`,
    )
    .join('\n');
  const incompleteDetail = results.incomplete
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`,
    )
    .join('\n');
  return {
    violations: results.violations.length,
    incomplete: results.incomplete.length,
    incompleteIds: results.incomplete.map((v) => v.id),
    detail,
    incompleteDetail,
  };
}

/** The known incomplete: exactly one color-contrast finding (the
 * backdrop-filter limitation above). Any other count or id is a new case. */
function assertKnownIncomplete(result: {
  incomplete: number;
  incompleteIds: string[];
  incompleteDetail: string;
}): void {
  expect(
    result.incomplete,
    `unexpected incomplete count (expected the one backdrop-filter finding):\n${result.incompleteDetail}`,
  ).toBe(1);
  expect(
    result.incompleteIds,
    `unexpected incomplete rule id (expected color-contrast):\n${result.incompleteDetail}`,
  ).toEqual(['color-contrast']);
}

test('a11y: the recommend pill has no WCAG 2 A/AA violations (light)', async () => {
  await renderPill('light');
  const result = await scanPill();
  console.log(
    `a11y light: ${result.violations} violations, ${result.incomplete} incomplete findings`,
  );
  console.log(`a11y light incomplete:\n${result.incompleteDetail}`);
  expect(result.violations, result.detail).toBe(0);
  assertKnownIncomplete(result);
});

test('a11y: the recommend pill has no WCAG 2 A/AA violations (dark)', async () => {
  await renderPill('dark');
  const result = await scanPill();
  console.log(
    `a11y dark: ${result.violations} violations, ${result.incomplete} incomplete findings`,
  );
  console.log(`a11y dark incomplete:\n${result.incompleteDetail}`);
  expect(result.violations, result.detail).toBe(0);
  assertKnownIncomplete(result);
});
