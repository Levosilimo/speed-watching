# Changelog

## 0.0.3 — 2026-08-14

- Add per-video auto-apply with Stop-auto, manual-override detection, and reset-to-1× undo
- Add the time-saved metric: per-video accrual in the pill and a lifetime total in options
- Add the recall nudge overlay after repeated high-speed applies
- Add per-channel rate memory that seeds captionless videos' estimates
- Add UI localization (ru) across the pill, nudge, and options pages
- Add the corpus-validated per-language rate model (ru, uk, pl, cs, ar, id, vi, ms, tl, ja, th, ko)
- Port the extension to Firefox (AMO build) with two-browser e2e harnesses
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
