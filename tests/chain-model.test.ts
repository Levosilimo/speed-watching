// @vitest-environment happy-dom
// Chain state-machine model for the caption fetch pipeline
// (lib/caption-fetch.ts fetchCaptions): capture-buffer pick → CC drive +
// wait → web baseUrl → android (transcript params → baseUrl) → web-params
// transcript → none. The model is the executable spec of the chain, written
// from the recorded design in caption-fetch.ts / caption-trigger.ts and the
// AGENTS.md rules (Retrigger ≠ Drive; single measurement per navigation);
// the properties assert the model against an independent formulation of the
// same rules, so a deliberate break — the chain order flipped, or the
// cooldown re-gating the retrigger — fails the run (fail-mode proofs in the
// commit message and the wave report).
//
// The study's command vocabulary (Navigate/Play/CaptureArrives/
// CaptureTimeout/WebOk/WebEmpty/TranscriptOk/AndroidOk/AllFail/
// CooldownRehit) plus the fail counterparts (TranscriptFail/AndroidFail)
// the total-order property needs to reach every chain edge.
//
// Real half: the same command sequences drive the ACTUAL fetchCaptions /
// caption-trigger functions under fake timers with a stub player, and every
// measure must agree with the model's predicted source, cooldown behavior
// and CC restore. Scoped to the chain stages the harness can stage: the
// no-controls page (ccWasOn null) is covered by tests/caption-trigger.test.ts.

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptionFetchContext, CaptionSource } from '../lib/caption-fetch';
import type { PlayerResponse } from '../lib/youtube';
import { TimedtextBuffer } from '../lib/caption-capture';

const SEED = 4242;
/** The drive cooldown window (lib/caption-trigger.ts CC_DRIVE_COOLDOWN_MS). */
const COOLDOWN_MS = 30_000;
const VIDEO_ID = 'model-vid';

type Stage =
  | 'idle'
  | 'drive-wait'
  | 'web'
  | 'android-transcript'
  | 'android-base'
  | 'web-transcript'
  | 'done';

export interface AttemptTrace {
  source: CaptionSource;
  captureDuringWait: boolean;
  webOk: boolean;
  transcriptOk: boolean;
  androidOk: boolean;
  gated: boolean;
  retriggered: boolean;
  driveChanged: boolean;
  retriggerFlipped: boolean;
  retriggerCcWasOn: boolean;
  ccBefore: boolean;
  lastDriveBefore: number | null;
  driveTime: number | null;
  retriggerTime: number | null;
  lastDriveAfter: number | null;
}

export class ChainModel {
  now = 0;
  videoReady = false;
  /** The stub page starts with CC off (the pot-gated lane's initial state). */
  ccPressed = false;
  lastDriveAt: number | null = null;
  /** Buffer mirror: captures survive navigations, the next measure clears. */
  captures = 0;
  captureWordTimed = false;
  stage: Stage = 'idle';
  source: CaptionSource | null = null;
  trace: AttemptTrace | null = null;
  /** Every finished attempt, for the run-level invariant asserts. */
  traces: AttemptTrace[] = [];
}

/** The independent spec of the source chain, written from the recorded
 * design — the model must agree with it on every attempt. */
type SourceDecisions = Pick<AttemptTrace, 'captureDuringWait' | 'webOk' | 'transcriptOk' | 'androidOk'>;

export function expectedSource(trace: SourceDecisions): CaptionSource {
  if (trace.captureDuringWait) return 'capture';
  if (trace.webOk) return 'web';
  if (trace.transcriptOk) return 'android';
  if (trace.androidOk) return 'android';
  return 'none';
}

function beginAttempt(m: ChainModel): void {
  // fetchCaptions clears the buffer at measure start: captures buffered
  // before the measure — a previous attempt's leftover or a player
  // re-fetch — never become this measure's source.
  m.captures = 0;
  m.captureWordTimed = false;
  m.source = null;
  const trace: AttemptTrace = {
    captureDuringWait: false,
    webOk: false,
    transcriptOk: false,
    androidOk: false,
    gated: false,
    retriggered: false,
    driveChanged: false,
    retriggerFlipped: false,
    retriggerCcWasOn: false,
    ccBefore: m.ccPressed,
    lastDriveBefore: m.lastDriveAt,
    driveTime: null,
    retriggerTime: null,
    lastDriveAfter: null,
    source: 'none',
  };
  m.trace = trace;
  if (!m.videoReady) {
    m.stage = 'web';
    return;
  }
  const gated = m.lastDriveAt !== null && m.now - m.lastDriveAt < COOLDOWN_MS;
  trace.gated = gated;
  if (!gated) {
    // The drive flips CC only when it was off; the cooldown records only
    // drives that touched the controls.
    trace.driveChanged = m.ccPressed === false;
    if (trace.driveChanged) m.ccPressed = true;
    m.lastDriveAt = m.now;
    trace.driveTime = m.now;
  }
  m.stage = 'drive-wait';
}

function applyRetrigger(m: ChainModel): void {
  m.now += 7500;
  m.trace!.retriggered = true;
  m.trace!.retriggerCcWasOn = m.ccPressed;
  // Ungated sub-operation of the same attempt (AGENTS.md): it re-drives
  // inside the window and records the cooldown.
  if (m.ccPressed === false) {
    m.ccPressed = true;
    m.trace!.retriggerFlipped = true;
  }
  m.lastDriveAt = m.now;
  m.trace!.retriggerTime = m.now;
}

function finishAttempt(m: ChainModel): void {
  // restoreCcState: only a flip this attempt's drive made is toggled back.
  if (m.trace!.driveChanged && m.trace!.ccBefore === false && m.ccPressed === true) {
    m.ccPressed = false;
  }
  m.trace!.source = m.source ?? 'none';
  m.trace!.lastDriveAfter = m.lastDriveAt;
  m.stage = 'done';
  m.traces.push(m.trace!);
}

const navigate = {
  check: (m: ChainModel) => m.stage === 'idle' || m.stage === 'done',
  run: (m: ChainModel) => {
    m.stage = 'idle';
    m.videoReady = false;
    m.ccPressed = false;
    m.source = null;
    m.trace = null;
  },
  toString: () => 'Navigate',
};

const play = {
  check: (m: ChainModel) => m.stage === 'idle' && !m.videoReady,
  run: (m: ChainModel) => {
    m.videoReady = true;
  },
  toString: () => 'Play',
};

const captureArrivesWordTimed = {
  check: () => true,
  run: (m: ChainModel) => {
    if (m.stage === 'drive-wait') {
      // The wait's poll finds the word-timed capture: the attempt resolves
      // with the capture source before any timeout or retrigger.
      m.now += 2000;
      m.trace!.captureDuringWait = true;
      m.source = 'capture';
      finishAttempt(m);
    } else {
      m.captures += 1;
      m.captureWordTimed = true;
    }
  },
  toString: () => 'CaptureArrives(wordTimed)',
};

const captureArrivesCueOnly = {
  check: () => true,
  run: (m: ChainModel) => {
    // A non-word-timed capture never resolves the wait (pickWordTimed).
    m.captures += 1;
    m.captureWordTimed = false;
  },
  toString: () => 'CaptureArrives(cueOnly)',
};

const measure = {
  check: (m: ChainModel) => m.stage === 'idle',
  run: (m: ChainModel) => beginAttempt(m),
  toString: () => 'Measure',
};

const captureTimeout = {
  check: (m: ChainModel) => m.stage === 'drive-wait',
  run: (m: ChainModel) => {
    m.now += 15_000;
    m.stage = 'web';
  },
  toString: () => 'CaptureTimeout',
};

const retrigger = {
  check: (m: ChainModel) => m.stage === 'drive-wait',
  run: (m: ChainModel) => applyRetrigger(m),
  toString: () => 'Retrigger',
};

const cooldownRehit = {
  check: (m: ChainModel) =>
    m.stage === 'idle' && m.lastDriveAt !== null && m.now - m.lastDriveAt < COOLDOWN_MS,
  run: (m: ChainModel) => {
    m.now += 1000;
  },
  toString: () => 'CooldownRehit',
};

const webOk = {
  check: (m: ChainModel) => m.stage === 'web',
  run: (m: ChainModel) => {
    m.now += 1000;
    m.trace!.webOk = true;
    m.source = 'web';
    finishAttempt(m);
  },
  toString: () => 'WebOk',
};

const webEmpty = {
  check: (m: ChainModel) => m.stage === 'web',
  run: (m: ChainModel) => {
    m.now += 1000;
    m.trace!.webOk = false;
    m.stage = 'android-transcript';
  },
  toString: () => 'WebEmpty',
};

const transcriptOk = {
  check: (m: ChainModel) => m.stage === 'android-transcript' || m.stage === 'web-transcript',
  run: (m: ChainModel) => {
    m.now += 1000;
    m.trace!.transcriptOk = true;
    m.source = 'android';
    finishAttempt(m);
  },
  toString: () => 'TranscriptOk',
};

const transcriptFail = {
  check: (m: ChainModel) => m.stage === 'android-transcript',
  run: (m: ChainModel) => {
    m.now += 1000;
    m.stage = 'android-base';
  },
  toString: () => 'TranscriptFail',
};

const androidOk = {
  check: (m: ChainModel) => m.stage === 'android-base',
  run: (m: ChainModel) => {
    m.now += 1000;
    m.trace!.androidOk = true;
    m.source = 'android';
    finishAttempt(m);
  },
  toString: () => 'AndroidOk',
};

const androidFail = {
  check: (m: ChainModel) => m.stage === 'android-base',
  run: (m: ChainModel) => {
    m.now += 1000;
    m.stage = 'web-transcript';
  },
  toString: () => 'AndroidFail',
};

const allFail = {
  check: (m: ChainModel) => m.stage === 'web-transcript',
  run: (m: ChainModel) => {
    m.now += 1000;
    m.source = 'none';
    finishAttempt(m);
  },
  toString: () => 'AllFail',
};

function pureCommands(): fc.Arbitrary<Iterable<fc.Command<ChainModel, null>>> {
  // The setup commands are duplicated to weight them: a drive needs the
  // Navigate → Play → Measure prefix, and an unweighted uniform pick of 15
  // candidates would rarely reach it (measured: 1 drive in 200 runs).
  return fc.commands(
    [
      fc.constant(navigate),
      fc.constant(navigate),
      fc.constant(navigate),
      fc.constant(navigate),
      fc.constant(navigate),
      fc.constant(play),
      fc.constant(play),
      fc.constant(play),
      fc.constant(play),
      fc.constant(play),
      fc.constant(measure),
      fc.constant(measure),
      fc.constant(measure),
      fc.constant(measure),
      fc.constant(captureArrivesWordTimed),
      fc.constant(captureArrivesCueOnly),
      fc.constant(captureTimeout),
      fc.constant(retrigger),
      fc.constant(cooldownRehit),
      fc.constant(webOk),
      fc.constant(webEmpty),
      fc.constant(transcriptOk),
      fc.constant(transcriptFail),
      fc.constant(androidOk),
      fc.constant(androidFail),
      fc.constant(allFail),
    ],
    { maxCommands: 20 },
  );
}

describe('chain model — pure state machine', () => {
  it('(a) the source follows the chain total order on every attempt', () => {
    fc.assert(
      fc.property(pureCommands(), (cmds) => {
        const model = new ChainModel();
        fc.modelRun(() => ({ model, real: null }), cmds);
        for (const trace of model.traces) {
          expect(trace.source).toBe(expectedSource(trace));
        }
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it('(a) reachability: each source class implies its chain preconditions', () => {
    fc.assert(
      fc.property(pureCommands(), (cmds) => {
        const model = new ChainModel();
        fc.modelRun(() => ({ model, real: null }), cmds);
        for (const trace of model.traces) {
          if (trace.source === 'capture') {
            expect(trace.captureDuringWait).toBe(true);
            expect(trace.webOk).toBe(false);
            expect(trace.transcriptOk).toBe(false);
            expect(trace.androidOk).toBe(false);
          }
          if (trace.source === 'web') {
            expect(trace.captureDuringWait).toBe(false);
            expect(trace.webOk).toBe(true);
          }
          if (trace.source === 'android') {
            expect(trace.webOk).toBe(false);
            expect(trace.captureDuringWait).toBe(false);
            expect(trace.transcriptOk || trace.androidOk).toBe(true);
          }
          if (trace.source === 'none') {
            expect(trace.captureDuringWait).toBe(false);
            expect(trace.webOk).toBe(false);
            expect(trace.transcriptOk).toBe(false);
            expect(trace.androidOk).toBe(false);
          }
        }
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it('reaches the drive, cooldown and retrigger states across the runs', () => {
    // Reachability guard for the generator itself: without the weighted
    // setup commands the chain's interesting states are never exercised
    // (measured: 1 drive in 200 runs) and the properties turn vacuous.
    let drives = 0;
    let retriggered = 0;
    fc.assert(
      fc.property(pureCommands(), (cmds) => {
        const model = new ChainModel();
        fc.modelRun(() => ({ model, real: null }), cmds);
        for (const trace of model.traces) {
          if (trace.driveTime !== null || trace.gated) drives += 1;
          if (trace.retriggered) retriggered += 1;
        }
      }),
      { seed: SEED, numRuns: 3000 },
    );
    expect(drives).toBeGreaterThan(0);
    expect(retriggered).toBeGreaterThan(0);
  });

  it('(c) scenario: a re-measure drive inside the window is gated and records nothing', () => {
    const model = new ChainModel();
    const seq = [
      navigate, play, measure, captureTimeout, webEmpty, transcriptFail, androidFail, allFail,
      navigate, play, measure, captureTimeout, webEmpty, transcriptFail, androidFail, allFail,
    ];
    for (const command of seq) command.run(model);
    const first = model.traces[0];
    const second = model.traces[1];
    expect(first!.gated).toBe(false);
    expect(first!.driveChanged).toBe(true);
    expect(second!.gated).toBe(true);
    expect(second!.driveChanged).toBe(false);
    // The gated drive records nothing: the cooldown keeps the first record.
    expect(second!.lastDriveAfter).toBe(second!.lastDriveBefore);
    expect(second!.lastDriveAfter).toBe(first!.driveTime);
  });

  it('(c) scenario: the same-attempt retrigger is ungated inside the window', () => {
    const model = new ChainModel();
    const seq = [navigate, play, measure, retrigger, captureTimeout, webEmpty, allFail];
    for (const command of seq) command.run(model);
    const trace = model.traces.at(-1)!;
    expect(trace.retriggered).toBe(true);
    expect(trace.gated).toBe(false);
    // The retrigger recorded the cooldown inside the window.
    expect(trace.lastDriveAfter).toBe(trace.retriggerTime);
    // CC was already on from the drive: the retrigger never flips it.
    expect(trace.retriggerFlipped).toBe(false);
    // The restore returned CC to the pre-attempt state.
    expect(model.ccPressed).toBe(trace.ccBefore);
  });

  it('(b) single measurement per navigation: only the wait can yield a capture', () => {
    fc.assert(
      fc.property(pureCommands(), (cmds) => {
        const model = new ChainModel();
        fc.modelRun(() => ({ model, real: null }), cmds);
        for (const trace of model.traces) {
          // A capture buffered before the measure is cleared by it; the
          // capture source exists only when the wait picked one up.
          expect(trace.source === 'capture').toBe(trace.captureDuringWait);
        }
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it('(c) the cooldown gates new drives, never the same attempt retrigger', () => {
    fc.assert(
      fc.property(pureCommands(), (cmds) => {
        const model = new ChainModel();
        fc.modelRun(() => ({ model, real: null }), cmds);
        for (const trace of model.traces) {
          if (trace.gated) {
            // The gated drive touches nothing and records nothing — unless
            // the same attempt's ungated retrigger recorded the cooldown.
            expect(trace.driveChanged).toBe(false);
            expect(trace.lastDriveAfter).toBe(
              trace.retriggered ? trace.retriggerTime : trace.lastDriveBefore,
            );
          } else if (trace.driveTime !== null) {
            expect(trace.driveChanged).toBe(trace.ccBefore === false);
            expect(trace.lastDriveAfter).toBe(trace.retriggerTime ?? trace.driveTime);
          }
          if (trace.retriggered) {
            // Ungated sub-operation: records the cooldown inside the window.
            expect(trace.lastDriveAfter).toBe(trace.retriggerTime);
            expect(trace.retriggerFlipped).toBe(trace.retriggerCcWasOn === false);
          }
        }
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it('(c) the restore returns CC to the pre-attempt state after the attempt', () => {
    fc.assert(
      fc.property(pureCommands(), (cmds) => {
        const model = new ChainModel();
        fc.modelRun(() => ({ model, real: null }), cmds);
        // Only a finished attempt has run its restore; an in-flight one is
        // still mid-fetchCaptions, and a trailing Navigate already reset the
        // page state.
        if (model.stage !== 'done') return;
        const last = model.traces.at(-1);
        if (last === undefined) return;
        if (last.driveChanged) {
          // The drive's flip is reversed by restoreCcState.
          expect(model.ccPressed).toBe(last.ccBefore);
        } else {
          // No flip by the drive: CC unchanged unless the ungated retrigger
          // flipped it (restore leaves it alone — the flip is not the
          // drive's).
          expect(model.ccPressed).toBe(last.ccBefore === false && last.retriggerFlipped ? true : last.ccBefore);
        }
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });
});

// ─── Real half: the actual fetchCaptions/caption-trigger functions under
// fake timers, driven by the same command vocabulary. Every measure must
// agree with the model's predicted source, cooldown behavior and CC
// restore. The stub player mirrors the pot-gated e2e page (controls
// mounted, CC off); the no-controls page stays covered by
// tests/caption-trigger.test.ts.

interface RealRoutes {
  webMode: 'ok' | 'empty';
  androidMode: 'transcript' | 'base' | 'none';
  transcriptOk: boolean;
  webParams: boolean;
}

export interface RealModel {
  pending: { webOk: boolean; transcriptOk: boolean; androidOk: boolean };
  videoReady: boolean;
  ccPressed: boolean;
  lastDriveAt: number | null;
  preMeasureCaptures: number;
}

interface RealHarness {
  /** The fresh-per-run fetchCaptions instance (cooldown map included). */
  fetchCaptions: (track: never, videoId: string, ctx: CaptionFetchContext) => Promise<{ json: unknown; source: CaptionSource }>;
  buffer: TimedtextBuffer;
  video: { readyState: number; paused: boolean; dispatchEvent: () => true };
  routes: RealRoutes;
  /** The current stub's counters; Navigate swaps the stub and the holder. */
  currentCounters: { clicks: { settingsClicks: () => number; ccClicks: () => number } };
  settingsClicks(): number;
  ccClicks(): number;
  ccPressed(): boolean | null;
}

const WORD_TIMED_BODY = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'alpha', tOffsetMs: 0 }] }],
});
const WEB_BODY = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'web payload' }] }],
});
/** The cooldown record lands when a drive's menu settles finish: 3 ×
 * MENU_SETTLE_MS after the drive starts (lib/caption-trigger.ts). The
 * retrigger fires at half the 15s wait and settles the same way. */
const DRIVE_RECORD_OFFSET = 1200;
const RETRIGGER_RECORD_OFFSET = 7500 + DRIVE_RECORD_OFFSET;

function panelWithParams(params: string): unknown {
  return {
    engagementPanelSectionListRenderer: {
      targetId: 'engagement-panel-searchable-transcript',
      content: {
        transcriptRenderer: {
          content: {
            transcriptSearchPanelRenderer: {
              footer: {
                transcriptFooterRenderer: {
                  primaryButton: {
                    buttonRenderer: { command: { getTranscriptEndpoint: { params } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function transcriptResponse(): unknown {
  return {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [
                        {
                          transcriptSegmentRenderer: {
                            startMs: '0',
                            snippet: { runs: [{ text: 'alpha bravo' }] },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}

function androidResponse(params: string | undefined): unknown {
  return {
    captions: {
      playerCaptionsTracklistRenderer: {
        // A distinct query marks the ANDROID track so the fetch mock can
      // tell the bare WEB fetch from the ANDROID baseUrl resort.
      captionTracks: [{ baseUrl: '/api/timedtext?fmt=json3&android=1' }],
      },
    },
    ...(params === undefined ? {} : { engagementPanels: [panelWithParams(params)] }),
  };
}

function stubPlayerControls(): { settingsClicks: () => number; ccClicks: () => number } {
  let settingsClicks = 0;
  let ccClicks = 0;
  const cc = document.createElement('button');
  cc.className = 'ytp-subtitles-button';
  cc.setAttribute('aria-pressed', 'false');
  cc.addEventListener('click', () => {
    ccClicks += 1;
    cc.setAttribute('aria-pressed', cc.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  });
  const settings = document.createElement('button');
  settings.className = 'ytp-settings-button';
  settings.addEventListener('click', () => {
    settingsClicks += 1;
  });
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
  document.body.append(cc, settings, submenu, trackMenu);
  return { settingsClicks: () => settingsClicks, ccClicks: () => ccClicks };
}

/** Fresh trigger/fetch modules + DOM + mocks per fc run: the drive-cooldown
 * map is module state, and each run is an independent scenario. */
async function setupReal(): Promise<{ model: RealModel; real: RealHarness }> {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '';
  const currentCounters = { clicks: stubPlayerControls() };
  const [{ fetchCaptions }, { TimedtextBuffer }] = await Promise.all([
    import('../lib/caption-fetch'),
    import('../lib/caption-capture'),
  ]);
  type FetchCaptions = typeof fetchCaptions;
  const buffer = new TimedtextBuffer();
  // A fresh page's video is paused with no media loaded: the drive
  // requires readyState >= 1 (or a playing video), so Play gates it.
  const video = { readyState: 0, paused: true, dispatchEvent: () => true as const };
  const routes: RealRoutes = { webMode: 'empty', androidMode: 'none', transcriptOk: false, webParams: false };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === '/youtubei/v1/player') {
      if (routes.androidMode === 'transcript') {
        return { ok: true, json: async () => androidResponse('PARAMS') };
      }
      if (routes.androidMode === 'base') {
        return { ok: true, json: async () => androidResponse(undefined) };
      }
      return { ok: false, json: async () => null };
    }
    if (url.pathname === '/youtubei/v1/get_transcript') {
      if (routes.transcriptOk) return { ok: true, json: async () => transcriptResponse() };
      return { ok: false, json: async () => null };
    }
    if (routes.androidMode === 'base' && url.searchParams.get('android') === '1') {
      return { ok: true, json: async () => JSON.parse(WEB_BODY) };
    }
    if (routes.webMode === 'ok') return { ok: true, json: async () => JSON.parse(WEB_BODY) };
    // The POT gate: HTTP 200 with an empty body — response.json() throws.
    return { ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
  });
  vi.stubGlobal('fetch', fetchMock);
  window.ytcfg = {
    get: (name: string) =>
      name === 'INNERTUBE_API_KEY' ? 'AIza-KEY' : name === 'INNERTUBE_CONTEXT' ? { client: {} } : undefined,
  };
  return {
    model: {
      pending: { webOk: false, transcriptOk: false, androidOk: false },
      videoReady: false,
      ccPressed: false,
      lastDriveAt: null,
      preMeasureCaptures: 0,
    },
    real: {
      fetchCaptions: fetchCaptions as FetchCaptions,
      buffer,
      video,
      routes,
      currentCounters,
      settingsClicks: () => currentCounters.clicks.settingsClicks(),
      ccClicks: () => currentCounters.clicks.ccClicks(),
      ccPressed: () => {
        const button = document.querySelector<HTMLElement>('button.ytp-subtitles-button');
        return button === null ? null : button.getAttribute('aria-pressed') === 'true';
      },
    },
  };
}

/** The model's prediction for one measure, given the harness state. */
function predict(m: RealModel, captureDuringWait: boolean): {
  source: CaptionSource;
  gated: boolean;
} {
  const trace = {
    // Without a ready video the drive+wait never runs, so the scheduled
    // capture cannot resolve the attempt (the real chain skips to web).
    captureDuringWait: m.videoReady && captureDuringWait,
    ...m.pending,
  };
  return {
    source: expectedSource(trace),
    gated: m.lastDriveAt !== null && Date.now() - m.lastDriveAt < COOLDOWN_MS,
  };
}

async function runMeasure(
  m: RealModel,
  harness: RealHarness,
  captureDuringWait: boolean,
  videoId: string,
): Promise<void> {
  const prediction = predict(m, captureDuringWait);
  const settingsBefore = harness.settingsClicks();
  const ccBefore = harness.ccPressed();
  const measureStart = Date.now();
  if (captureDuringWait) {
    setTimeout(() => {
      harness.buffer.add(videoId, { url: 'https://www.youtube.com/api/timedtext', httpStatus: 200, body: WORD_TIMED_BODY });
    }, 2000);
  }
  const track = { baseUrl: '/api/timedtext?fmt=json3', kind: 'asr', languageCode: 'en' } as never;
  const pending = harness.fetchCaptions(track, videoId, {
    buffer: harness.buffer,
    video: harness.video as unknown as HTMLVideoElement,
    playerResponse: harness.routes.webParams
      ? ({ engagementPanels: [panelWithParams('WEBPARAMS')] } as unknown as PlayerResponse)
      : null,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  const result = await pending;

  // (a) the real chain must report the predicted source.
  expect(result.source).toBe(prediction.source);
  // (b) a capture buffered before the measure never becomes its source.
  if (m.preMeasureCaptures > 0) {
    expect(result.source).not.toBe('capture');
  }

  // Mirror the cooldown record: the drive settles at +1.2s, the retrigger
  // at +7.5s, each recording on completion.
  if (m.videoReady) {
    if (captureDuringWait) {
      m.lastDriveAt = measureStart + DRIVE_RECORD_OFFSET;
    } else {
      m.lastDriveAt = measureStart + RETRIGGER_RECORD_OFFSET;
    }
  }
  const timedOut = m.videoReady && !captureDuringWait;
  const driveClicks = m.videoReady && !prediction.gated ? 1 : 0;
  const retriggerClicks = timedOut ? 1 : 0;
  expect(harness.settingsClicks(), 'settings clicks').toBe(settingsBefore + driveClicks + retriggerClicks);
  void ccBefore;
  void harness.ccClicks;

  // Mirror CC state through the attempt, then check the real restore.
  const driveChanged = m.videoReady && !prediction.gated && m.ccPressed === false;
  if (driveChanged) {
    m.ccPressed = true; // the drive flipped CC on
  }
  if (timedOut && m.ccPressed === false) {
    m.ccPressed = true; // the ungated retrigger flipped it
  }
  if (driveChanged && ccBefore === false && m.ccPressed === true) {
    m.ccPressed = false; // restoreCcState toggles only the drive's own flip
  }
  expect(harness.ccPressed(), 'cc state after restore').toBe(m.ccPressed);

  // The measure consumed the staged outcomes.
  m.pending = { webOk: false, transcriptOk: false, androidOk: false };
  m.preMeasureCaptures = 0;
  harness.routes.webMode = 'empty';
  harness.routes.androidMode = 'none';
  harness.routes.transcriptOk = false;
  harness.routes.webParams = false;
}

const realNavigate = {
  check: () => true,
  run: async (_m: RealModel, harness: RealHarness) => {
    document.body.innerHTML = '';
    harness.currentCounters.clicks = stubPlayerControls();
    harness.video.readyState = 0;
    _m.videoReady = false;
    _m.ccPressed = false;
    _m.preMeasureCaptures = 0;
  },
  toString: () => 'Navigate',
};

const realPlay = {
  check: (m: RealModel) => !m.videoReady,
  run: async (m: RealModel, harness: RealHarness) => {
    harness.video.readyState = 1;
    m.videoReady = true;
  },
  toString: () => 'Play',
};

const realCaptureArrives = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    harness.buffer.add(VIDEO_ID, {
      url: 'https://www.youtube.com/api/timedtext',
      httpStatus: 200,
      body: WORD_TIMED_BODY,
    });
    m.preMeasureCaptures += 1;
  },
  toString: () => 'CaptureArrives',
};

const realMeasure = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    await runMeasure(m, harness, false, VIDEO_ID);
  },
  toString: () => 'Measure',
};

const realMeasureWithCapture = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    await runMeasure(m, harness, true, VIDEO_ID);
  },
  toString: () => 'Measure(captureDuringWait)',
};

const realCooldownRehit = {
  check: (m: RealModel) =>
    m.lastDriveAt !== null && Date.now() - m.lastDriveAt < COOLDOWN_MS,
  run: async (m: RealModel, harness: RealHarness) => {
    await runMeasure(m, harness, false, VIDEO_ID);
  },
  toString: () => 'CooldownRehit',
};

const realWebOk = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    harness.routes.webMode = 'ok';
    m.pending.webOk = true;
  },
  toString: () => 'WebOk',
};

const realWebEmpty = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    harness.routes.webMode = 'empty';
    m.pending.webOk = false;
  },
  toString: () => 'WebEmpty',
};

const realTranscriptOk = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    harness.routes.androidMode = 'transcript';
    harness.routes.transcriptOk = true;
    m.pending.transcriptOk = true;
  },
  toString: () => 'TranscriptOk',
};

const realAndroidOk = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    harness.routes.androidMode = 'base';
    m.pending.androidOk = true;
  },
  toString: () => 'AndroidOk',
};

const realAllFail = {
  check: () => true,
  run: async (m: RealModel, harness: RealHarness) => {
    harness.routes.androidMode = 'none';
    harness.routes.transcriptOk = false;
    harness.routes.webParams = false;
    m.pending.transcriptOk = false;
    m.pending.androidOk = false;
  },
  toString: () => 'AllFail',
};

function realCommands(): fc.Arbitrary<Iterable<fc.AsyncCommand<RealModel, RealHarness>>> {
  return fc.commands(
    [
      fc.constant(realNavigate),
      fc.constant(realPlay),
      fc.constant(realCaptureArrives),
      fc.constant(realMeasure),
      fc.constant(realMeasureWithCapture),
      fc.constant(realCooldownRehit),
      fc.constant(realWebOk),
      fc.constant(realWebEmpty),
      fc.constant(realTranscriptOk),
      fc.constant(realAndroidOk),
      fc.constant(realAllFail),
    ],
    { maxCommands: 8 },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllTimers();
  document.body.innerHTML = '';
});

describe('chain model — real fetchCaptions under fake timers', () => {
  it('every generated measure agrees with the model', async () => {
    await fc.assert(
      fc.asyncProperty(realCommands(), async (cmds) => {
        await fc.asyncModelRun(() => setupReal(), cmds);
      }),
      { seed: SEED, numRuns: 25 },
    );
  });
});
