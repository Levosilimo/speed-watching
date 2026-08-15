// Local fixture server for E2E: serves the stub YouTube watch page and the
// real caption fixtures. No network calls ever leave the machine.
//
// Two entry modes:
//   - Standalone (Playwright `webServer`): `bun run e2e/server.ts`, listens
//     on FIXTURE_PORT (default 4319), used by the chromium config.
//   - Programmatic (Firefox runner): `createFixtureServer()` picks a free
//     port and returns the server handle.
//
// The stub page must be reachable at a *.youtube.com origin for the content
// script to inject. Chromium gets that via route interception in the spec;
// Firefox gets it via a PAC proxy served here (see proxy.pac below).

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCKED_FIXTURES,
  chapteredInitialData,
  KIND_BY_FIXTURE,
  LANG_BY_FIXTURE,
  NO_TRACK_FIXTURES,
  POT_GATED_FIXTURES,
} from './shared/fixtures';

export const FIXTURE_PORT = 4319;

const fixtureRoot = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
const syntheticRoot = join(fixtureRoot, 'synthetic');
const html = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'watch.html'), 'utf8');
const genericHtml = readFileSync(
  join(fileURLToPath(new URL('.', import.meta.url)), 'generic.html'),
  'utf8',
);
const genericDzenHtml = readFileSync(
  join(fileURLToPath(new URL('.', import.meta.url)), 'generic-dzen.html'),
  'utf8',
);

const FIXTURE_NAME = /^(real|synthetic)\/[a-z0-9-]+\.json$/;
/** Generic-matcher fixtures: safe path charset, resolved under syntheticRoot. */
const FIXTURE_FILE = /^[a-z0-9/.-]+\.(vtt|m3u8|json|srt|webm)$/;

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  vtt: 'text/vtt',
  m3u8: 'application/vnd.apple.mpegurl',
  json: 'application/json',
  srt: 'text/plain',
  webm: 'video/webm',
};

/** The pot-gated watch-page variant (see the __POT_GATED__ slot in
 * watch.html): player-control DOM plus a stub player that answers the CC
 * toggle and the ASR track re-pick with a SIGNED timedtext fetch (pot +
 * potc params) — the only requests the fixture server pays payloads to.
 * Injected into the MAIN world, so the extension's capture wrappers see
 * the fetch. The signed URL is the track's baseUrl (already carrying the
 * fixture param) plus the pot params, mirroring the real player. */
const potGatedStub = `<script>
(() => {
  const video = document.querySelector('video');
  if (video === null) return;
  // The capture-first path only drives the CC controls on a ready player;
  // the stub reports the metadata loaded state.
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  const panel = document.createElement('div');
  panel.innerHTML =
    '<button class="ytp-subtitles-button" aria-pressed="false"></button>' +
    '<button class="ytp-settings-button"></button>' +
    '<div class="ytp-panel-menu"><div class="ytp-menuitem"><div class="ytp-menuitem-label">Subtitles/CC</div></div></div>' +
    '<div class="ytp-panel-menu"><div class="ytp-menuitem"><div class="ytp-menuitem-label">English (auto-generated)</div></div></div>';
  document.body.appendChild(panel);
  const baseUrl = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0]?.baseUrl;
  const signed = () => {
    if (typeof baseUrl !== 'string') return;
    void fetch(baseUrl + '&pot=FIXTURE_POT&potc=1&c=WEB&fmt=json3');
  };
  panel.querySelector('.ytp-subtitles-button')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    signed();
  });
  panel.querySelectorAll('.ytp-menuitem').forEach((item) => {
    item.addEventListener('click', signed);
  });
})();` +
  '</script>';

interface FixtureServer {
  /** Base URL of this server, e.g. http://127.0.0.1:4319 */
  baseUrl: string;
  /** Full stub page URL for a fixture. */
  watchUrl(fixture: string): string;
  /** ANDROID innertube fallback attempts observed at the network layer. */
  androidPosts(): number;
  close(): Promise<void>;
}

export function createFixtureServer(port = FIXTURE_PORT): Promise<FixtureServer> {
  let actualPort = port;
  let androidPosts = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
    const path = url.pathname;
    const fixture = url.searchParams.get('fixture');
    // Variant flags: live=1 marks the player response as a live broadcast
    // (videoDetails.isLiveContent), straybadge=1 injects a .ytp-live-badge
    // OUTSIDE the player (the false-positive regression fixture).

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'POST' && path === '/youtubei/v1/player') {
      // The content script's ANDROID innertube fallback (same-origin POST).
      androidPosts += 1;
      res.statusCode = 400;
      res.end('no player');
      return;
    }

    if (path === '/generic') {
      // Generic-matcher fixture page (non-YouTube origin).
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(genericHtml);
      return;
    }

    if (path === '/generic-dzen') {
      // Track-src probe fixture: a <video><track> mounting a Dzen-shaped
      // word-timed VTT (generic matcher e2e, asr-word tier).
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(genericDzenHtml);
      return;
    }

    if (path.startsWith('/fixtures/')) {
      // Caption fixtures for the generic matcher: HLS manifests, VTT
      // subtitles, transcripts. Resolve under syntheticRoot only.
      const file = path.slice('/fixtures/'.length);
      if (!FIXTURE_FILE.test(file)) {
        res.statusCode = 400;
        res.end('bad fixture path');
        return;
      }
      const full = join(syntheticRoot, file);
      if (!full.startsWith(syntheticRoot)) {
        res.statusCode = 400;
        res.end('bad fixture path');
        return;
      }
      const ext = file.split('.').at(-1) ?? '';
      res.setHeader('Content-Type', CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream');
      res.end(readFileSync(full));
      return;
    }

    if (path === '/proxy.pac') {
      // Firefox-only: proxies *.youtube.com to this server so the content
      // script (matches *://*.youtube.com/*) injects without touching the
      // real YouTube. Everything else goes direct.
      res.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig');
      res.end(
        `function FindProxyForURL(url, host) {\n` +
          `  if (host === 'www.youtube.com') return 'PROXY 127.0.0.1:${actualPort}';\n` +
          `  return 'DIRECT';\n` +
          `}\n`,
      );
      return;
    }

    if (path === '/api/timedtext' && fixture !== null && FIXTURE_NAME.test(fixture)) {
      if (BLOCKED_FIXTURES.includes(fixture)) {
        // Forces the ANDROID innertube fallback in the content script.
        res.statusCode = 403;
        res.end('blocked');
        return;
      }
      if (POT_GATED_FIXTURES.includes(fixture) && !url.searchParams.has('pot') && !url.searchParams.has('potc')) {
        // The logged-in POT failure mode: HTTP 200 with an empty body. A
        // bare captionTracks fetch must NOT get the payload.
        res.statusCode = 200;
        res.end();
        return;
      }
      // Caption payload: served on the youtube.com origin (same-origin for
      // the content script's fetch — avoids CORS and Private Network Access).
      res.setHeader('Content-Type', 'application/json');
      res.end(readFileSync(join(fixtureRoot, fixture)));
      return;
    }

    // Anything else on youtube.com (or a direct localhost visit) is the watch
    // page: stub HTML with a player response whose caption track points at
    // this server's /captions endpoint.
    if (fixture === null || !FIXTURE_NAME.test(fixture)) {
      res.statusCode = 400;
      res.end('bad fixture name');
      return;
    }
    const trackKind = KIND_BY_FIXTURE[fixture];
    const live = url.searchParams.get('live') === '1';
    const playerResponse = {
      videoDetails: {
        videoId: 'e2e-fixture',
        title: `E2E fixture: ${fixture}`,
        // The authoritative live marker the content script prefers over any
        // DOM badge (live=1 variant).
        ...(live ? { isLiveContent: true } : {}),
      },
      // No-track variant: omits captions so the content script falls back to
      // the 'estimated' heuristic tier.
      ...(NO_TRACK_FIXTURES.includes(fixture)
        ? {}
        : {
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    // Same-origin path: the content script resolves it against the
                    // page URL, so the fetch never leaves the youtube.com origin.
                    baseUrl: `/api/timedtext?fixture=${fixture}`,
                    ...(trackKind === undefined ? {} : { kind: trackKind }),
                    languageCode: LANG_BY_FIXTURE[fixture] ?? 'en',
                  },
                ],
              },
            },
          }),
    };
    const page = html
      .replace(
        '__PLAYER_RESPONSE_JSON__',
        JSON.stringify(playerResponse).replaceAll('</', '<\\/'),
      )
      // Chapter markers for the chaptered fixtures; null elsewhere (the
      // content script's chaptersOf reads the absence signal).
      .replace(
        '__INITIAL_DATA_JSON__',
        JSON.stringify(chapteredInitialData(fixture)).replaceAll('</', '<\\/'),
      )
      // multi=1 serves a second <video>: the multi-video e2e asserts that
      // active-element selection follows the video that actually plays.
      .replace('__EXTRA_VIDEO__', url.searchParams.get('multi') === '1' ? '<video id="movie_player_2"></video>' : '')
      .replace(
        '__STRAY_BADGE__',
        url.searchParams.get('straybadge') === '1' ? '<div class="ytp-live-badge"></div>' : '',
      )
      // The pot-gated variant: stub player controls + signed-fetch behavior
      // (see the __POT_GATED__ block in watch.html). Injected for that
      // fixture only — the other pages keep their bare <video>.
      .replace('__POT_GATED__', POT_GATED_FIXTURES.includes(fixture) ? potGatedStub : '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port;
      actualPort = actual;
      const baseUrl = `http://127.0.0.1:${actual}`;
      resolve({
        baseUrl,
        watchUrl: (fixture) => `${baseUrl}/watch?fixture=${fixture}`,
        androidPosts: () => androidPosts,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

if (import.meta.main) {
  const server = await createFixtureServer();
  console.log(`fixture server on ${server.baseUrl}`);
}
