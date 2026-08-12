# STT Demand Gate

The demand gate turns the local demand proxy — estimated-tier pill renders
(`lib/demand.ts`, "Estimated usage" on the options page) — into a
yes/no review signal for building the Phase-2 on-device speech-to-text
feature. A trip is a FLAG for review on the options page; nothing starts
automatically, and all data stays in `chrome.storage.local`.

## Thresholds (lib-9, 2026-08-12)

| Const | Value | Meaning |
|---|---|---|
| `SPEECH_ELIGIBLE_TYPES` | talk, lecture, explainer, news, podcast, generic | Estimated renders that indicate transcribable speech |
| `RENDER_THRESHOLD` | 40 | Speech-eligible renders required for the adoption trip |
| `DAYS_THRESHOLD` | 3 | Distinct local dates the 40 renders must be spread across |
| `ELAPSED_CAP_DAYS` | 42 | Days after the first render that trip the review-and-close cap |

Trip condition: `count ≥ 40 AND renderDays ≥ 3` (the adoption trip), **or**
`elapsedDays ≥ 42` (the cap), whichever comes first. The options page shows
the trip state and reason — `renders` for the adoption compound, `elapsed`
for the cap.

## Rationale

- **40** reconciles the oracle's two candidate numbers: 25 is bingeable
  (one heavy week of usage), while 100 would not trip for a niche launch.
- **≥3 distinct render days** is the anti-single-user-overclaim guard:
  one user bingeing 40 captionless videos in a single session counts as one
  render day and cannot trip the gate. The count must be spread across at
  least three days to signal real adoption.
- **6-week cap** bounds the wait: a product that never reaches the render
  signal within 42 days of its first render is likely dead, and the cap
  forces a review-and-close decision instead of an open-ended one.
- **Music excluded** from the speech-eligible count: captionless music has
  no speech to transcribe, so it is noise for this decision. Music stays in
  the raw `byContentType` breakdown for display.

Adoption scenarios (order of magnitude, from lib-9: retention playbook
~50% week-1 churn / 20–30% at month-1; dev.to launch curve): pessimistic
2–4 active users never trips (correct); expected 8–20 active users trips in
week 3–5; optimistic trips in week 1–2.

## What a trip means

Open the options page → STT demand gate section. The evidence package:
speech-eligible count, per-type breakdown (speech-eligible types), first →
last render span, distinct render days, elapsed days, and the trip reason.
The decision — build STT, or close the question — is the user's. Nothing
auto-starts.

## Residual bias

Estimated renders also include caption fetch-failure / null-parse cases
where STT would not help. The per-type breakdown shows the mix; count those
as noise when reviewing.
