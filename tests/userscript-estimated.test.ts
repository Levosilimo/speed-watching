// @vitest-environment happy-dom
// Estimated-tier language fallback spec lane (userscript/src/main.ts),
// driven like the extension's content specs: set the watch URL and the
// player response, then re-import the module so main() installs against the
// fixture page. The measure chain is async, so assertions wait for the pill
// to render. Every import adds a fresh pill div and document listeners;
// body is cleared first so the newest instance's pill is the only one
// queried, and a shared yt-navigate-start nulls older instances' `current`
// (stale applies become no-ops).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { priorMidpoint } from '../lib/heuristics';
import { resolveLanguage } from '../lib/languages';
import { recommend } from '../lib/recommend';

const WATCH_URL = 'https://www.youtube.com/watch?v=userscript-spec';

/** Captionless watch page: the measure chain falls to the estimated tier. */
const CAPTIONLESS_RESPONSE = {
  videoDetails: {
    videoId: 'userscript-spec',
    title: 'captionless spec fixture',
    channelId: 'UC-userscript-spec',
  },
  captions: {},
};

/** The pill root's text: the label line, tier line, and the action buttons. */
function pillText(): string | null {
  return document.querySelector<HTMLElement>('.speedwatcher-pill')?.textContent ?? null;
}

beforeEach(async () => {
  document.body.innerHTML = '';
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(WATCH_URL);
  (window as unknown as Record<string, unknown>).ytInitialPlayerResponse = CAPTIONLESS_RESPONSE;
  document.dispatchEvent(new Event('yt-navigate-start'));
  vi.resetModules();
  await import('../userscript/src/main');
  await vi.waitFor(() => {
    expect(pillText()).toContain('→');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('estimated-tier language fallback', () => {
  /** Re-runs the measure chain against the stubbed UI locale and asserts the
   * pill label matches the locale model's own estimate. */
  async function expectEstimateFor(locale: string, langCode: string): Promise<void> {
    vi.stubGlobal('navigator', { language: locale });
    const model = resolveLanguage(langCode);
    if (model === null) throw new Error(`no language model for ${langCode}`);
    const expected = recommend({
      naturalRate: priorMidpoint('generic', model),
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
      language: model,
    });
    expect(expected.mode).toBe('recommend');
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.waitFor(() => {
      expect(pillText()).toContain(expected.label);
    });
  }

  it('uses the ru range for a captionless track on a ru-locale UI', async () => {
    await expectEstimateFor('ru-RU', 'ru');
  });

  it('keeps the estimated math in the resolved language unit (ja morae, not a wpm prior)', async () => {
    await expectEstimateFor('ja-JP', 'ja');
    expect(pillText()).toContain('morae/min');
  });
});
