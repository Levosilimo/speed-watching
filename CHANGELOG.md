# Changelog

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
