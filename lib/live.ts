/**
 * The live-badge scoping predicate: a .ytp-live-badge counts as live only
 * when it sits inside the video's .html5-video-player and is visible
 * (offsetParent non-null). Stray page-level badges — related-video previews
 * — must not suppress the pill on a normal VOD.
 */
export function hasVisiblePlayerBadge(video: HTMLVideoElement | null): boolean {
  const badge = video?.closest('.html5-video-player')?.querySelector<HTMLElement>('.ytp-live-badge');
  return badge != null && badge.offsetParent !== null;
}
