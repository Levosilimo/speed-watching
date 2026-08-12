import {
  errorMessage,
  isAck,
  isOffscreenEvent,
  isOptionsMessage,
  isRecord,
} from './audio-probe';
import type { OffscreenEvent, OffscreenMessage, ProbeState, WasmCheckResult } from './audio-probe';

const MIRROR_KEY = 'probeCapture';

interface OrchestratorApi {
  tabs: {
    query(info: {
      active?: boolean;
      currentWindow?: boolean;
      audible?: boolean;
      windowType?: string;
    }): Promise<Array<{ id?: number }>>;
    onActivated: { addListener(listener: (info: { tabId: number }) => void): void };
    onRemoved: { addListener(listener: (tabId: number) => void): void };
  };
  tabCapture: { getMediaStreamId(options: { targetTabId: number }): Promise<string> };
  // Optional: chrome.offscreen does not exist in Firefox — startCapture
  // degrades to a 'not supported' error instead of throwing (see guard).
  offscreen?: {
    createDocument(options: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
  };
  runtime: {
    getContexts(filter: { contextTypes?: string[] }): Promise<unknown[]>;
    sendMessage(message: OffscreenMessage): Promise<unknown>;
  };
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
}

interface OrchestratorOptions {
  offscreenUrl: string;
  forwardRetryMs?: number;
  forwardMaxTries?: number;
}

interface CaptureMirror {
  state: 'starting' | 'capturing' | 'degraded' | 'error';
  tabId: number;
  error?: string;
}

interface ActiveCapture extends CaptureMirror {
  level: number;
}

function parseMirror(value: unknown): CaptureMirror | undefined {
  if (!isRecord(value) || typeof value.tabId !== 'number') return undefined;
  const state = value.state;
  if (state !== 'starting' && state !== 'capturing' && state !== 'degraded' && state !== 'error') {
    return undefined;
  }
  return {
    state,
    tabId: value.tabId,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class CaptureOrchestrator {
  private readonly api: OrchestratorApi;
  private readonly forwardRetryMs: number;
  private readonly forwardMaxTries: number;
  private readonly offscreenUrl: string;
  private capture: ActiveCapture | null = null;
  private wasm: WasmCheckResult | undefined;

  constructor(api: OrchestratorApi, options: OrchestratorOptions) {
    this.api = api;
    this.offscreenUrl = options.offscreenUrl;
    this.forwardRetryMs = options.forwardRetryMs ?? 150;
    this.forwardMaxTries = options.forwardMaxTries ?? 10;

    api.tabs.onActivated.addListener(({ tabId }) => {
      if (this.capture && tabId !== this.capture.tabId) void this.interrupt('tab switched away');
    });
    api.tabs.onRemoved.addListener((tabId) => {
      if (this.capture && tabId === this.capture.tabId) void this.interrupt('captured tab closed');
    });
  }

  async handleMessage(message: unknown, sender?: { tab?: { id?: number } }): Promise<unknown> {
    if (isOptionsMessage(message)) {
      switch (message.kind) {
        case 'probe-start':
          return this.startCapture(sender?.tab?.id);
        case 'probe-stop':
          return this.stopCapture();
        case 'probe-state':
          return this.getState();
      }
    }
    if (isOffscreenEvent(message)) {
      await this.handleEvent(message);
      return undefined;
    }
    // Forwarded offscreen-* messages bounce back to this same listener.
    return undefined;
  }

  async init(): Promise<void> {
    const stored = (await this.api.storage.session.get(MIRROR_KEY))[MIRROR_KEY];
    const mirror = parseMirror(stored);
    if (!mirror) return;
    this.capture = { state: mirror.state, tabId: mirror.tabId, level: 0, error: mirror.error };
    if (mirror.state === 'starting' || mirror.state === 'capturing') {
      const contexts = await this.api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.length === 0) {
        this.capture.state = 'degraded';
        this.capture.error = 'capture lost: offscreen document gone';
        await this.saveMirror();
      }
    }
  }

  private async startCapture(senderTabId?: number): Promise<ProbeState> {
    if (this.capture) await this.stopCaptureInternal();
    const tabId = await this.pickCaptureTab(senderTabId);
    if (!tabId) {
      return { state: 'error', level: 0, error: 'no tab to capture; keep a video tab open and audible' };
    }
    // The stream id is only usable by the renderer running the offscreen
    // document, so the document must exist first and every recreation needs a
    // fresh id.
    // The offscreen API is Chrome-only (Firefox has no offscreen documents):
    // report the probe as unsupported instead of throwing a TypeError on
    // ensureOffscreenDocument. The options page renders the error state.
    if (this.api.offscreen === undefined) {
      return {
        state: 'error',
        level: 0,
        error: 'audio probe not supported in this browser (offscreen API absent)',
      };
    }
    await this.ensureOffscreenDocument();
    let streamId: string;
    try {
      streamId = await this.api.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (error) {
      return { state: 'error', level: 0, error: `tabCapture failed: ${errorMessage(error)}` };
    }
    this.capture = { state: 'starting', tabId, level: 0 };
    await this.saveMirror();
    const delivered = await this.forwardToOffscreen({ kind: 'offscreen-start', streamId });
    if (!delivered) {
      this.capture = {
        state: 'error',
        tabId,
        level: 0,
        error: 'offscreen document did not accept the start message',
      };
      await this.saveMirror();
      return this.getState();
    }
    void this.forwardToOffscreen({ kind: 'offscreen-wasm-check' });
    return this.getState();
  }

  private async pickCaptureTab(senderTabId?: number): Promise<number | undefined> {
    // Clicking Test focuses the options tab, which has no audio. Prefer the
    // active tab unless it is the sender's, then the first audible tab.
    let tab = (await this.api.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab?.id === senderTabId) {
      tab = (await this.api.tabs.query({ audible: true, windowType: 'normal' }))[0];
    }
    return tab?.id;
  }

  private async stopCapture(): Promise<ProbeState> {
    await this.stopCaptureInternal();
    return this.getState();
  }

  private async stopCaptureInternal(): Promise<void> {
    if (!this.capture) return;
    this.capture = null;
    await this.saveMirror();
    // Best-effort: if the document is already gone there is nothing to stop.
    await this.forwardToOffscreen({ kind: 'offscreen-stop' });
  }

  private async interrupt(reason: string): Promise<void> {
    if (!this.capture || this.capture.state === 'error') return;
    this.capture.state = 'degraded';
    this.capture.error = reason;
    await this.saveMirror();
    await this.forwardToOffscreen({ kind: 'offscreen-stop' });
  }

  private async handleEvent(message: OffscreenEvent): Promise<void> {
    switch (message.event) {
      case 'started':
        if (this.capture?.state === 'starting') {
          this.capture.state = 'capturing';
          await this.saveMirror();
        }
        break;
      case 'level':
        if (this.capture) this.capture.level = message.level;
        break;
      case 'stopped':
        if (this.capture && (this.capture.state === 'starting' || this.capture.state === 'capturing')) {
          this.capture = null;
          await this.saveMirror();
        }
        break;
      case 'track-ended':
        if (this.capture && this.capture.state !== 'degraded' && this.capture.state !== 'error') {
          this.capture.state = 'degraded';
          this.capture.error = 'tab audio ended';
          await this.saveMirror();
        }
        break;
      case 'error':
        if (this.capture) {
          this.capture.state = 'error';
          this.capture.error = message.error;
          await this.saveMirror();
        }
        break;
      case 'wasm-check':
        this.wasm = message.wasm;
        break;
    }
  }

  private async ensureOffscreenDocument(): Promise<void> {
    // Only reachable after the startCapture guard, but TS cannot see across
    // methods — Firefox (offscreen undefined) never gets here.
    const offscreen = this.api.offscreen;
    if (offscreen === undefined) return;
    const contexts = await this.api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length === 0) {
      await offscreen.createDocument({
        url: this.offscreenUrl,
        reasons: ['USER_MEDIA'],
        justification: 'Phase 0 probe: capture tab audio for the Phase 2 STT de-risk',
      });
    }
  }

  private async forwardToOffscreen(message: OffscreenMessage): Promise<boolean> {
    // The response is the offscreen document's ack. The background's own
    // listener stays silent for these messages, so a rejection or an undefined
    // response means the document's listener is not attached yet.
    for (let attempt = 0; attempt < this.forwardMaxTries; attempt++) {
      try {
        const response = await this.api.runtime.sendMessage(message);
        if (isAck(response)) return true;
      } catch {
        // no receiving end yet
      }
      await sleep(this.forwardRetryMs);
    }
    return false;
  }

  private async saveMirror(): Promise<void> {
    if (!this.capture) {
      await this.api.storage.session.remove(MIRROR_KEY);
      return;
    }
    await this.api.storage.session.set({
      [MIRROR_KEY]: { state: this.capture.state, tabId: this.capture.tabId, error: this.capture.error },
    });
  }

  private getState(): ProbeState {
    return {
      state: this.capture?.state ?? 'idle',
      level: this.capture?.level ?? 0,
      tabId: this.capture?.tabId,
      error: this.capture?.error,
      wasm: this.wasm,
    };
  }
}

export function createCaptureOrchestrator(api: OrchestratorApi, options: OrchestratorOptions) {
  return new CaptureOrchestrator(api, options);
}
