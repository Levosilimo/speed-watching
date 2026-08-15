// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { hasVisiblePlayerBadge } from '../lib/live';

// happy-dom has no layout engine, so offsetParent is stubbed per badge to
// drive the visibility half of the predicate (real browsers null it for
// display:none and detached elements).
function withOffsetParent(badge: HTMLElement, value: Element | null): void {
  Object.defineProperty(badge, 'offsetParent', { value, configurable: true });
}

function playerWithVideo(): { video: HTMLVideoElement; badge: HTMLElement } {
  const player = document.createElement('div');
  player.className = 'html5-video-player';
  const video = document.createElement('video');
  player.appendChild(video);
  const badge = document.createElement('div');
  badge.className = 'ytp-live-badge';
  player.appendChild(badge);
  document.body.appendChild(player);
  return { video, badge };
}

describe('hasVisiblePlayerBadge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('true only for a visible badge inside the video\'s player', () => {
    const { video, badge } = playerWithVideo();
    withOffsetParent(badge, document.body);
    expect(hasVisiblePlayerBadge(video)).toBe(true);
  });

  it('false when the badge inside the player is hidden (offsetParent null)', () => {
    const { video, badge } = playerWithVideo();
    withOffsetParent(badge, null);
    expect(hasVisiblePlayerBadge(video)).toBe(false);
  });

  it('false when the badge sits outside the player (related-video preview)', () => {
    const { video } = playerWithVideo();
    video.closest('.html5-video-player')!.querySelector('.ytp-live-badge')!.remove();
    const stray = document.createElement('div');
    stray.className = 'ytp-live-badge';
    // The stray badge is visible — only its position outside the player
    // disqualifies it.
    withOffsetParent(stray, document.body);
    document.body.appendChild(stray);
    expect(hasVisiblePlayerBadge(video)).toBe(false);
  });

  it('false without a video', () => {
    expect(hasVisiblePlayerBadge(null)).toBe(false);
  });
});
