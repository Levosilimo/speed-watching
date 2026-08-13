# Phase 2 STT feature plan (gate d)

Ships on-device speech-to-text as the `from audio` rate tier for the
estimated slot (videos with no usable caption track). Grounded in the Phase-2
Whisper benchmark (`docs/phase2-whisper-benchmark.md`), the STT battery
(`.slim/worktrees/wt-battery/scripts/data/stt-battery/`), and the lib-1/2/3
design verdicts in the deepwork lane. The battery owns the benchmark doc; this
plan is the build design it gates.

The headline question was the **G5** battery verdict: does the
segment-timed unified rate (whisper's native segment timestamps, `return_timestamps: true`)
pass the gate rule? The two branches below were both drafted; the G5 result
selects which one ships.

> **Verdict (2026-08-13, `7bcff97`): G5 FAIL.** Whisper places the first
> segment at 0.0s while the caption reference spans the lead-in speech, so
> segment-timed rates land ~-50% off on lead-heavy clips. STT does not ship
> as a tier: the **closed branch below is the selected branch** (captions +
> estimated stand; recorder/model-store stay dormant-but-wired). §1/§2/§3
> remain reference for a later revisit.

## Status: G5 is the ship gate

| verdict | outcome |
|---|---|
| **G5 PASS** | Cue-level STT ships as the `from audio (approximate)` tier. ~~This plan's primary path~~ — **closed by the G5 verdict**. |
| **G5 FAIL** — **selected** | STT does not ship as a tier. The recorder plumbing stays dormant-and-wired (as today); captions + estimated stand. Build phase A is skipped; the docs in this plan mark it closed. |

Everything except the final ship/no-ship decision is branch-neutral and
drafted below.

---

## 1. Tier design: `from audio` (approximate)

### 1.1 The tier and label

A new `RateTier` union member `'asr-audio'`, mirroring the recorder doc's
forward reference (`docs/phase2-stt-recorder.md`: "the `'asr-audio'` evidence
tier (one union member + one `TIER_LABELS` entry + one routing branch)").

- `lib/recommend.ts`: add `'asr-audio'` to the `RateTier` union
  (`'asr-word' | 'asr-cue' | 'manual-cue' | 'estimated'`).
- `TIER_LABELS['asr-audio'] = 'from audio (approximate)'` — the honest
  qualifier. The G1 verdict killed word-accurate STT; the segment-timed
  unified rate is close but still measured-bias (2–3/5 within ±10% on the G1
  corpus, `verdicts.md` G1). The pill must not present it as a measurement.
- `recommend()` clamps it like the other ASR tiers: no `MANUAL_CUE_CLAMP`
  (that is manual-only), bounded `[SLOW_DOWN_FLOOR, platformMax]`. The
  `pause-diluted` warning stays off for this tier — the articulatory path
  needs word timing, which G1 ruled not shippable.

Rationale for "approximate" over a bare "from audio": the label sets
expectations on a rate that the battery showed is systematically low-biased
(wordier hyp + continuous timestamps vs caption-boundary pauses; G1 note:
"whisper's word-accurate rate reads low"). An honest qualifier is the 
residual-gap discipline from `docs/demand-gate.md` carried into the shipped UI.

### 1.2 Activation rule — estimated slot only

STT runs only where the content script currently falls to the estimated pill.
The four estimated branches in `entrypoints/content.ts`:

1. `track === undefined` (no caption tracks) — `measureOnce`
2. `json === null` (caption fetch failed) — `measureOnce`
3. captions parsed but empty (`cues.length === 0`) — `measureOnce`
4. `naturalRate === null` (captions present but not rate-able) — `measureOnce`

Each becomes: try STT → if it yields a rate, render the `from audio` tier;
if it fails, fall through to the existing `showEstimatedPill` prior. The
caption tiers (`asr-word` / `asr-cue` / `manual-cue`) are untouched — STT
never overrides a usable caption measurement.

### 1.3 Fallback chain

```
estimated slot
  └─ STT enabled + model present + capture OK
       └─ transcribe → seam-assemble → unified rate (segment ts)
            └─ rate OK  → 'asr-audio' tier
            └─ rate null → showEstimatedPill  (guard: <2 in-order timed segments)
  └─ any STT failure (no model / no capture / DRM silence / offscreen dead / error)
       └─ showEstimatedPill  ← the existing prior, unchanged
```

Failure always lands on the measured prior — the safe direction this project
already uses for caption-less content. STT is additive; a dead STT path must
not suppress the pill (same best-effort discipline as the demand
`demand:increment` send).

### 1.4 Pill UX — listening state → result

Per the researched progressive pattern (listening → resolving → result), the
pill shows a transient state while capture + inference run, then lands on the
`from audio` result or the estimated prior. Concretely:

- Enter estimated slot with STT active: pill shows `listening` (mic glyph,
  no number yet) — this is the capture warm-up + first chunk.
- First rate-ready result: pill transitions to the `from audio (approximate)`
  label with the number.
- STT fails or the user navigates away before the first result: pill shows the
  estimated prior instead — never a stale or blank STT number.

The progressive (not blocking) form matters because first text is 2.4–3.1 s
out (benchmark, WASM table) and the recording is continuous; the pill must
stay responsive and not hold the apply gate open on an unfinished STT value.

---

## 2. Pipeline design

The pipeline runs entirely in the offscreen document (the benchmark's
CSP/64 MiB messaging findings make offscreen the only sane home; the
`transformers.js` model, the ort WASM runtime, and the recorder all live
there).

```
offscreen doc (entrypoints/offscreen/main.ts)
  tab-capture MediaStream (createAudioCapture, already wired)
    → lib/audio-recorder.ts 16 kHz mono ring (60 s cap)     [BUILT]
    → flushChunk(chunkSec) → Float32Array at 16 kHz         [BUILT]
    → whisper pipeline (multilingual base q8, single-thread WASM)
    → seam assembly (dedup + out-of-order drop + guard)
    → unified rate on segment timestamps
    → 'asr-audio' recommendation → background → content script
```

### 2.1 Model / inference config (from the benchmark + battery)

- **Model**: `Xenova/whisper-base` (multilingual), `dtype: 'q8'`, `device: 'wasm'`.
  Multilingual base only — the lib-1 verdict (ship multilingual base ~78 MB,
  language-gated; `.slim/…/verdicts` + benchmark bundle table).
- **Threading**: `numThreads = 1`. MV3 pages are not cross-origin-isolated
  (`SAB: false` benchmark probe), so threaded WASM is unavailable; single
  thread is the shipped constraint (RTF 0.26–0.32).
- **Chunking** (the G2-tested config, `results-v2.jsonl`):
  `chunk_length_s: 29`, `stride_length_s: 5`, `force_full_sequences: false`.
  G2 PASS on both tested configs for seam-local continuity; chunk 29 / stride 5
  is the primary. (The `stride_length_s` default is `chunk/6 ≈ 4.8` in
  transformers.js; 5 is the measured G2 value and stays the shipped constant.
  stride 4 is the tuning window if a seam regression shows up.)
- **Timestamps per the G5 branch**:
  - G5 PASS (primary): `return_timestamps: true` — native segment timestamps
    (cue-level). This is what the segment battery measures.
  - G5 FAIL: nothing ships; this config is unused.
  - `return_timestamps: 'word'` is **not** used for the headline — G1 ruled
    word-level rate not shippable. It may run only as a coverage sanity check
    (post-ship telemetry), never as the rate source.
- **Language hint**: pass the track language as `language:` so whisper does
  not auto-detect per chunk (lib-1: ISO-639-1 hint per run; deterministic
  across the chunk stream). Wired from `normalizeLanguageCode` (see §2.4).

### 2.2 Chunking and the recording cadence

The recorder is pull-based (`flushChunk(seconds)`). The transcription loop
drains 29 s of buffered audio per chunk, feeds whisper, and advances. Because
chunk 29 + stride 5 produces overlapping windows, the seam-assembly step
below must reconcile adjacent chunk outputs before a rate can be computed.

`chunkSec` is already carried through the `stt:start-recording` protocol
(`lib/audio-probe.ts`, echoed in `stt:ready`), so the flow sets it to 29.

### 2.3 Seam assembly

Adjacent 29 s chunks overlap by 5 s, so the same speech is transcribed twice
near each seam. The assembly turns the chunk stream into one clean segment
list:

1. **Upstream dedup** — drop a chunk's leading segments whose text was
   already emitted by the previous chunk (the stride overlap re-transcribes
   them). Key on segment text + start time; the overlap region is exactly the
   stride window.
2. **Out-of-order drop** — drop any segment whose start precedes the last
   committed segment's end (G2 note shows whisper can return words slightly
   out of window; `tsMonotonic` was true on the pass configs, but the guard
   keeps a pathological seam from corrupting the span).
3. **`speechDurationSec` guard** — before computing a rate, require the
   assembled segment list to have ≥2 in-order timed segments (the same
   minimum-two-timed-items contract `wordTierInputs` uses via
   `speechDurationSec` in `lib/wpm.ts`). Fewer than that → return null →
   fallback to estimated. This protects the rate from a span collapsed to a
   single segment or a dropped-everything seam.

### 2.4 Unified-rate computation on segment timestamps

Reuse the existing cue-level path. The battery's "span-trimmed unified rate"
is `filteredTokensOverTrimmedSpan` (`lib/wpm.ts`): tokens of non-bracket
segments over the span from the first to the last segment start, in the
language's unit. The whisper segment list feeds it exactly like a caption cue
list — segments are `{ text, startSec, durSec }`, the same `Segment` shape
`totalWords` / `unitTokens` consume.

- Language unit comes from `resolveLanguage(track.languageCode)` — the same
  model `content.ts` already resolves, so the rate is in the right unit
  (wpm / cpm / syl / mora per `lib/languages.ts`).
- `isBracketMarker` filtering (music) stays; whisper may transcribe
  on-screen markers, and music should not rate as speech.

Language hint wiring: `normalizeLanguageCode` already returns the
lowercase, region-stripped ISO-639-1 code (`'zh-Hans' → 'zh'`,
`'es-419' → 'es'`). transformers.js's `whisper_language_to_code` accepts
ISO-639-1 codes directly (`WHISPER_LANGUAGE_MAPPING` keys), so the
normalized code passes straight through as the `language:` hint. The hint is
set once per run (not per chunk) so the whole recording shares a language.

---

## 3. Model delivery

### 3.1 Opt-in download (lib-2 verdict)

Weights are **data**, not remotely-hosted code — the lib-2 verdict
(`runtime opt-in download store-viable with unlimitedStorage + IndexedDB +
self-hosted; WASM runtime in-package`). The store ships no model; the user
opts in from the options page.

```
options toggle (default OFF)
  → on enable: fetch each model file from self-hosted URL
  → lib/model-store.ts: storeModel(name, version, blob, checksum)
       (temp key → verify sha-256 → commit; mismatch deletes, no partial version)
  → offscreen whisper pipeline loads from the checksum-verified blobs
       (transformers.js local-model loader over the IndexedDB blobs;
        ort's InferenceSession.create consumes the in-package WASM backend)
```

`lib/model-store.ts` is already built and test-backed (atomic checksum
commit, `deleteModel` for reset). The download loop is the new surface: one
`fetch` per model file (`MODEL_FILES` from `scripts/bench-whisper-lib.ts`),
each `storeModel`'d with its sha-256.

### 3.2 In-package WASM runtime

The ort WASM runtime + `transformers.web.min.js` ship in the extension bundle
(the benchmark's "WASM runtime in-package"). Only the **weights** are
downloaded. This is what keeps STT offline-capable once the model is present
and what keeps the store footprint to the runtime + a few KB, not 78 MB.

### 3.3 `unlimitedStorage` manifest addition

Add `unlimitedStorage` to `permissions` in `wxt.config.ts`.

**Justification for the review delta**: the model (~78 MB on disk / ~45 MB
zipped, G4) exceeds `chrome.storage.local`'s hard 10 MB cap and pushes the
extension's IndexedDB past the default quota once added to existing probe
data. `unlimitedStorage` removes the storage-usage quota for the extension's
own IndexedDB (where `lib/model-store.ts` already writes) — it grants no new
web-content access and no new network permission; it only lifts the quota on
data the user explicitly opted in to downloading. This is the minimal
permission change that makes the opt-in download store-viable. The store
review justification (why unlimitedStorage) belongs in the packaging/listing
delta (§5.3).

### 3.4 Self-hosted weights plan

- Host `Xenova/whisper-base` q8 files on GitHub Releases (a release asset per
  file, or one archive) and/or GitHub Pages as a static origin.
- Versioned: the model key is `name@version` (model-store already keys this
  way), and a versioned manifest lists each file's sha-256.
- **Re-download on drift**: `storeModel` verifies the checksum on commit; a
  stored version that no longer matches the manifest (file changed
  upstream) is treated as absent → re-download. `deleteModel` offers the
  user a reset path.
- Serve over HTTPS with a pinned, immutable release tag — a released weights
  snapshot never mutates under the checksum.

### 3.5 Offline state

- Model absent + offline → STT disabled; estimated prior (no download
  attempt, no error surfaced beyond the disabled toggle).
- Model present → STT works fully offline (the benchmark timed runs made zero
  external requests, `blockedExternal = 0`; inference is local).
- Download interrupted → model-store's temp-key commit leaves no partial
  version; the toggle shows download progress/state and retries on the next
  enable.

---

## 4. Multilingual scope

Multilingual base only, **language-gated** per measured count-bias (lib-1).
The FLEURS base/large-class WER evidence (lib-1 verdict) tells us which
languages are credible at base class:

| tier | languages | basis |
|---|---|---|
| `from audio` (gated) | en + candidate set below | FLEURS en 6.3% (base-class mean, credible). Gating is **per-language count-bias measurement** (lib-1 requirement) before a language is enabled — a language ships on this tier only once the segment battery shows its count-bias inside the gate window on that language's corpus. |
| candidate set (measure to enable) | es, pt, fr, de, ru, uk, pl, cs, sr, tr, vi, id, ms, tl, ja, zh | Latin/Cyrillic word-tier and the script languages the model handles; each requires its own count-bias measurement. ja/zh CER ~6.6–6.7 only at **large** class, so base-class is expected worse — measure before enabling. |
| flagged | it | FLEURS it 31.8% at **base** — high; treat as excluded until a base-class measurement contradicts it. |
| stays estimated | ko, hi, ar, th | FLEURS ko/hi/ar 14.9/15.7/14.6 at **large** class (base-class far worse); th not credible at base. No cue-level tier for these at the multilingual base. |

Honest labeling applies everywhere: even a gated language renders
`from audio (approximate)` — the label is not removed for a gated language, it
just means the count-bias gate passed. Non-gated languages in the estimated
slot never see the STT tier; they keep the estimated prior.

Note the language hint is still passed for gated languages (ISO-639-1 per
run, §2.4), but a language not on the gated set does not trigger STT at all —
the estimated slot for `ko`/`hi`/`ar`/`th`/`it` stays on the prior.

---

## 5. Feature surface

### 5.1 Opt-in toggle (default off)

An options-page toggle, default **off** (respects the demand-gate framing:
nothing starts automatically, `docs/demand-gate.md`). Enabling:

- Downloads the model (progress + state + cancel/offline handling, §3).
- On success, enables STT in the estimated slot.
- Disabling deletes the stored model (`deleteModel`) and returns to
  captions + estimated.

The toggle is the single consent point for the one-time download; without it,
no model bytes leave the network and no transcription runs.

### 5.2 Demand-gate residual monitor

The demand gate (`lib/demand.ts`, `docs/demand-gate.md`) already counts
estimated-tier renders. Its residual bias note — "estimated renders also
include caption fetch-failure / null-parse cases where STT would not help" —
is exactly what the STT feature must be measured against. The monitor:

- On `from audio` renders, record the distribution: estimated-slot causes
  (no-track / fetch-null / parse-empty) × whether STT produced a rate or
  fell back. This is the residual-gap monitor: it shows how much of the
  estimated demand STT actually covers versus the fetch-failure noise it
  cannot.
- All data stays in `chrome.storage.local` (no new telemetry channel), same
  discipline as the demand counters.

### 5.3 Listing / privacy deltas

- **One-time download disclosure**: the store listing and the privacy
  policy must state the extension downloads an on-device speech model (~45 MB
  zipped) on opt-in, that transcription runs locally in the extension's
  offscreen document (audio never leaves the device), and that no account /
  network is used for transcription.
- **unlimitedStorage** appears in the permission list → the listing delta
  explains why (model weights stored locally for offline STT; §3.3).
- The tab-capture audio path is unchanged from Phase 0 (already disclosed);
  STT adds no new capture, only a consumer of the existing stream.

---

## 6. Build phases

### Already built (branch-neutral, shipped/merging)

| piece | where | status |
|---|---|---|
| 16 kHz recorder | `lib/audio-recorder.ts` + `lib/recorder-worklet.ts` + `lib/resampler.ts` | merged (docs/phase2-stt-recorder.md) |
| `stt:*` message protocol | `lib/audio-probe.ts`, offscreen `main.ts` | wired, dormant |
| model store | `lib/model-store.ts` (IndexedDB, checksum) | merged, test-backed |
| estimated-slot branches | `entrypoints/content.ts` | shipped |
| demand gate counters | `lib/demand.ts` | shipped |

### Phase A — the offscreen whisper pipeline (G5-dependent)

Lift the benchmark's transcription core (`scripts/bench-whisper-runner.ts`
and `bench-whisper-lib.ts`) out of the Playwright runner and into the
offscreen document:

1. Model load from IndexedDB blobs (replaces the benchmark's
   `env.localModelPath` fixture) — wrap `lib/model-store.ts`.
2. Chunk loop: `flushChunk(29)` → `pipeline(...)` with the §2.1 config →
   seam assembly (§2.3) → `filteredTokensOverTrimmedSpan` (§2.4).
3. `language:` hint wiring from `normalizeLanguageCode`.
4. Recommendation: `'asr-audio'` tier → background → content-script pill.

Effort: small-medium — the inference shape already exists in the benchmark
harness; the new work is IndexedDB loading + seam assembly + the message
round-trip to the content script. Estimate 2–4 focused sessions.

**Verification gate (the ship gate)**: the segment battery (G5). Phase A only
ships the tier when G5 passes. Before that, the pipeline is an internal,
dormant build.

### Phase B — opt-in model delivery

1. Options toggle + download loop over the self-hosted weights (§3.1).
2. `unlimitedStorage` manifest change + listing/privacy delta (§5.3).
3. Offline/interrupt handling.

Effort: small; independent of G5 outcome for the plumbing (the download
mechanism is branch-neutral), but the toggle is only wired to the STT tier in
the G5-PASS branch.

### Phase C — post-ship calibration (both branches)

- **Hand-transcribed-reference calibration**: the battery's residual is
  cross-ASR reference disagreement (G1: whisper vs YouTube-ASR pick different
  function words), which a machine reference cannot resolve. Post-ship, hand
  transcribe a small set of the battery clips and re-score the unified rate
  against a human reference — the only way to bound the true count-bias the
  ASR-vs-ASR reference cannot.
- **Word-timing coverage sanity** (`return_timestamps: 'word'`, report-only):
  confirm segment-level rates aren't silently diverging from word-level
  coverage, without ever using word timing as the rate source.

### Closed branch (G5 FAIL) — selected by the verdict

G5 failed: Phase A does not ship; the recorder stays dormant-and-wired;
captions + estimated remain the shipped behavior. The demand-gate residual
monitor (§5.2) still ships to record whether the estimated demand is worth a
future, different approach (e.g. a better model class) — but no STT tier is
released. This plan's §1/§2/§3 are reference for a later revisit, not a
release.

---

## 7. Risks + mitigations

| risk | evidence | mitigation |
|---|---|---|
| **DRM / protected-tab silence** → whisper transcribes silence or the capture yields no speech | capture is tabCapture; DRM video may deliver no decodable audio | STT detects silence (rms ≈ 0 over the buffered ring) and falls back to estimated; the pill never shows a number on silence. DRM → estimated fallback is the safe default. |
| **Offscreen mid-inference destruction** | w3c#1014 class of issues: an offscreen document can be torn down mid-heavy-task when its reason is mis-declared or the SW that created it is terminated | `USER_MEDIA` reason has **no idle-eviction timeout** (all non-`AUDIO_PLAYBACK` reasons are unbounded), and the offscreen document's lifetime is **independent of the service worker** (Chrome docs). Keep the reason `USER_MEDIA` (already set), do not share the document with a transient reason, and on any offscreen-loss event (`stt:error` / document gone) fall back to estimated. Never hold the apply gate open on a document that may vanish. |
| **Memory: 45 MB JS heap** | benchmark peak JS heap 45.2 MB (a floor for the pipeline's JS footprint, not total) | The model + ort live in the offscreen renderer, isolated from the page; single-document (one offscreen doc per extension) means no stacking. If a regression grows heap, bound chunks (29 s) and cap the recorder ring (already 60 s). Memory is a floor to watch, not a blocker at 45 MB. |
| **CSP change review delta** | `'wasm-unsafe-eval'` is required (`prod` blocks whisper entirely; benchmark CSP findings) | The manifest must add `'wasm-unsafe-eval'` to `script-src` for `extension_pages`. This is the single CSP change and it is the whole thing (no worker-src change needed — verified `prod-workers` isolates the question). Store review must carry the justification: wasm compilation for on-device inference in the offscreen doc. |
| **Update UX** | weights change upstream; versioned checksum (§3.4) | A stored model whose checksum drifts from the released manifest is re-downloaded on next enable; version bump re-fetches. Disclose re-downloads in the listing delta. |
| **STT rate low-bias** | G1: unified rate systematically reads low (whisper wordier + continuous ts vs caption pauses) | Honest `(approximate)` label; clamp within the ASR-tier bounds; the hand-transcribed calibration (§6 Phase C) quantifies the true bias post-ship so a correction factor is a future option rather than a shipped guess. |

---

## Sources

- `.slim/worktrees/wt-battery/scripts/data/stt-battery/verdicts.md` — G1/G2/G3/G4 verdicts (word-level not shippable; seam PASS; invocation PASS; size PASS). Ship gate (G5): **FAIL** — segment timing not shippable (`7bcff97`); the G5-FAIL branch above is selected.
- `.slim/worktrees/wt-battery/scripts/data/stt-battery/results-v1.jsonl`, `results-v2.jsonl` — raw records (G1 unified-rate bias, G2 seam configs).
- `docs/phase2-whisper-benchmark.md` — WASM RTF 0.29, WER 2.8–12.2%, CSP findings, model/assets, chunk/stride, single-thread.
- `docs/phase2-stt-recorder.md` — recorder plumbing contract; names the `'asr-audio'` evidence tier.
- `docs/demand-gate.md` — residual-gap monitor framing; estimated-render residual bias.
- `docs/languages.md`, `lib/languages.ts` — 22-language units/targets; `normalizeLanguageCode`.
- `lib/recommend.ts`, `lib/wpm.ts` — `RateTier`, `TIER_LABELS`, `filteredTokensOverTrimmedSpan`, `speechDurationSec` guard.
- `entrypoints/content.ts` — the four estimated-slot branches (STT activation points).
- `lib/model-store.ts` — IndexedDB checksum-verified store.
- `lib/audio-recorder.ts`, `lib/resampler.ts`, `lib/recorder-worklet.ts`, `entrypoints/offscreen/main.ts` — built recorder plumbing.
- `lib/audio-probe.ts`, `lib/capture-orchestrator.ts` — `stt:*` protocol, `USER_MEDIA` offscreen lifecycle.
- `scripts/bench-whisper-runner.ts`, `scripts/bench-whisper-lib.ts` — the inference core to lift; `MODEL_FILES`, CSP policies.
- `wxt.config.ts` — current manifest permissions (no `unlimitedStorage`, no CSP yet).
- Chrome offscreen docs — `USER_MEDIA` reason has no idle eviction; one document per extension; lifetime independent of the SW.
- lib-1 / lib-2 / lib-3 deepwork verdicts — multilingual-base scope + FLEURS WER; opt-in download; cue-level-with-approximate-label.
