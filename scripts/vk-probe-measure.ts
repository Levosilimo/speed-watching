// Measurement layer for the Tier 2b platform probe (scripts/vk-probe.ts):
// per-page probes (player state, textTracks, subtitle button, walls) and
// network-layer timed-text classification (SRT/VTT/JSON/m3u8 payloads,
// word-level vs cue-level). Kept separate so the entrypoint stays under
// the repo's 400-line file cap (probe-generic-players/probe-measure split).

import type { BrowserContext, Page } from 'playwright';
import {
  hookNetwork,
  timingVerdict,
  withTimeout,
  WALL_URL_PATTERN,
  type CapturedPayload,
  type NetworkCapture,
} from './vk-probe-network';

export type PlatformName = 'vk' | 'rutube' | 'dzen';
export type ProbeStatus = 'ok' | 'no-captions' | 'login-wall' | 'geo-block' | 'no-video' | 'parse-unknown' | 'error';
export type Timing = 'word' | 'cue' | 'unknown' | 'none';

export interface PlatformSpec {
  name: PlatformName;
  label: string;
  discoverUrls: string[];
  videoPattern: RegExp;
}

export interface PlayerState {
  videoElements: number;
  readyState: number;
  mse: boolean;
  players: string[];
  textTracks: number;
  trackElements: number;
  apiCues: number;
}

export interface VkProbeRecord {
  platform: PlatformName;
  url: string;
  title: string | null;
  status: ProbeStatus;
  reason: string | null;
  timing: Timing;
  player: PlayerState;
  captions: { subtitleButton: boolean };
  network: { subtitleUrls: string[]; hlsSubtitleUris: number; payloads: CapturedPayload[] };
  probeMs: number;
}

export interface Wall {
  class: 'login-wall' | 'geo-block' | null;
  reason: string;
}

export const GOTO_TIMEOUT_MS = 45_000;
const VIDEO_WAIT_MS = 20_000;
const CAPTURE_WINDOW_MS = 10_000;
// Hard per-video cap: goto + wall checks + video wait + play + capture +
// state reads. A stalled page (VK challenge loops, ad iframes) must never
// hold the whole run hostage.
const SAMPLE_DEADLINE_MS = 110_000;

export async function detectWall(page: Page): Promise<Wall> {
  const finalUrl = page.url();
  if (WALL_URL_PATTERN.test(finalUrl)) {
    return { class: 'login-wall', reason: `landed on ${finalUrl.slice(0, 120)}` };
  }
  try {
    const markers = await withTimeout(
      page.evaluate(() => {
        const text = (document.body?.innerText ?? '').slice(0, 3000).toLowerCase();
        const inputNames = [...document.querySelectorAll('input')].map((i) => i.name ?? '');
        const hasLoginForm = inputNames.some((n) => ['email', 'password', 'login'].includes(n));
        const captchaFrame = [...document.querySelectorAll('iframe')].some((f) => (f.src ?? '').includes('hcaptcha'));
        const botCheck = /проверя[ею]м, что вы не робот|вы не робот|verify you are human|not a robot/.test(text);
        const geoBlock = /недоступно в вашем|недоступно в вашей стране|доступно только в россии|not available in your country/.test(text);
        return { hasLoginForm, captchaFrame, botCheck, geoBlock };
      }),
      5000,
      null,
    );
    if (markers === null) return { class: null, reason: '' };
    if (markers.captchaFrame || markers.botCheck) return { class: 'login-wall', reason: 'captcha/bot check' };
    if (markers.hasLoginForm) return { class: 'login-wall', reason: 'login form present' };
    if (markers.geoBlock) return { class: 'geo-block', reason: 'geo-unavailable message' };
  } catch {
    // frame navigated mid-evaluate — treat as no wall
  }
  return { class: null, reason: '' };
}

export async function waitForVideo(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const count = await withTimeout(
          frame.evaluate(() => document.querySelectorAll('video').length),
          2000,
          0,
        );
        if (count > 0) return true;
      } catch {
        // frame navigated away or evaluate timed out
      }
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

async function attemptPlay(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await withTimeout(
      frame.evaluate(() => {
        for (const v of document.querySelectorAll('video')) {
          const p = v.play();
          if (p !== undefined) p.catch(() => undefined);
        }
      }),
      2000,
      undefined,
    ).catch(() => undefined);
  }
  for (const frame of page.frames()) {
    const box = await withTimeout(
      frame.locator('video').first().boundingBox(),
      2000,
      null,
    ).catch(() => null);
    if (box !== null) {
      await withTimeout(page.mouse.click(box.x + box.width / 2, box.y + box.height / 2), 2000, undefined).catch(
        () => undefined,
      );
      break;
    }
  }
}

export async function readPlayerState(page: Page): Promise<PlayerState> {
  const state: PlayerState = {
    videoElements: 0,
    readyState: 0,
    mse: false,
    players: [],
    textTracks: 0,
    trackElements: 0,
    apiCues: 0,
  };
  for (const frame of page.frames()) {
    try {
      const s = await withTimeout(
        frame.evaluate((): PlayerState => {
          const videos = [...document.querySelectorAll('video')];
          const subs = videos.flatMap((v) => [...v.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions'));
          const apiCues = subs.reduce((n, t) => {
            try {
              return n + (t.cues?.length ?? 0);
            } catch {
              return n;
            }
          }, 0);
          const w = window as unknown as Record<string, unknown>;
          const names = ['vk', 'vkPlayer', 'Hls', 'hls', 'player', 'videojs', 'shaka', 'jwplayer', 'Playerjs'];
          const players = names.filter((name) => w[name] !== undefined);
          return {
            videoElements: videos.length,
            readyState: videos.length === 0 ? 0 : Math.max(...videos.map((v) => v.readyState)),
            mse: videos.some((v) => (v.currentSrc ?? '').startsWith('blob:')),
            players,
            textTracks: subs.length,
            trackElements: videos.reduce((n, v) => n + v.querySelectorAll('track').length, 0),
            apiCues,
          };
        }),
        5000,
        null,
      );
      if (s === null) continue;
      state.videoElements += s.videoElements;
      state.readyState = Math.max(state.readyState, s.readyState);
      state.mse = state.mse || s.mse;
      state.players = [...new Set([...state.players, ...s.players])];
      state.textTracks += s.textTracks;
      state.trackElements += s.trackElements;
      state.apiCues += s.apiCues;
    } catch {
      // frame navigated away mid-evaluate
    }
  }
  return state;
}

// Finds the player's subtitle button and clicks it — Дзен and Rutube only
// load their caption track after the toggle. Returns whether a button was
// found (and thus captions were requested).
export async function clickSubtitleButton(page: Page): Promise<boolean> {
  try {
    const clicked = await withTimeout(
      page.evaluate(() => {
        const hints = ['субтитр', 'subtitl', 'caption'];
        const button = [...document.querySelectorAll('button, [role="button"]')].find((el) => {
          const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''} ${el.getAttribute('class') ?? ''}`.toLowerCase();
          return hints.some((h) => label.includes(h));
        });
        if (button !== undefined) {
          (button as HTMLElement).click();
          return true;
        }
        return false;
      }),
      5000,
      false,
    );
    return clicked;
  } catch {
    return false;
  }
}

export function initRecord(platform: PlatformName, url: string): VkProbeRecord {
  return {
    platform,
    url,
    title: null,
    status: 'error',
    reason: null,
    timing: 'none',
    player: { videoElements: 0, readyState: 0, mse: false, players: [], textTracks: 0, trackElements: 0, apiCues: 0 },
    captions: { subtitleButton: false },
    network: { subtitleUrls: [], hlsSubtitleUris: 0, payloads: [] },
    probeMs: 0,
  };
}

export async function sampleVideo(context: BrowserContext, url: string, platform: PlatformName): Promise<VkProbeRecord> {
  const record = initRecord(platform, url);
  const started = Date.now();
  const page = await withTimeout(context.newPage(), 10_000, null);
  if (page === null) {
    record.status = 'error';
    record.reason = 'browser-unresponsive (newPage timeout)';
    record.probeMs = Date.now() - started;
    return record;
  }
  const capture: NetworkCapture = { subtitleUrls: [], payloads: [], hlsSubtitleUris: 0 };
  hookNetwork(page, capture);
  const body = (async () => {
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch (err) {
        record.reason = err instanceof Error && err.message ? err.message : String(err);
        const wall = await detectWall(page);
        if (wall.class !== null) {
          record.status = wall.class;
          record.reason = `${record.reason} (${wall.reason})`;
        }
        record.probeMs = Date.now() - started;
        return;
      }
      record.title = await withTimeout(page.title(), 3000, null);
      const wall = await detectWall(page);
      if (wall.class !== null) {
        record.status = wall.class;
        record.reason = wall.reason;
        record.probeMs = Date.now() - started;
        return;
      }
      const videoMounted = await waitForVideo(page, VIDEO_WAIT_MS);
      if (!videoMounted) {
        record.status = 'no-video';
        record.reason = 'no video element mounted';
        record.probeMs = Date.now() - started;
        return;
      }
      await attemptPlay(page);
      const ccClicked = await clickSubtitleButton(page);
      record.captions.subtitleButton = ccClicked;
      await page.waitForTimeout(CAPTURE_WINDOW_MS);
      record.player = await readPlayerState(page);
      const verdict = timingVerdict(capture, record.player.apiCues, record.player.textTracks);
      record.status = verdict.status;
      record.timing = verdict.timing;
      record.network = {
        subtitleUrls: capture.subtitleUrls,
        hlsSubtitleUris: capture.hlsSubtitleUris,
        payloads: capture.payloads,
      };
  } catch (err) {
    record.status = 'error';
    record.reason = err instanceof Error && err.message ? err.message : String(err);
  } finally {
    await withTimeout(page.close(), 5000, undefined).catch(() => undefined);
  }
})();
  const finished = await withTimeout(body, SAMPLE_DEADLINE_MS, null);
  if (finished === null) {
    record.status = 'error';
    record.reason = 'sample-timeout';
    await withTimeout(page.close(), 5000, undefined).catch(() => undefined);
  }
  record.probeMs = Date.now() - started;
  return record;
}
