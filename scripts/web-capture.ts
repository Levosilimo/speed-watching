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

/** Prefer the newest non-empty json3 capture, then any non-empty, then the
 * last — a track re-pick lands a fresh request that must win over the
 * default track's payload. */
export function pickCapture(captures: TimedtextCapture[]): TimedtextCapture | null {
  return (
    captures.findLast((c) => c.format === 'json3' && c.body.length > 0) ??
    captures.findLast((c) => c.body.length > 0) ??
    captures[captures.length - 1] ??
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

/** Wait for a capture that landed after `baseline` (a track re-pick). */
export async function waitForFreshTimedtext(
  captures: TimedtextCapture[],
  baseline: number,
  timeoutMs: number,
): Promise<TimedtextCapture | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = captures.slice(baseline);
    const picked = pickCapture(fresh);
    if (picked !== null) return picked;
    await new Promise((r) => setTimeout(r, 250));
  }
  return pickCapture(captures.slice(baseline));
}

/**
 * Open the settings gear → Subtitles/CC panel and pick the ASR-preferred
 * track: auto-generated (or the localized/ASR marker), else the track in
 * `lang` (English by default; the localized/script name for the corpus
 * languages: русск|russian, hindi|हिन्दी, arabic|العربية, indonesian,
 * vietnamese|tiếng việt), else the first non-Off/non-Options item.
 * Returns false when no menu or no pickable track exists.
 */
export async function pickAsrTrackFromMenu(page: Page, lang = 'en'): Promise<boolean> {
  try {
    await page
      .click('button.ytp-settings-button', { timeout: 4000 })
      .catch(() => undefined);
    await page.waitForTimeout(400);
    const ccItem = await page.evaluate((): boolean => {
      const label = (el: Element): string =>
        (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      const item = Array.from(document.querySelectorAll('.ytp-menuitem')).find(
        (el) => /subtitles|captions/i.test(label(el)),
      );
      if (!item) return false;
      (item as HTMLElement).click();
      return true;
    });
    if (!ccItem) return false;
    await page.waitForTimeout(400);
    const picked = await page.evaluate((lang) => {
      const label = (el: Element): string =>
        (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      const items = Array.from(document.querySelectorAll('.ytp-menuitem'));
      const skip = (el: Element): boolean =>
        /^off$/i.test(label(el)) || /^options?$/i.test(label(el));
      const langPick =
        lang === 'ru' ? /русск|russian/i :
        lang === 'hi' ? /hindi|हिन्दी/i :
        lang === 'ar' ? /arabic|العربية/i :
        lang === 'id' ? /indonesian|bahasa indonesia/i :
        lang === 'vi' ? /vietnamese|tiếng việt/i :
        /english/i;
      const pick =
        items.find((el) => /auto[- ]?generated|автомат|\(asr\)/i.test(label(el))) ??
        items.find((el) => langPick.test(label(el))) ??
        items.find((el, _i) => !skip(el));
      if (!pick) return false;
      (pick as HTMLElement).click();
      return true;
    }, lang);
    await page.keyboard.press('Escape').catch(() => undefined);
    return picked;
  } catch {
    return false;
  }
}

/**
 * Turn captions on so the player issues its signed timedtext request.
 */
export async function enableCaptions(page: Page): Promise<void> {
  const pill = page.locator('button.ytp-subtitles-button');
  try {
    await pill.waitFor({ state: 'attached', timeout: 10_000 });
  } catch {
    return;
  }
  const pressed = await pill.getAttribute('aria-pressed').catch(() => null);
  if (pressed !== 'true') {
    await pill.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
  }
}

export async function readPlayerInfo(page: Page): Promise<{
  title: string | null;
  trackCount: number;
  asrCount: number;
  manualCount: number;
  /** Language codes of every asr track, raw as served. */
  asrLangs: string[];
  /** First asr track's languageCode; null when the video has no asr. */
  asrLang: string | null;
  /** playabilityStatus.status from the player response; null when absent. */
  playabilityStatus: string | null;
}> {
  return page.evaluate(() => {
    const pr: PlayerResponse | undefined = window.ytInitialPlayerResponse;
    const tracks =
      pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const asr = tracks.filter((t) => t.kind === 'asr');
    return {
      title: pr?.videoDetails?.title ?? null,
      trackCount: tracks.length,
      asrCount: asr.length,
      manualCount: tracks.filter((t) => t.kind !== 'asr').length,
      asrLangs: asr.map((t) => t.languageCode ?? '?'),
      asrLang: asr[0]?.languageCode ?? null,
      playabilityStatus: pr?.playabilityStatus?.status ?? null,
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
