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

describe('triggerCcAutomation interaction gates (wave-5 complementary)', () => {
  it('does not click the CC button when CC is already on (the player/user owns it)', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc, ccClicks, settingsClicks } = stubPlayerControls();
    cc.setAttribute('aria-pressed', 'true');
    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result).toEqual({ ccWasOn: true, changed: false });
    expect(ccClicks()).toBe(0);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
    expect(settingsClicks()).toBe(1); // the drive still walks the menu
  });

  it('restore never toggles off a CC the user turned on after a suppressed call', async () => {
    // The suppressed drive recorded ccWasOn:false (CC was off when it ran);
    // the user turned CC on before the restore — the restore must not flip it.
    const { restoreCcState } = await freshTrigger();
    const { cc } = stubPlayerControls();
    cc.setAttribute('aria-pressed', 'true');
    restoreCcState({ ccWasOn: false, changed: false });
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('restore does not click when the player toggled CC off after our flip', async () => {
    // The drive flipped CC on (changed:true, ccWasOn:false) but the player
    // reset the button before the restore ran — a click would turn CC back on.
    const { restoreCcState } = await freshTrigger();
    const { cc } = stubPlayerControls();
    restoreCcState({ ccWasOn: false, changed: true });
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });

  it('picks the RU auto track row and skips the RU control rows', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc } = stubPlayerControls();
    // Replace the English track row with RU labels: the auto row carries
    // "автоматически созданные", and the picker also has the Off row.
    const trackMenu = document.querySelector<HTMLElement>('.ytp-panel-menu:nth-of-type(2)');
    trackMenu?.replaceChildren();
    const autoRow = document.createElement('div');
    autoRow.className = 'ytp-menuitem';
    const autoLabel = document.createElement('div');
    autoLabel.className = 'ytp-menuitem-label';
    autoLabel.textContent = 'Русский (автоматически созданные)';
    autoRow.appendChild(autoLabel);
    Object.defineProperty(autoRow, 'offsetParent', { value: document.body, configurable: true });
    trackMenu?.append(autoRow);
    const offRow = document.createElement('div');
    offRow.className = 'ytp-menuitem';
    const offLabel = document.createElement('div');
    offLabel.className = 'ytp-menuitem-label';
    offLabel.textContent = 'Выключить';
    offRow.appendChild(offLabel);
    Object.defineProperty(offRow, 'offsetParent', { value: document.body, configurable: true });
    trackMenu?.append(offRow);

    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result.changed).toBe(true);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('excludes hidden rows (display:none sibling panels) from the menu scan', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc } = stubPlayerControls();
    // A hidden "Subtitles/CC" row from the settings panel: without the
    // visibility filter the picker would re-enter the wrong menu.
    const hidden = document.createElement('div');
    hidden.className = 'ytp-menuitem';
    const hiddenLabel = document.createElement('div');
    hiddenLabel.className = 'ytp-menuitem-label';
    hiddenLabel.textContent = 'Subtitles/CC';
    hidden.appendChild(hiddenLabel);
    Object.defineProperty(hidden, 'offsetParent', { value: null, configurable: true });
    document.body.append(hidden);

    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result.changed).toBe(true);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('aborts after the settings menu without a Subtitles row, and still closes the menu', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc } = stubPlayerControls();
    const submenu = document.querySelector<HTMLElement>('.ytp-panel-menu');
    submenu?.replaceChildren(); // no Subtitles/CC row
    const escapeSpy = vi.spyOn(document, 'dispatchEvent');

    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(4000); // the 3s row wait times out
    const result = await drive;
    expect(result.changed).toBe(true); // CC flip recorded
    expect(escapeSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'keydown', key: 'Escape' }));
  });

  it('aborts on a track picker with only control rows, and still closes the menu', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc } = stubPlayerControls();
    const trackMenu = document.querySelector<HTMLElement>('.ytp-panel-menu:nth-of-type(2)');
    trackMenu?.replaceChildren();
    for (const label of ['Off', 'Options']) {
      const row = document.createElement('div');
      row.className = 'ytp-menuitem';
      const rowLabel = document.createElement('div');
      rowLabel.className = 'ytp-menuitem-label';
      rowLabel.textContent = label;
      row.appendChild(rowLabel);
      Object.defineProperty(row, 'offsetParent', { value: document.body, configurable: true });
      trackMenu?.append(row);
    }
    const escapeSpy = vi.spyOn(document, 'dispatchEvent');

    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result.changed).toBe(true);
    expect(escapeSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'keydown', key: 'Escape' }));
  });

  it('prunes the cooldown entry exactly at the 30s boundary', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { settingsClicks } = stubPlayerControls();
    await driveToCompletion(triggerCcAutomation, 'v1');
    // Advance to exactly 30_000ms past the record — the prune is >=, so the
    // entry expires and the drive runs again.
    await vi.advanceTimersByTimeAsync(30_000);
    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    await drive;
    expect(settingsClicks()).toBe(2);
  });
});

describe('pickTrackRow fallbacks (wave-5 batch B)', () => {
  function trackPickerRows(labels: string[]): void {
    const trackMenu = document.querySelector<HTMLElement>('.ytp-panel-menu:nth-of-type(2)');
    trackMenu?.replaceChildren();
    for (const label of labels) {
      const row = document.createElement('div');
      row.className = 'ytp-menuitem';
      const rowLabel = document.createElement('div');
      rowLabel.className = 'ytp-menuitem-label';
      rowLabel.textContent = label;
      row.appendChild(rowLabel);
      Object.defineProperty(row, 'offsetParent', { value: document.body, configurable: true });
      trackMenu?.append(row);
    }
  }

  afterEach(() => {
    delete document.documentElement.lang;
  });

  it('picks the UI-language track by its endonym when no ASR track exists', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc } = stubPlayerControls();
    document.documentElement.lang = 'de';
    trackPickerRows(['Deutsch', 'Off']);
    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result.changed).toBe(true);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the first non-control row when the endonym is unresolvable', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc } = stubPlayerControls();
    document.documentElement.lang = 'zz'; // Intl.DisplayNames throws → null endonym
    trackPickerRows(['Türkçe', 'Off', 'Options']);
    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result.changed).toBe(true);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('rowLabel falls back to the row text when the label element is absent', async () => {
    const { triggerCcAutomation } = await freshTrigger();
    const { cc } = stubPlayerControls();
    const trackMenu = document.querySelector<HTMLElement>('.ytp-panel-menu:nth-of-type(2)');
    trackMenu?.replaceChildren();
    const row = document.createElement('div');
    row.className = 'ytp-menuitem';
    row.textContent = 'English (auto-generated)'; // no .ytp-menuitem-label child
    Object.defineProperty(row, 'offsetParent', { value: document.body, configurable: true });
    trackMenu?.append(row);
    const drive = triggerCcAutomation('v1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await drive;
    expect(result.changed).toBe(true);
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });

  it('restore closes the menu stack with a cancelable Escape', async () => {
    const { restoreCcState } = await freshTrigger();
    stubPlayerControls();
    const escapeSpy = vi.spyOn(document, 'dispatchEvent');
    restoreCcState({ ccWasOn: false, changed: false });
    expect(escapeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'keydown', key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
});
