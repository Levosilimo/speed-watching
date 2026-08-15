// @vitest-environment happy-dom
// installCaptionCapture unit spec: the page-level wraps of window.fetch and
// XMLHttpRequest.prototype that capture signed /api/timedtext responses
// (lib/caption-capture.ts). The spec stubs the globals the install wraps and
// drives the real install — the capture callback must fire on a matching
// timedtext response, never on a foreign one, and the natives must keep
// working underneath. The once-guard and the buffer keying (the content
// script's add(videoId, capture) wiring) close the loop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installCaptionCapture,
  TimedtextBuffer,
  type CapturedTimedtext,
} from '../lib/caption-capture';

const TIMEDTEXT_URL = 'https://www.youtube.com/api/timedtext?v=abc&pot=xyz';

/** A fetch Response carrying the request URL (the real network layer
 * populates response.url; a hand-built Response leaves it empty and the
 * wrapper's URL check would throw). */
function responseWithUrl(body: string, status: number, url: string): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}

describe('installCaptionCapture fetch wrap', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let captures: CapturedTimedtext[];

  beforeEach(() => {
    captures = [];
    // The install reads window.fetch at call time and binds the saved native;
    // the mock stands in for the page's real fetch.
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    delete window.__swCaptionCaptureInstalled;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures a 200 timedtext response and returns the original untouched', async () => {
    const body = '{"events":[],"windows":[]}';
    const response = responseWithUrl(body, 200, TIMEDTEXT_URL);
    fetchMock.mockResolvedValue(response);
    installCaptionCapture((capture) => captures.push(capture));

    const result = await window.fetch(TIMEDTEXT_URL);
    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledWith(TIMEDTEXT_URL, undefined);
    expect(captures).toEqual([{ url: TIMEDTEXT_URL, httpStatus: 200, body }]);
  });

  it('ignores non-timedtext URLs and non-200 statuses', async () => {
    const ok = responseWithUrl('{}', 200, 'https://www.youtube.com/api/other');
    fetchMock
      .mockResolvedValueOnce(responseWithUrl('{}', 200, 'https://www.youtube.com/api/other')) // wrong path
      .mockResolvedValueOnce(responseWithUrl('{}', 403, TIMEDTEXT_URL)) // timedtext, gated
      .mockResolvedValueOnce(ok);
    installCaptionCapture((capture) => captures.push(capture));

    await window.fetch('https://www.youtube.com/api/other');
    await window.fetch(TIMEDTEXT_URL);
    const result = await window.fetch('https://video.google.com/timedtext');
    expect(captures).toEqual([]);
    expect(result).toBe(ok);
  });

  it('captures the video.google.com legacy host too', async () => {
    const url = 'https://video.google.com/timedtext?lang=en';
    const response = responseWithUrl('{"events":[]}', 200, url);
    fetchMock.mockResolvedValue(response);
    installCaptionCapture((capture) => captures.push(capture));

    await window.fetch(url);
    expect(captures).toEqual([{ url, httpStatus: 200, body: '{"events":[]}' }]);
  });
});

describe('installCaptionCapture XHR wrap', () => {
  let nativeOpen: ReturnType<typeof vi.fn>;
  let nativeSend: ReturnType<typeof vi.fn>;
  let captures: CapturedTimedtext[];
  /** The load handler the wrapper registered on the last fake xhr. */
  let loadHandler: (() => void) | null;

  function fakeXhr(): {
    open: (method: string, url: string) => void;
    send: () => void;
    status: number;
    responseText: string;
  } {
    loadHandler = null;
    // No own open/send: the patched XMLHttpRequest.prototype (the wrapped
    // natives) must serve them, with this = the fake instance.
    const xhr = Object.create(XMLHttpRequest.prototype) as {
      open: (method: string, url: string) => void;
      send: () => void;
      addEventListener: ReturnType<typeof vi.fn>;
      status: number;
      responseText: string;
    };
    xhr.addEventListener = vi.fn((_type: string, handler: () => void) => {
      loadHandler = handler;
    });
    // status/responseText are getter-only on happy-dom's prototype — own
    // writable properties shadow them for the load handler.
    Object.defineProperty(xhr, 'status', { value: 0, configurable: true, writable: true });
    Object.defineProperty(xhr, 'responseText', { value: '', configurable: true, writable: true });
    return xhr;
  }

  beforeEach(() => {
    captures = [];
    loadHandler = null;
    // The install saves XMLHttpRequest.prototype.open/send and patches the
    // prototype; the stubs stand in for the page's native implementations.
    nativeOpen = vi.fn();
    nativeSend = vi.fn();
    XMLHttpRequest.prototype.open = nativeOpen as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = nativeSend as typeof XMLHttpRequest.prototype.send;
    delete window.__swCaptionCaptureInstalled;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures a 200 timedtext load via the wrapped send', () => {
    installCaptionCapture((capture) => captures.push(capture));
    const xhr = fakeXhr();

    xhr.open('GET', TIMEDTEXT_URL);
    xhr.send();
    // The wrapper reads status/responseText at load time (responseText is
    // cached on the instance by the native send).
    xhr.status = 200;
    xhr.responseText = '{"events":[],"windows":[]}';
    loadHandler?.();

    expect(nativeOpen).toHaveBeenCalledWith('GET', TIMEDTEXT_URL, undefined, undefined, undefined);
    expect(nativeSend).toHaveBeenCalled();
    expect(captures).toEqual([
      { url: TIMEDTEXT_URL, httpStatus: 200, body: '{"events":[],"windows":[]}' },
    ]);
  });

  it('ignores non-timedtext URLs and non-200 loads on the XHR path', () => {
    installCaptionCapture((capture) => captures.push(capture));
    const wrongPath = fakeXhr();
    wrongPath.open('GET', 'https://www.youtube.com/api/other');
    wrongPath.send();
    wrongPath.status = 200;
    wrongPath.responseText = '{}';
    loadHandler?.();

    const gated = fakeXhr();
    gated.open('GET', TIMEDTEXT_URL);
    gated.send();
    gated.status = 403;
    gated.responseText = '{}';
    loadHandler?.();

    expect(captures).toEqual([]);
    expect(nativeSend).toHaveBeenCalledTimes(2);
  });
});

describe('installCaptionCapture guards and wiring', () => {
  let captures: CapturedTimedtext[];

  beforeEach(() => {
    captures = [];
    delete window.__swCaptionCaptureInstalled;
  });

  it('installs only once: a second call does not re-wrap the natives', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(responseWithUrl('{}', 200, TIMEDTEXT_URL));
    vi.stubGlobal('fetch', fetchMock);
    installCaptionCapture((capture) => captures.push(capture));
    // A second install (e.g. an SPA re-run) must be a no-op: the first
    // wrapper still owns window.fetch, so one request still yields one capture.
    installCaptionCapture((capture) => captures.push(capture));

    await window.fetch(TIMEDTEXT_URL);
    expect(captures).toHaveLength(1);
    expect(window.__swCaptionCaptureInstalled).toBe(true);
    vi.unstubAllGlobals();
  });

  it('the content-script wiring keys captures into the buffer by video id', async () => {
    const fetchMock = vi.fn();
    const body =
      '{"events":[{"tStartMs":0,"dDurMs":1000,"segs":[{"utf8":"hello","tOffsetMs":0}]}]}';
    fetchMock.mockResolvedValue(
      responseWithUrl(body, 200, 'https://www.youtube.com/api/timedtext?v=abc123&pot=xyz'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const buffer = new TimedtextBuffer();
    // Mirror of entrypoints/content.ts: the capture callback resolves the
    // video id from the watch URL and buffers under it.
    installCaptionCapture((capture) => {
      const videoId = new URLSearchParams(new URL(capture.url).search).get('v');
      if (videoId !== null) buffer.add(videoId, capture);
    });

    await window.fetch('https://www.youtube.com/api/timedtext?v=abc123&pot=xyz');
    const picked = buffer.pickWordTimed('abc123');
    expect(picked?.body).toBe(body);
    expect(buffer.pickWordTimed('other')).toBeNull();
    vi.unstubAllGlobals();
  });
});
