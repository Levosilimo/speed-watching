// Drives the player's CC controls so it fetches the signed timedtext the
// extension captures (lib/caption-capture.ts) — the only payload source
// after YouTube's POT gate (200-empty on bare fetches). Every step is a
// no-op when its selector never appears: the sequence must never throw on
// a page without a player or a menu. MAIN-world only (needs page context).

import { type CapturedTimedtext, TimedtextBuffer } from './caption-capture';

const STEP_WAIT_MS = 3000;
const MENU_SETTLE_MS = 400;
const POLL_MS = 100;

// ASR track labels: EN "auto-generated", RU "автоматически…", or the
// explicit "(asr)" marker. The RU tokens are included because the
// extension ships a RU UI (lib/i18n-ru.ts).
const AUTO_TRACK_RE = /auto[- ]?generated|автомат|\(asr\)/i;
const SUBTITLES_MENU_RE = /subtitles|captions|субтитр/i;
// Control rows of the track picker — never tracks ("Выключить"/"Параметры"
// are the RU Off/Options labels).
const CONTROL_ROW_RE = /^(off|options|выключить|параметры)$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowLabel(row: HTMLElement): string {
  const label = row.querySelector('.ytp-menuitem-label');
  return (label?.textContent ?? row.textContent ?? '').trim();
}

/** Visible rows only — hidden sibling panels (display:none) would match the
 * previous menu's rows, e.g. the "Subtitles/CC" row of the settings panel
 * inside the track picker. */
function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.ytp-menuitem')].filter(
    (item) => item.offsetParent !== null,
  );
}

async function waitForVisible(selector: string): Promise<HTMLElement | null> {
  const deadline = Date.now() + STEP_WAIT_MS;
  for (;;) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el !== null && el.offsetParent !== null) return el;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

async function waitForMenuRow(re: RegExp): Promise<HTMLElement | null> {
  const deadline = Date.now() + STEP_WAIT_MS;
  for (;;) {
    const row = menuItems().find((item) => re.test(rowLabel(item)));
    if (row !== undefined) return row;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

/** The UI language's own name ("Deutsch" for de, "Русский" for ru): the
 * track in the UI language carries exactly that label. Derived via
 * Intl.DisplayNames — no per-locale table. */
function uiLanguageEndonym(): string | null {
  const lang = document.documentElement.lang || navigator.language;
  const primary = lang.split('-')[0];
  if (primary === undefined || primary === '') return null;
  try {
    return new Intl.DisplayNames([primary], { type: 'language' }).of(primary) ?? null;
  } catch {
    return null;
  }
}

function pickTrackRow(rows: HTMLElement[]): HTMLElement | null {
  const auto = rows.find((row) => AUTO_TRACK_RE.test(rowLabel(row)));
  if (auto !== undefined) return auto;
  const endonym = uiLanguageEndonym();
  if (endonym !== null) {
    const localized = rows.find((row) =>
      rowLabel(row).toLocaleLowerCase().startsWith(endonym.toLocaleLowerCase()),
    );
    if (localized !== undefined) return localized;
  }
  return rows.find((row) => !CONTROL_ROW_RE.test(rowLabel(row))) ?? null;
}

function closeMenus(): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

/** Restores the pre-automation CC state after a capture attempt: turns CC
 * back off when it was off before the trigger, and closes any menu the
 * automation left open. Idempotent — safe on every exit path and after the
 * retrigger. The re-picked ASR track persists (YouTube keeps the track);
 * the CC-off restores the visual state. */
export function restoreCcState(ccWasOn: boolean | null): void {
  if (ccWasOn === false) {
    const ccButton = document.querySelector<HTMLElement>('button.ytp-subtitles-button');
    if (ccButton !== null && ccButton.getAttribute('aria-pressed') === 'true') {
      ccButton.click();
    }
  }
  closeMenus();
}

export async function triggerCcAutomation(): Promise<boolean | null> {
  // The prior CC state, captured before any click — the caller restores it
  // after the capture attempt (null: no CC controls on this page).
  const ccButton = await waitForVisible('button.ytp-subtitles-button');
  const ccWasOn = ccButton === null ? null : ccButton.getAttribute('aria-pressed') === 'true';
  try {
    // 1 — CC on unless already on (aria-pressed mirrors the toggle state).
    if (ccButton !== null && ccWasOn === false) {
      ccButton.click();
    }

    // 2 — settings (gear); the menu renders async.
    const settingsButton = await waitForVisible('button.ytp-settings-button');
    if (settingsButton === null) return ccWasOn;
    settingsButton.click();
    await sleep(MENU_SETTLE_MS);

    // 3 — the "Subtitles/CC" submenu row.
    const submenuRow = await waitForMenuRow(SUBTITLES_MENU_RE);
    if (submenuRow === null) return ccWasOn;
    submenuRow.click();
    await sleep(MENU_SETTLE_MS);

    // 4 — the ASR track, else the UI language's track, else the first real
    // track row. Picking the active track again is harmless (re-fetch).
    const trackRow = pickTrackRow(menuItems());
    if (trackRow !== null) trackRow.click();
    await sleep(MENU_SETTLE_MS);

    return ccWasOn;
  } finally {
    // Every exit path closes the menu stack (the Escape step).
    closeMenus();
  }
}

/** Polls pickWordTimed up to timeoutMs. Nudges the user once at
 * min(timeout/3, 5000) and re-runs triggerCcAutomation once around
 * timeout/2 — the first pass may have raced the track list (the ~22s
 * preview), the second re-picks it. */
export async function waitForWordTimedCapture(
  buffer: TimedtextBuffer,
  videoId: string,
  nudge: () => void,
  timeoutMs = 15000,
  pollIntervalMs = 250,
): Promise<CapturedTimedtext | null> {
  const start = Date.now();
  const nudgeAt = Math.min(timeoutMs / 3, 5000);
  const retriggerAt = timeoutMs / 2;
  let nudged = false;
  let retriggered = false;
  for (;;) {
    const capture = buffer.pickWordTimed(videoId);
    if (capture !== null) return capture;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return null;
    if (!nudged && elapsed >= nudgeAt) {
      nudged = true;
      nudge();
    }
    if (!retriggered && elapsed >= retriggerAt) {
      retriggered = true;
      void triggerCcAutomation();
    }
    await sleep(pollIntervalMs);
  }
}
