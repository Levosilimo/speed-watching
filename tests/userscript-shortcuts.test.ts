// @vitest-environment happy-dom
// Shift+W shortcut spec lane (userscript/src/main.ts), driven like the
// extension's content specs: set the watch URL and the player response, then
// re-import the module so main() installs against the fixture page. The
// measure chain is async, so the beforeEach waits for the pill to render.
// Every import adds a fresh pill div and document listeners; body is cleared
// first so the newest instance's pill is the only one queried, and a shared
// yt-navigate-start nulls older instances' `current` (stale applies become
// no-ops).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { priorMidpoint } from '../lib/heuristics';
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

describe('Shift+W shortcut target guard', () => {
  function withVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    document.body.appendChild(video);
    return video;
  }

  it('ignores Shift+W typed inside input, textarea, and contentEditable targets', () => {
    const video = withVideo();
    const editable: HTMLElement[] = [
      document.createElement('input'),
      document.createElement('textarea'),
      Object.assign(document.createElement('div'), { contentEditable: 'true' }),
    ];
    for (const target of editable) {
      document.body.appendChild(target);
      target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', shiftKey: true, bubbles: true }));
    }
    expect(video.playbackRate).toBe(1);
  });

  it('applies the recommended rate on document-level Shift+W', () => {
    const video = withVideo();
    const expected = recommend({
      naturalRate: priorMidpoint('generic'),
      tier: 'estimated',
      contentType: 'generic',
      platformMax: 2,
    });
    expect(expected.mode).toBe('recommend');
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', shiftKey: true }));
    expect(video.playbackRate).toBe(expected.multiplier);
  });
});
