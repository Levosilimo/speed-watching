# Tier 2b probe — VK Video / Rutube / Дзен caption reality

Measured 2026-08-13 on the dev box (WSL2 over a residential Windows 11
line — the same framing as `docs/gate1-residential-run.md`). Data:
`scripts/data/vk-probe/results.jsonl`. Probe: `scripts/vk-probe.ts`
(+ measurement layer `scripts/vk-probe-measure.ts`), Playwright CfT
chromium, ru-RU locale, no login, no bypass. Sample: the first N video
links from each platform's own trending page (VK: `vkvideo.ru` homepage,
Rutube: `/feeds/top/`, Дзен: `dzen.ru/video`), so the sample is the
platform's current popular public content.

Per video the probe records: player presence, textTracks/track-element
exposure, the subtitle button, network-layer timed-text (HLS
EXT-X-MEDIA, SRT/VTT/JSON payloads), timing granularity (word vs cue),
and the failure class when the page does not deliver: `no-captions` /
`login-wall` / `geo-block` / `no-video` / `parse-unknown`.

## Results

| platform | status | timing | evidence |
|---|---|---|---|
| VK Video | `login-wall` ×6 (anti-bot challenge on every video page) | unknown | every video URL lands on `vkvideo.ru/challenge.html` («Проверяем, что вы не робот»); in headless debugging the player additionally fails to mount (stream API `r3-test.vkvideo.ru` / `mincifry-cert.vkvideo.ru` CORS-blocked) |
| Rutube | `ok` ×2 (SRT), `no-captions` ×3, `error` ×1 (goto timeout) | cue (SRT) | `pic.rtbcdn.ru/subtitle/<…>.srt` captured on caption-bearing videos; HLS master has **no** `EXT-X-MEDIA TYPE=SUBTITLES`; 3/6 trending videos have no captions at all (author gate not passed) |
| Дзен | `ok` ×6 (5 word, 1 unknown) | word-in-cue | VTT from `vd*.okcdn.ru` `type=2` URL with per-word tags `<00:00:19.225><c>самого</c>`; textTracks exposes a subtitles track and delivers cues after the CC toggle |

Failure classes encountered: `login-wall` (VK anti-bot challenge, all 6 sampled videos), `no-captions` (Rutube videos whose authors have not enabled subtitles), `error` (one Rutube page that stalled past the 45 s goto timeout). No `geo-block`, no `parse-unknown`.

Run-to-run variance: VK's challenge is intermittent — some runs serve the trend page and some gate it; video pages were gated in every run where discovery succeeded. Дзен's trend page occasionally renders no watch links (discovery retried).

## VK Video — unmeasurable from this box

The trend page works, but every sampled video page fails to mount a
player. Two distinct mechanisms, both honest failures:

- **Headless sessions**: the page renders metadata (title, views,
  description) but the player's stream-API calls to
  `r3-test.vkvideo.ru/` and `mincifry-cert.vkvideo.ru/` are CORS-blocked
  (no `Access-Control-Allow-Origin` on the response) and the player never
  mounts. This is a session-degradation pattern, not a code path we can
  reach.
- **Headed sessions**: `vk.com/video-…` and `vkvideo.ru/video-…` land on
  `vkvideo.ru/challenge.html` — VK's anti-bot gate («Проверяем, что вы не
  робот»). Clicking «Продолжить» re-issues the challenge with a fresh id;
  the video page never loads its player.

### The word-timestamp claim vs the FAQ

lib-9's source (VK blog, Feb 2025) claims ~90% of VK Video content has
auto-subtitles **with word timestamps**. lib-8's source (VK FAQ) describes
manual SRT upload at cue granularity. These describe different features —
author-uploaded SRT (cue) and the platform's own ASR (word) — so they can
both be true. **This probe cannot settle which one a real session gets**:
guest sessions from this IP are gated behind the anti-bot challenge and
the degraded no-player variant, so there is no caption payload to
inspect. The claim stays *unverified from this box*, not refuted. A
follow-up from a clean residential session (or VK's own player embed,
which may behave differently) is required before VK can be tiered.

## Rutube — cue-level SRT, harvestable

Two of the six sampled videos delivered captions; the other three (TV-channel uploads from TNT) had none — the author-gated autosub threshold (200 views / 40 subscribers / 10 h per lib-8) had not been passed for them. On caption-bearing videos:

- **Layer (b)**: `textTracks` exposes a `captions` track (mode hidden)
  and a `<track>` element.
- **Layer (c)**: the track src is a plain SRT URL,
  `https://pic.rtbcdn.ru/subtitle/<date>/<hash>.srt`, fetched directly —
  no auth token, no wall. The HLS masters
  (`bl.rutube.ru/route/<id>.m3u8` → `cdn-gcore-1.rtbcdn.ru/…mp4.m3u8`)
  carry **no** `EXT-X-MEDIA TYPE=SUBTITLES`; captions ride the separate
  SRT fetch, matching lib-8's description (SRT, cue-level).

### Adapter sketch

A new harvest probe (probe #5 in `lib/captions-harvest.ts`, after
`probeVttEntries`): read `video > track[src]` attributes on the page,
fetch the URL, parse as SRT/VTT with the existing `parseVtt`/`cleanVttText`
pipeline (SRT parses fine as VTT — both use `-->` cues). No platform
detection needed; the probe is generic. The `textTracks` API itself is
already usable by the content script for the rate-side seam.

**Tier: asr-cue.** Cue-level only; no word timing exists in the payload.

## Дзен — word timestamps inside cues, harvestable

All six sampled watch pages (`dzen.ru/video/watch/<26-hex>`) mounted the
player (MSE, readyState 4) and exposed a subtitle button that, once
clicked, loads the caption track — five delivered the caption payload
within the capture window:

- **Layer (b)**: `textTracks` exposes a `subtitles` track (lang ru,
  mode hidden→showing after toggle) with 710 accessible cues; one
  `<track>` element per video.
- **Layer (c)**: the track src is a signed OK.ru CDN URL
  (`https://vd*.okcdn.ru/?…&type=2&subId=…`) whose response is **WebVTT**
  (`WEBVTT Language: ru`). The stream metadata (`type=1`, `asubs=y`)
  declares autosubs. Дзен videos ride the OK.ru video infrastructure —
  that is where the captions come from in the network layer.
- **Layer (d)**: **word timestamps embedded in the cue text** —
  `С<00:00:19.225><c>самого</c><00:00:19.786><c>начала</c>…`. Cue-level
  via the standard API, word-level if the VTT tags are parsed.
- **Layer (e)**: the page routes through the Yandex SSO autologin dance
  (`sso.passport.yandex.ru/push` → `sso.dzen.ru/install`) and lands back
  on content; no wall in practice.

### Adapter sketch

Same probe as Rutube — `video > track[src]` → fetch → `parseVtt` gives
cue-level segments today (cleanVttText strips the `<00:…><c>` tags).
Word-level would need a VTT-tag-aware parser that expands each cue's
inline word timestamps into per-word segments — a small addition to the
harvest (parse `<\d\d:\d\d:\d\d.\d\d\d><c>word</c>` runs), no new
platform code.

**Tier: asr-word** (with the tag-aware parser; **asr-cue** with the
current `parseVtt`).

## Verdict

| platform | captions? | granularity | reachable by existing harvest? | tier | adapter effort |
|---|---|---|---|---|---|
| VK Video | unknown (walled from this IP) | unknown | unverified | **nothing** until a clean-session re-probe | n/a — blocked on access |
| Rutube | yes (author-gated autosubs, public when enabled) | cue (SRT) | yes, via new track-src probe (existing `.vtt`-URL probe misses the extensionless SRT host) | **asr-cue** | small: probe #5 (track src → parseVtt), ~30 lines |
| Дзен | yes (in-player autosubs) | word-in-cue (VTT tags) | yes, via the same track-src probe | **asr-word** | small: probe #5 + VTT word-tag expansion, ~60 lines |

Both reachable platforms can become measured-tier surfaces with one
generic adapter: a `track[src]` harvest probe. VK stays out until the
anti-bot gate is cleared from a session the platform trusts. The
measurement gap the probe could not close: VK's word-timestamp claim.
