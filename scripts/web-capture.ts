// Browser mechanics for the POT-aware caption re-run: intercepting the
// player's own signed /api/timedtext request (the only WEB path carrying a
// valid POT + signature bound to the video) by toggling captions on and
// watching page responses. No fresh baseUrl fetches happen here.

import type { Page } from 'playwright';
import type { PlayerResponse } from '../lib/youtube';

export interface TimedtextCapture {
  url: string;
  httpStatus: number;
  body: string;
  bytes: number;
  format: 'json3' | 'vtt' | 'other';
}

export function captureFormat(url: string): TimedtextCapture['format'] {
  if (url.includes('json3')) return 'json3';
  if (url.includes('.vtt') || url.includes('fmt=vtt')) return 'vtt';
  return 'other';
}

export function hookTimedtext(page: Page, captures: TimedtextCapture[]): void {
  page.on('response', (res) => {
    if (!res.url().includes('/api/timedtext')) return;
    void (async () => {
      let body = '';
      try {
        body = await res.text();
      } catch {
        body = '';
      }
      captures.push({
        url: res.url(),
        httpStatus: res.status(),
        body,
        bytes: Buffer.byteLength(body),
        format: captureFormat(res.url()),
      });
    })();
  });
}

/** Prefer a non-empty json3 capture, then any non-empty, then the first. */
export function pickCapture(captures: TimedtextCapture[]): TimedtextCapture | null {
  return (
    captures.find((c) => c.format === 'json3' && c.body.length > 0) ??
    captures.find((c) => c.body.length > 0) ??
    captures[0] ??
    null
  );
}

export async function waitForTimedtext(
  captures: TimedtextCapture[],
  timeoutMs: number,
): Promise<TimedtextCapture | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const picked = pickCapture(captures);
    if (picked !== null) return picked;
    await new Promise((r) => setTimeout(r, 250));
  }
  return pickCapture(captures);
}

async function pickTrackFromMenu(page: Page): Promise<boolean> {
  await page.waitForTimeout(300);
  try {
    return await page.evaluate((): boolean => {
      const items = Array.from(document.querySelectorAll('.ytp-menuitem'));
      const label = (el: Element): string =>
        (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      const offIndex = items.findIndex((el) => /^off$/i.test(label(el)));
      const pick =
        items.find((el) => /english/i.test(label(el))) ??
        items.find((el, i) => i !== offIndex);
      if (!pick) return false;
      (pick as HTMLElement).click();
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Turn captions on so the player issues its signed timedtext request. When
 * CC is already on (context persistence), reopen the menu and re-pick the
 * track to force a fresh request.
 */
export async function enableCaptions(page: Page): Promise<void> {
  const pill = page.locator('button.ytp-subtitles-button');
  try {
    await pill.waitFor({ state: 'attached', timeout: 10_000 });
  } catch {
    return;
  }
  const pressed = await pill.getAttribute('aria-pressed').catch(() => null);
  if (pressed === 'true') {
    await pill.click({ timeout: 3000 }).catch(() => undefined);
    await pickTrackFromMenu(page);
  } else {
    await pill.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
  }
}

export async function readPlayerInfo(page: Page): Promise<{
  title: string | null;
  trackCount: number;
  asrCount: number;
  manualCount: number;
}> {
  return page.evaluate(() => {
    const pr: PlayerResponse | undefined = window.ytInitialPlayerResponse;
    const tracks =
      pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    return {
      title: pr?.videoDetails?.title ?? null,
      trackCount: tracks.length,
      asrCount: tracks.filter((t) => t.kind === 'asr').length,
      manualCount: tracks.filter((t) => t.kind !== 'asr').length,
    };
  });
}

export async function dismissConsentIfPresent(page: Page): Promise<void> {
  try {
    await page.waitForSelector('ytd-consent-bump-v2-lightbox', { timeout: 3000 });
    await page
      .locator('ytd-consent-bump-v2-lightbox button')
      .filter({ hasText: 'Accept all' })
      .click({ timeout: 5000 });
    await page.waitForSelector('ytd-consent-bump-v2-lightbox', {
      state: 'detached',
      timeout: 5000,
    });
  } catch {
    // dialog absent or already dismissed
  }
}

export async function pageErrorHint(page: Page): Promise<string | null> {
  try {
    const bodyText = await page.evaluate(
      () => document.body?.innerText?.slice(0, 400) ?? '',
    );
    if (/not a bot|sign in to confirm/i.test(bodyText)) return 'bot-wall';
    if (page.url().includes('consent')) return 'consent-page';
  } catch {
    return null;
  }
  return null;
}
