// Interaction-a11y e2e: the REAL shadow-DOM pill driven through the
// keyboard — locator.focus()/press() and page.keyboard, no test-hook
// shortcuts for the button semantics. The unit tests (tests/pill.test.ts)
// cover the same handlers in happy-dom; this lane proves the behaviors in
// real chromium: Enter applies, Escape dismisses, focus returns to the player
// anchor (never stranded in the pill), Tab walks the buttons in DOM order
// (== visual order), and the label/tier live region (role=status) excludes
// the action buttons.
//
// happy-dom limitation: synthetic KeyboardEvents carry no default action,
// so the unit harness never runs native button activation — the double-fire
// bug (the pill-level keydown routing Enter to applyBtn.click() on top of
// the focused button's own native activation) only shows here, in a real
// browser. The two Enter tests below are its lane: Enter on a focused
// Apply fires exactly once (counted in the override log), Enter on a focused
// Dismiss never applies.
//
// What each block pins:
//   (a) Enter-apply and (b) Escape-dismiss re-prove the unit-tested
//       handlers through the real event path (the pill's keydown routing
//       plus native activation). Pins — the handlers exist.
//   (c) focus restoration is the fail-without-fix lane: happy-dom lets any
//       element receive .focus(), so the unit tests cannot see that a plain
//       div anchor (#movie_player) ignores focus() in a real browser. The
//       assertions below drove the restoreFocus fallback (anchor → video →
//       body, verifying focus actually moved).
//   (d) the Tab loop pins the real button order. Apply and Stop-auto are
//       mutually exclusive by design (the undo affordance replaces Apply in
//       the auto-applied state), so the loop is pinned as two pairs: Apply
//       → Dismiss in the plain recommend state, Stop-auto → Dismiss in the
//       auto-applied state.
//   (e) the live-region split pins the a11y-critical layout: role=status on
//       .main-text (label/tier inside), buttons outside it — status regions
//       announce atomically and swallow interactive children.

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURE_PORT } from '../server';
import { defaultSettings, type Settings } from '../../lib/settings';

const extensionPath = resolve('.output/chrome-mv3-e2e');
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
const watchUrl = (fixture: string): string =>
  `http://www.youtube.com/watch?v=e2e-fixture&fixture=${fixture}`;

let context: BrowserContext;
let page: Page;
let serviceWorker: Worker;

/** The override-log apply entries the background store keeps: every apply
 * appends exactly one entry, so the count discriminates a single apply from
 * the pre-fix double-fire. */
async function applyLogCount(): Promise<number> {
  return serviceWorker.evaluate(async () => {
    const items = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get('sw.overrideLog', (items) => resolve(items)),
    );
    const entries = items['sw.overrideLog'] as Array<{ userAction?: string }> | undefined;
    return (entries ?? []).filter((entry) => entry.userAction === 'apply').length;
  });
}

test.beforeAll(async () => {
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `built extension not found at ${extensionPath} — run \`bun run build:e2e\` first (the e2e build keeps the window test hooks)`,
    );
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'speedwatcher-interaction-'));
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
  serviceWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
  await context?.close();
});

/** Navigate (light scheme), wait for the recommend-mode pill. */
async function renderPill(fixture = 'real/manual-cue.json'): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(watchUrl(fixture));
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state?.mode === 'recommend',
    undefined,
    { timeout: 15_000 },
  );
}

/** Write settings through the bridge hook (same path the options page
 * uses); the content script must be up on a youtube page first. */
async function writeSettings(settings: Settings): Promise<void> {
  await page.evaluate(async (next) => {
    const hook = window.__speedwatcherSettings;
    if (hook === undefined) throw new Error('__speedwatcherSettings hook missing');
    await hook.set(next);
  }, settings);
}

/** The focused element inside the pill's shadow root, or null when focus is
 * outside the pill. document.activeElement reports the host while a shadow
 * child holds focus, so the light-DOM probes read shadowRoot.activeElement. */
function shadowActive(): Promise<{ tag: string; cls: string } | null> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
    const active = host?.shadowRoot?.activeElement;
    if (active === null || active === undefined) return null;
    return { tag: active.tagName, cls: active instanceof HTMLElement ? active.className : '' };
  });
}

/** Where document.activeElement landed: 'player' | 'video' | 'body' | 'host'
 * (focus inside the pill's shadow root retargets to the host) | 'other'. */
function lightActive(): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
    if (el === null) return 'null';
    if (host !== null && host.contains(el)) return 'host';
    if (el.id === 'movie_player') return 'player';
    if (el.tagName === 'VIDEO') return 'video';
    if (el === document.body) return 'body';
    return `other:${el.tagName}.${el instanceof HTMLElement ? el.className : ''}`;
  });
}

test('keyboard: Enter on the Apply button applies the recommended rate', async () => {
  await renderPill();
  const multiplier = await page.evaluate(
    () => window.__speedwatcherPill?.state?.multiplier ?? null,
  );
  expect(multiplier).not.toBeNull();
  await page.locator('.speedwatcher-pill-host').locator('button.btn-apply').focus();
  await page.keyboard.press('Enter');
  const rate = await page.evaluate(() => document.querySelector('video')?.playbackRate ?? null);
  expect(rate).not.toBeNull();
  expect(rate).toBeCloseTo(multiplier ?? -1, 2);
});

test('keyboard: Enter on the focused Apply button applies exactly once', async () => {
  await renderPill();
  const before = await applyLogCount();
  await page.locator('.speedwatcher-pill-host').locator('button.btn-apply').focus();
  await page.keyboard.press('Enter');
  // One apply → one log entry. Pre-fix the pill-level keydown routed Enter
  // to applyBtn.click() on top of the focused button's native activation
  // (no preventDefault), so the apply double-fired: two entries, two nudge
  // reports.
  await expect.poll(async () => applyLogCount()).toBe(before + 1);
  const rate = await page.evaluate(() => document.querySelector('video')?.playbackRate ?? null);
  expect(rate).toBeCloseTo(await page.evaluate(() => window.__speedwatcherPill?.state?.multiplier ?? -1), 2);
});

test('keyboard: Enter on the focused Dismiss button never applies and dismisses', async () => {
  await renderPill();
  const before = await applyLogCount();
  await page.locator('.speedwatcher-pill-host').locator('button.btn-dismiss').focus();
  await page.keyboard.press('Enter');
  // The focused Dismiss's own native Enter activation is the ONLY action:
  // the pill hides and the rate stays untouched. Pre-fix the pill-level
  // keydown routed Enter to Apply first (then native dismiss hid the pill)
  // — the rate stayed applied with the pill gone.
  await page.waitForFunction(
    () => window.__speedwatcherPill?.state?.mode === 'none',
    undefined,
    { timeout: 15_000 },
  );
  const rate = await page.evaluate(() => document.querySelector('video')?.playbackRate ?? null);
  expect(rate).toBeCloseTo(1, 6);
  expect(await applyLogCount()).toBe(before);
});

test('keyboard: Escape dismisses the pill', async () => {
  await renderPill();
  await page.locator('.speedwatcher-pill-host').locator('button.btn-apply').focus();
  await page.keyboard.press('Escape');
  const state = await page.evaluate(() => window.__speedwatcherPill?.state ?? null);
  expect(state?.mode).toBe('none');
  // The pill surface leaves the a11y tree (render's none branch).
  const hidden = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.speedwatcher-pill-host');
    const pill = host?.shadowRoot?.querySelector<HTMLElement>('.pill');
    return (
      pill !== null &&
      pill !== undefined &&
      (pill.dataset.mode === 'hidden' || pill.getAttribute('aria-hidden') === 'true')
    );
  });
  expect(hidden).toBe(true);
});

test('focus: apply and dismiss move focus out of the pill to the player anchor', async () => {
  // (a) After Enter-apply the pill stays up (recommend, applied 'user'), so
  // the Apply button remains focusable — without restoreFocus the focus
  // would strand inside the host.
  await renderPill();
  await page.locator('.speedwatcher-pill-host').locator('button.btn-apply').focus();
  await page.keyboard.press('Enter');
  expect(['player', 'video', 'body']).toContain(await lightActive());

  // (b) After Escape-dismiss the pill is hidden but still in the DOM, so
  // the focused button keeps focus unless restoreFocus moved it.
  await renderPill();
  await page.locator('.speedwatcher-pill-host').locator('button.btn-apply').focus();
  await page.keyboard.press('Escape');
  expect(['player', 'video', 'body']).toContain(await lightActive());
  // Not stranded inside the (hidden) pill host.
  expect(await shadowActive()).toBeNull();
});

test('keyboard: Tab walks the pill buttons in DOM order', async () => {
  // (a) Plain recommend state: Apply → Dismiss (Stop-auto hidden until an
  // auto apply replaces Apply; the chapter toggle is absent on this fixture).
  await renderPill();
  await page.locator('.speedwatcher-pill-host').locator('button.btn-apply').focus();
  await page.keyboard.press('Tab');
  expect(await shadowActive()).toEqual({ tag: 'BUTTON', cls: 'btn-dismiss' });
  await page.keyboard.press('Tab');
  // Past the last pill button: the fixture page's only other focusable is
  // the <video>, so focus leaves the pill entirely.
  expect(await shadowActive()).toBeNull();

  // (b) Auto-applied state: Stop-auto → Dismiss. The undo affordance
  // replaced Apply (P1b), so the loop is the auto pair.
  await renderPill();
  try {
    await writeSettings({
      ...defaultSettings(),
      contentType: 'talk',
      autoApply: { enabled: true, contentTypes: {} },
    });
    await renderPill();
    await page.waitForFunction(
      () => window.__speedwatcherPill?.state?.applied === 'auto',
      undefined,
      { timeout: 15_000 },
    );
    const stopAuto = page
      .locator('.speedwatcher-pill-host')
      .locator('button.btn-stop-auto');
    await expect(stopAuto).toBeVisible();
    await stopAuto.focus();
    await page.keyboard.press('Tab');
    expect(await shadowActive()).toEqual({ tag: 'BUTTON', cls: 'btn-dismiss' });
  } finally {
    await writeSettings(defaultSettings());
  }
});

test('a11y: label/tier live region excludes the action buttons', async () => {
  await renderPill();
  // The pill host's accessibility tree is exactly the status live region
  // plus the action buttons as its siblings. children: 'equal' (wired in
  // playwright.config.chromium.ts) pins the exact child set — a button
  // moved inside the status, or any stray node in the pill's a11y
  // surface, fails the snapshot. The status's text child is matched as a
  // regex on the stable tier label (character classes for the parens —
  // the key parser strips backslash escapes), so the rate numbers stay
  // unpinned; the buttons stay role-only.
  await expect(page.locator('.speedwatcher-pill-host')).toMatchAriaSnapshot(`
    - status:
      - text: /from captions [(]corrected[)]/
    - button
    - button
  `);
  console.log('interaction aria snapshot:\n' + (await page.locator('.speedwatcher-pill-host').ariaSnapshot()));
});
