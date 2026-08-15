// @vitest-environment happy-dom
// Drive-cooldown + restore-discipline unit tests for the CC automation
// (lib/caption-trigger.ts). The stub mirrors e2e/server.ts's potGatedStub:
// a CC button that toggles aria-pressed on click, a settings button, and
// the Subtitles/CC → ASR-track menu rows. happy-dom has no layout engine,
// so offsetParent is stubbed per control (the trigger's visibility waits
// treat a non-null offsetParent as rendered).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimedtextBuffer } from '../lib/caption-capture';
import type {
  CcDriveResult,
} from '../lib/caption-trigger';

/** Fresh trigger module per test: the drive-cooldown map is module state,
 * and each test is an independent scenario (vi.resetModules + dynamic
 * import give a clean map without test-only exports). */
async function freshTrigger(): Promise<{
  triggerCcAutomation(videoId: string): Promise<CcDriveResult>;
  restoreCcState(drive: CcDriveResult): void;
  waitForWordTimedCapture: typeof import('../lib/caption-trigger').waitForWordTimedCapture;
}> {
  return await import('../lib/caption-trigger');
}

interface StubControls {
  cc: HTMLButtonElement;
  settings: HTMLButtonElement;
  settingsClicks(): number;
  ccClicks(): number;
}

/** The pot-gated stub player controls, mounted into the document. Mirrors
 * the e2e fixture pages (synthetic/pot-gated.json and the bug-zoo variants
 * in tests/fixtures/BUG_ZOO.md). */
function stubPlayerControls(ccTogglesOnClick = true): StubControls {
  const cc = document.createElement('button');
  cc.className = 'ytp-subtitles-button';
  cc.setAttribute('aria-pressed', 'false');
  if (ccTogglesOnClick) {
    cc.addEventListener('click', () => {
      cc.setAttribute('aria-pressed', cc.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    });
  }

  const settings = document.createElement('button');
  settings.className = 'ytp-settings-button';

  const submenu = document.createElement('div');
  submenu.className = 'ytp-panel-menu';
  const submenuRow = document.createElement('div');
  submenuRow.className = 'ytp-menuitem';
  const submenuLabel = document.createElement('div');
  submenuLabel.className = 'ytp-menuitem-label';
  submenuLabel.textContent = 'Subtitles/CC';
  submenuRow.appendChild(submenuLabel);
  submenu.appendChild(submenuRow);

  const trackMenu = document.createElement('div');
  trackMenu.className = 'ytp-panel-menu';
  const trackRow = document.createElement('div');
  trackRow.className = 'ytp-menuitem';
  const trackLabel = document.createElement('div');
  trackLabel.className = 'ytp-menuitem-label';
  trackLabel.textContent = 'English (auto-generated)';
  trackRow.appendChild(trackLabel);
  trackMenu.appendChild(trackRow);

  for (const el of [cc, settings, submenuRow, trackRow]) {
    Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  }

  let settingsClicks = 0;
  let ccClicks = 0;
  settings.addEventListener('click', () => {
    settingsClicks += 1;
  });
  cc.addEventListener('click', () => {
    ccClicks += 1;
  });

  document.body.append(cc, settings, submenu, trackMenu);
  return { cc, settings, settingsClicks: () => settingsClicks, ccClicks: () => ccClicks };
}

/** Drive once to completion (the menu settles take ~1.2s of fake time). */
async function driveToCompletion(
  trigger: (videoId: string) => Promise<CcDriveResult>,
  videoId: string,
): Promise<void> {
  const drive = trigger(videoId);
  await vi.advanceTimersByTimeAsync(2000);
  await drive;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('triggerCcAutomation drive cooldown', () => {
  it('suppresses a second drive of the same video within the window', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc, settingsClicks, ccClicks } = stubPlayerControls();
    await driveToCompletion(triggerCcAutomation, 'v1');
    expect(cc.getAttribute('aria-pressed')).toBe('true');
    expect(settingsClicks()).toBe(1);

    // The re-measure path calls again within 30s: the drive must not run.
    const suppressed = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(100);
    const result = await suppressed;
    expect(result).toEqual({ ccWasOn: true, changed: false });
    expect(settingsClicks()).toBe(1);
    expect(ccClicks()).toBe(1);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('re-drives once the cooldown window has passed', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { settingsClicks } = stubPlayerControls();
    await driveToCompletion(triggerCcAutomation, 'v1'); // recorded ~1.2s in
    await vi.advanceTimersByTimeAsync(32_000); // > 30s past the record
    await driveToCompletion(triggerCcAutomation, 'v1');
    expect(settingsClicks()).toBe(2);
  });

  it('does not suppress a different video', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { settingsClicks } = stubPlayerControls();
    await driveToCompletion(triggerCcAutomation, 'v1');
    await driveToCompletion(triggerCcAutomation, 'v2');
    expect(settingsClicks()).toBe(2);
  });

  it('the retrigger re-drives within the cooldown window (same-attempt recovery)', async () => {
    const { triggerCcAutomation, waitForWordTimedCapture } = await freshTrigger();
    const { cc, settingsClicks } = stubPlayerControls();
    await driveToCompletion(triggerCcAutomation, 'v1');
    expect(settingsClicks()).toBe(1);
    const nudge = vi.fn();
    // timeout=2000 → the retrigger fires at 1000ms, the drive recorded
    // ~1.2s in — inside the cooldown window. The retrigger is the same
    // capture attempt's recovery pass (the first drive may have raced the
    // track list), so it must re-drive even though a re-measure would not.
    const capture = waitForWordTimedCapture(new TimedtextBuffer(), 'v1', nudge, 2000, 50);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await capture).toBeNull();
    expect(settingsClicks()).toBe(2);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('the retrigger drive records the cooldown entry (a later re-measure stays gated)', async () => {
    const { triggerCcAutomation, waitForWordTimedCapture } = await freshTrigger();
    const { cc, settingsClicks } = stubPlayerControls();
    await driveToCompletion(triggerCcAutomation, 'v1');
    const capture = waitForWordTimedCapture(new TimedtextBuffer(), 'v1', () => undefined, 2000, 50);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await capture).toBeNull();
    expect(settingsClicks()).toBe(2);

    // An external (re-measure) drive right after the retrigger still no-ops:
    // the retrigger's drive recorded the cooldown entry itself.
    const suppressed = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(100);
    const result = await suppressed;
    expect(result).toEqual({ ccWasOn: true, changed: false });
    expect(settingsClicks()).toBe(2);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('a drive that touched nothing does not start a cooldown', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    // No controls on the page: the drive finds nothing and must not block
    // a later drive (the retrigger's second chance for late-rendering
    // controls). Both visibility waits time out (3s each).
    const first = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(7000);
    expect(await first).toEqual({ ccWasOn: null, changed: false });

    // With the controls now present, a drive still runs.
    stubPlayerControls();
    await driveToCompletion(triggerCcAutomation, 'v1');
    expect(
      document.querySelector('button.ytp-subtitles-button')?.getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('restoreCcState restore discipline', () => {
  it('turns CC back off after a drive that flipped it on', async () => {
    const { triggerCcAutomation, restoreCcState } = await freshTrigger();
    const { cc } = stubPlayerControls();
    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result).toEqual({ ccWasOn: false, changed: true });
    expect(cc.getAttribute('aria-pressed')).toBe('true');

    restoreCcState(result);
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });

  it('never toggles off a CC state this drive did not change', async () => {
    const { restoreCcState } = await freshTrigger();
    const { cc } = stubPlayerControls();
    // The user/player turned CC on: our suppressed call saw it on.
    cc.setAttribute('aria-pressed', 'true');
    restoreCcState({ ccWasOn: true, changed: false });
    expect(cc.getAttribute('aria-pressed')).toBe('true');

    // CC off, no flip by us (suppressed or no-op drive): stays off.
    cc.setAttribute('aria-pressed', 'false');
    restoreCcState({ ccWasOn: false, changed: false });
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports changed=false when the CC click does not land, and restores nothing', async () => {
    const { triggerCcAutomation, restoreCcState } = await freshTrigger();
    // A button whose click never flips aria-pressed (the player raced the
    // automation): the drive must not later toggle anything off.
    const { cc } = stubPlayerControls(false);
    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result.changed).toBe(false);

    restoreCcState(result);
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });
});
