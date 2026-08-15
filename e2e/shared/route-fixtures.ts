// Chromium route interception shared by the chromium specs (e2e.spec.ts,
// chaos.spec.ts): youtube.com pages are fulfilled from the fixture server;
// non-document requests (favicon etc.) are dropped. The pattern covers both
// schemes because Chrome's HSTS preload rewrites the http navigation to
// https before the request reaches the network layer. The caption fetch
// (/api/timedtext) is same-origin and served from fixtures too, so no CORS
// or Private Network Access rules apply.
//
// The chaos spec's variant flags (timedtextDelay, android429, androidnoparams,
// androidtrack, webnopanel, transcriptfail) are forwarded to the fixture
// server, which reshapes the ANDROID/WEB/transcript responses accordingly.

import type { BrowserContext } from '@playwright/test';

import { FIXTURE_PORT } from '../server';

export const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;

/** Network-layer counters shared by the chromium specs: the ANDROID
 * innertube fallback POSTs and the get_transcript POSTs seen by the route
 * interceptor. */
export const routeCounters = {
  androidPosts: 0,
  transcriptPosts: 0,
};

export interface RouteFixtureOptions {
  /** While true, the caption-chain routes (timedtext, the innertube player
   * POST, get_transcript) abort with a network error — the offline class's
   * fetch catch→null simulation. The fixture route fulfills from this
   * module's node-side fetch, which the browser's offline emulation cannot
   * reach, so the abort is what actually fails the page's fetches. */
  offline?: () => boolean;
}

export async function routeFixtures(
  target: BrowserContext,
  options: RouteFixtureOptions = {},
): Promise<void> {
  await target.route('**://www.youtube.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (options.offline?.() === true) {
      if (
        url.pathname === '/api/timedtext' ||
        url.pathname === '/youtubei/v1/player' ||
        url.pathname === '/youtubei/v1/get_transcript'
      ) {
        await route.abort('internetdisconnected');
        return;
      }
    }
    // The content script's ANDROID innertube fallback POST: record it and
    // forward to the fixture server — it answers the transcript-gated
    // fixture with the transcript-panel player response and every other
    // fixture with its 400.
    if (url.pathname === '/youtubei/v1/player') {
      routeCounters.androidPosts += 1;
      const response = await fetch(`${fixtureBase}/youtubei/v1/player`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: route.request().postData(),
      });
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      });
      return;
    }
    // The ANDROID-tail transcript fallback POST (lib/transcript.ts): record
    // and forward — the fixture server serves the cue payload only to a
    // POST carrying the transcript params.
    if (url.pathname === '/youtubei/v1/get_transcript') {
      routeCounters.transcriptPosts += 1;
      const response = await fetch(
        `${fixtureBase}/youtubei/v1/get_transcript?${url.searchParams.toString()}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: route.request().postData(),
        },
      );
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      });
      return;
    }
    if (url.pathname === '/api/timedtext') {
      // All query params are forwarded (fixture + pot/potc/c/fmt + delay):
      // the pot-gated fixture's gate keys on the pot proof-of-origin params,
      // so stripping them here would break the signed-request lane; the
      // timedtextDelay variant rides the delay param.
      const response = await fetch(`${fixtureBase}/api/timedtext?${url.searchParams.toString()}`);
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      });
      return;
    }
    if (request.resourceType() !== 'document') {
      await route.abort();
      return;
    }
    const fixture = url.searchParams.get('fixture');
    const multi = url.searchParams.get('multi');
    const live = url.searchParams.get('live');
    const straybadge = url.searchParams.get('straybadge');
    const playersize = url.searchParams.get('playersize');
    const fullscreen = url.searchParams.get('fullscreen');
    const loginrequired = url.searchParams.get('loginrequired');
    const timedtextDelay = url.searchParams.get('timedtextDelay');
    const android429 = url.searchParams.get('android429');
    const androidnoparams = url.searchParams.get('androidnoparams');
    const androidtrack = url.searchParams.get('androidtrack');
    const webnopanel = url.searchParams.get('webnopanel');
    const transcriptfail = url.searchParams.get('transcriptfail');
    const response = await fetch(
      `${fixtureBase}/watch?fixture=${fixture}&multi=${multi ?? ''}&live=${live ?? ''}` +
        `&straybadge=${straybadge ?? ''}&playersize=${playersize ?? ''}&fullscreen=${fullscreen ?? ''}` +
        `&loginrequired=${loginrequired ?? ''}&timedtextDelay=${timedtextDelay ?? ''}` +
        `&android429=${android429 ?? ''}&androidnoparams=${androidnoparams ?? ''}` +
        `&androidtrack=${androidtrack ?? ''}&webnopanel=${webnopanel ?? ''}` +
        `&transcriptfail=${transcriptfail ?? ''}`,
    );
    await route.fulfill({
      status: response.status,
      contentType: 'text/html',
      body: await response.text(),
    });
  });
}
