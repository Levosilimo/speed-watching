# Chrome Web Store Listing — Speed Watcher

## Short description (≤132 chars)

WPM-based speed-watching extension that recommends playback speed from caption speech rate

## Full listing description

Speed Watcher measures the natural speech rate of a video's captions and recommends a playback multiplier that lands your effective listening speed in the 250–275 wpm range — a commonly cited comfortable listening range for speech.

Average conversational speech runs 150–160 wpm. Podcasts and lectures vary widely. Speed Watcher reads the caption timing data YouTube already provides, computes words-per-minute for that specific video, and suggests the exact multiplier to reach your target. One click applies it.

The 250–275 wpm range is a commonly cited target for comfortable speech listening; speeds well above it get harder to follow on unfamiliar material. The default target is 250 wpm; you can adjust it from 100 to 400.

**How it works:**

- Reads word-timed caption data from the video page (no network requests from the extension itself)
- Computes the natural speech rate in wpm
- Recommends a playback multiplier to hit your target wpm
- Shows a floating pill on the video with the recommendation — apply or dismiss with one click

**Tier labels explained:**

- *from captions* — word-timed ASR captions, the most common source (in our measurements, ~94% of sampled videos with speech captions)
- *from captions (corrected)* — manual captions with silence correction, higher confidence, clamped to 1.5× max
- *estimated* — heuristic from content type and video metadata, used when captions are unavailable

**Per-site overrides:** set a default content type per hostname (e.g., lecture for coursera.org, talk for ted.com) so recommendations match the source.

**Habits report:** see how many recommendations you've applied, your average multiplier, and a breakdown by content type — all stored locally.

**Privacy:** Speed Watcher stores everything in `chrome.storage.local` on your device. No analytics, no telemetry, no network requests from the extension. The caption data comes from YouTube's own page context — the extension never makes outbound calls. No data leaves your browser.

## Screenshot caption

Options page showing target WPM set to 250, Podcast content type selected, per-site overrides for ted.com and coursera.org, and a habits report with 47 recommendations applied at an average 1.32× multiplier.

## Category

Productivity

## Permissions

`storage`, `tabCapture`, and `offscreen` cover settings, the override log,
and the user-gesture-gated audio probe. The content scripts match
`<all_urls>` with `all_frames` because embedded players live in cross-origin
iframes — a curated site list would miss them. The extension makes no
outbound requests from its own contexts: caption data is fetched from the
page context (same-origin), never through extension network calls.

## CWS data-safety form answers

| Question | Answer |
|---|---|
| Does this extension collect personal data? | No |
| Does this extension collect web browsing history? | No |
| Does this extension collect content from the browser? | Yes — reads caption/speech-rate data from the active video page; see note below |
| Does this extension collect content from other apps? | No |
| Is the data shared with third parties? | No |
| Is the data used for purposes unrelated to the extension's main purpose? | No |
| Is the data used to track users? | No |
| Does this extension comply with the Families Policy? | Yes |
| Is the data encrypted in transit? | N/A — no data is transmitted |
| Can users request data deletion? | N/A — no data is collected |
| Is there a privacy policy URL? | _User must provide before submission_ |

**Data-safety note:** "content from the browser" is Yes because the
extension reads caption and speech-rate data from the active video page.
That data is used only to compute the playback-speed recommendation,
processed locally, and never transmitted. No personal data is collected.
