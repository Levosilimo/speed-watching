# Changelog

## Unreleased

- Fix the Firefox e2e lane: install the Playwright-patched Firefox build in CI and pin geckodriver (0.37.1) so the wrapper cannot drift; pre-warm Firefox before the driver starts
- Fill the privacy-policy contact (GitHub profile) in the policy doc, the live policy page, and the store docs
- Fix the release workflow's notes input (body_file → body_path) so releases carry the CHANGELOG section instead of an empty body
- Fix live detection: a stray live badge anywhere in the page suppressed the pill on a normal VOD; the check now prefers the player response's isLiveContent/isLiveBroadcast flags, then the duration check, then a visible-only badge search inside the active player
- Fix the pill/nudge z-index: the hosts carry a near-max inline z-index so page stylesheets and the player's stacking context cannot bury them under the related-videos column
- Fix the estimated tier's language split: a captionless video in a non-English UI used to compute against the English target while showing the UI language's range; the estimated path now falls back to the UI language's model for both the math and the displayed range
- Fix the userscript's live detection to match the extension: prefer the player response flags, then duration, then a visible-only badge search inside the active player

## 0.0.3 — 2026-08-14

- Add per-video auto-apply with Stop-auto, manual-override detection, and reset-to-1× undo
- Add the time-saved metric: per-video accrual in the pill and a lifetime total in options
- Add the recall nudge overlay after repeated high-speed applies
- Add per-channel rate memory that seeds captionless videos' estimates
- Add UI localization (ru) across the pill, nudge, and options pages
- Add the corpus-validated per-language rate model (ru, uk, pl, cs, ar, id, vi, ms, tl, ja, th, ko)
- Re-derive the ja target/ceiling to 470/495 morae per minute, cap music recommendations in the video's language unit, and apply per-language pause share to the articulatory ceiling
- Port the extension to Firefox (AMO build) with two-browser e2e harnesses
- Port the speed math to an mpv Lua script and the YouTube flow to a userscript, with unit tests and CI gating
- Fix the generic re-assert loop fighting a post-override reset to 1×
- Fix a stale in-flight measure auto-applying the previous video's rate
- Key the safe-zone copy to the track language's derived range instead of the English 250–275
- Fix the pill locale flash, the fractional saved-time line, and the first-run onboarding

## 0.0.2 — 2026-08-12

- Ship the audio capture test; route demand increments through the background
- Add a language-aware rate model: per-language targets and tokenizer modes (mora, vowel-nucleus, words-marks) with ja, tr, hi support
- Fix options-page structure and focus handling for screen readers; pass WCAG 2.2 AA contrast
- Harden the bridge against forged and cross-frame settings:set and log:append
- Cut host_permissions for store submission; add CWS and AMO store assets
- Add privacy policy, CWS submission checklist, and store copy

## 0.0.1 — initial release

- Scaffold the WXT extension with quality gates
- Add the caption WPM pipeline with a phase-0 gate report
- Add a generic player probe and an offscreen audio capture throwaway
- Add a network-layer caption harvest (VTT/HLS/edX parsers)
- Add a recommendation engine and pill UI
- Add a generic matcher and the Firefox port
- Add a local estimated-render demand counter and a whisper benchmark
- Add CI workflows and two-browser e2e harnesses
