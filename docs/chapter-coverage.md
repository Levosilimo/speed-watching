# Chapter-coverage probe — per-chapter-rate gate

**Verdict: GO.** ≥10-min videos expose chapter markers in page context
12/14 (86%), above the 70% gate. Read the markers from
`ytInitialData` — the spec path's root moved there from
`ytInitialPlayerResponse`, and the engagement-panel chapter list is the
wider of the two exposure surfaces.

Data: `scripts/data/chapter-coverage/results.jsonl` (24 records, one per
corpus video). Harness: `scripts/chapter-coverage-probe.ts` +
`scripts/chapter-coverage-lib.ts`, run 2026-08-14 from residential
egress, headless chromium, fresh browser per video.

## Method

Each of the 24 web-rerun corpus watch URLs (talks, lectures, explainers,
music, news-comedy, podcast — the feature's actual target registers) is
loaded, the page's two data roots are polled (250 ms cadence, 10 s
deadline, same contract as `lib/measure-hooks.ts`), and the chapter
shape is extracted with per-step drift reporting so a renamed or moved
field lands in the records as evidence instead of a silent miss.

Two exposure paths are walked:

1. **Spec path (markersMap)** —
   `<root>.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer
   .decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer
   .markersMap[].value.chapters[].chapterRenderer`
   with `title.simpleText` + `timeRangeStartMillis`.
2. **Engagement-panel path** —
   `ytInitialData.engagementPanels[].engagementPanelSectionListRenderer
   .content.macroMarkersListRenderer.contents[]
   .macroMarkersListItemRenderer` with `title.simpleText` + start time in
   the `onTap` watch URL (`t=<seconds>s`).

Classification: chapters-present / no-markers / no-player-response /
geo-block / error. Coverage = chapters-present ÷ reachable (reachable =
23; one video is `LOGIN_REQUIRED`-blocked).

## Results

| bucket | n | chapters | coverage |
|---|---|---|---|
| <5m | 6 | 0 | 0% |
| 5-10m | 3 | 1 | 33% |
| 10-30m | 11 | 10 | 91% |
| 30-60m | 1 | 1 | 100% |
| ≥60m | 3 | 1 | 50% |
| **≥10m** | **14** | **12** | **86%** |

Overall: 13/23 = 57%. The <5m bucket is empty by design — auto-chapters
need roughly 8 min of video.

The two ≥10-min videos without chapters: `8mAITcNt710` (25-hour
livestream VOD — carries a livestream player bar, not the marker bar)
and `7Pq-S557XQU` (15-min explainer that genuinely has no chapters).

## Shape verdict

The spec shape is intact, but its **root moved**: the player endpoint
response (`ytInitialPlayerResponse`) stopped shipping `playerOverlays`
entirely on all 24 pages. The identical nested path resolves end to end
under `ytInitialData` (the `next` endpoint response) — 8/24 videos. The
feature must read `ytInitialData`, not `ytInitialPlayerResponse`.

The **engagement-panel list** (`macroMarkersListRenderer`) is the wider
surface: it carries chapters for all 8 markersMap videos (matching
counts — same chapter data) plus 5 more that never populate the player
bar markers, and it is present in the initial page data (no extra
request). Start times parse from the item's `onTap` watch URL
(`&t=<seconds>s`), normalized to ms in the records.

## Recommendation

Build per-chapter rates reading `ytInitialData`: markersMap path first
(when populated), engagement-panel list as the fallback. Both shapes
deliver title + start time from page context with no network call, and
their chapter counts agree where both exist. Register split (talk 4/4,
lecture 2/3, explainer 5/6, news-comedy 1/1 on ≥10-min videos) shows no
register the feature targets is starved.
