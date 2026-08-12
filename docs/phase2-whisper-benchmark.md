# Phase 2 Whisper benchmark (gate b)

Answers plan-v2 open question 2 — "Whisper WebGPU realtime on mid hardware → Phase-2
gate benchmark" — for the lib-10 STT choice (transformers.js Whisper,
`return_timestamps: 'word'`) under the extension's CSP constraint.

Raw data: `scripts/data/whisper-bench/results.jsonl` (48 records, 12 variants) and
`telemetry.jsonl` (84 phase beacons). Run tooling: `scripts/bench-whisper*.ts`;
WER/timestamp helpers under test in `tests/bench-whisper-wer.test.ts`.

## Verdict

- **WASM backend: gate passes.** Realtime on this box: mean RTF 0.29
  (0.26–0.32) single-threaded, first text at 2.4–3.1 s, model load 1.9 s,
  WER 2.8–12.2 % with sane word timestamps. The STT choice is feasible on the
  WASM path.
- **CSP is the blocking finding, not speed.** Under the production extension
  policy (`script-src 'self'`), Whisper does not load at all — `WebAssembly`
  compilation is rejected. The `'wasm-unsafe-eval'` relaxation is required;
  see [CSP findings](#csp-findings).
- **WebGPU on mid hardware: unverified, not failed.** No hardware adapter was
  exposed during any WebGPU run (GTX 1070 saturated by another workload;
  headless Chromium fell back to SwiftShader). The software adapter loaded the
  model but produced no transcriptions. The plan-v2 question stays open for a
  box with an idle real adapter.

## Environment

Measured on the shared box, 2026-08-12, headless Chromium via Playwright:

- GPU: GTX 1070 at ~100 % utilization (another workload) for the whole run.
  WebGPU results are therefore **contended/invalid as hardware numbers**;
  WASM inference is CPU-bound and unaffected.
- RAM: 25 GB total. JS heap limit observed 3.6 GB; peak JS heap 45 MB.
- Browser: Playwright Chromium (headless), no `--use-gl` tricks; WebGPU runs
  used `--enable-unsafe-webgpu`, SwiftShader runs `--use-webgpu-adapter=swiftshader`.

## Method

- **Clips**: 3 LibriSpeech test-clean utterances, speaker 260, 13.4–21.2 s
  each (49.2 s total, CC BY 4.0; references in `bench-whisper-lib.ts`).
  Downloaded once at dev time from the HF datasets-server rows API, decoded
  with ffmpeg to 16 kHz mono f32. All under Whisper's 30 s chunk window, so
  no chunking artifacts.
- **Model**: `Xenova/whisper-base` q8 (int8 quantized), served from the local
  fixture origin. `env.allowRemoteModels = false` plus Playwright route
  blocking of every non-fixture request; `blockedExternal = 0` on all probes
  — timed runs made zero external requests.
- **Process isolation**: one (backend × csp × gpu) variant per child process,
  one browser, one page. The orchestrator SIGKILLs the process group past the
  hard cap (20 min WASM, 5 min WebGPU) and appends a synthetic probe. No
  variant hit the cap; none reused browser state.
- **Threading**: `numThreads = 1` throughout — MV3 extension pages are not
  cross-origin-isolated (probes confirm `SharedArrayBuffer: false`,
  `crossOriginIsolated: false`), so threaded WASM is not available in the
  target runtime. The numbers reflect the shipped constraint.
- **Pipeline**: `pipeline('automatic-speech-recognition', …, { device: backend, dtype: 'q8' })`,
  `return_timestamps: 'word'`, streamer callbacks for first-token/first-text
  latency.
- **CSP policies under test** (from `bench-whisper-lib.ts`):
  - `prod` — `script-src 'self'; object-src 'self'` (Chrome default for
    extension pages declaring no policy)
  - `relaxed` — adds `'wasm-unsafe-eval'`
  - `prod-workers` — `worker-src 'self' blob:` added to `prod`; isolates the
    worker-src question from the wasm question
- **WER**: word-level Levenshtein over lowercased, punctuation-stripped tokens
  against the LibriSpeech reference — the same functions asserted in
  `tests/bench-whisper-wer.test.ts`, applied to live output by the harness.
- **Timestamp sanity**: word starts non-decreasing (0.05 s epsilon) and last
  word end within clip duration + 0.5 s — `timestampSanity()` from the lib.

## Results

### WASM

| variant | model load | first token | first text | RTF | WER | heap peak |
|---|---|---|---|---|---|---|
| `relaxed` · clip 0015 (21.2 s) | 1900 ms | 3024 ms | 3051 ms | 0.262 | 0.038 | 45.2 MB |
| `relaxed` · clip 0024 (14.6 s) | 1900 ms | 2403 ms | 2429 ms | 0.290 | 0.122 | 45.2 MB |
| `relaxed` · clip 0025 (13.4 s) | 1900 ms | 2384 ms | 2420 ms | 0.321 | 0.028 | 45.2 MB |
| `relaxed` · mean | 1900 ms | 2604 ms | 2633 ms | 0.291 | 0.063 | 45.2 MB |

Word timestamps: 36–52 words per clip, first start 0.36–0.66 s, last end
13.5–21.0 s (within duration + 0.5 s), monotonic on all three clips.

`heapPeakMB` is the V8 JS heap (`performance.memory`), not the ort WASM
linear memory; treat it as a floor for the pipeline's JS footprint, not total
memory.

### WebGPU attempt

| variant | model load | clips transcribed | notes |
|---|---|---|---|
| `relaxed` × 3 gpu attempts | 1740 / 1922 / 2196 ms | 0 of 9 | all clips failed with opaque numeric errors |
| `prod` × 3 gpu attempts | — | 0 of 9 | CSP violation, model never loaded |
| `prod-workers` × 3 gpu attempts | — | 0 of 9 | CSP violation, model never loaded |

The GPU probe reported `adapter:google|swiftshader` on all nine WebGPU runs —
**including the `hardware` attempt**, which silently fell back to the software
adapter. No hardware adapter was ever exposed, so nothing here measures
WebGPU on the GTX 1070.

On the software adapter the model loads, then every transcription fails with
an uninterpreted numeric error: `157381320` for the `none`/`swiftshader`
attempts, `53087264` for `hardware`. These are ort WebGPU kernel errors with
no message text in the record; without a real adapter they are not resolvable
here. Honest status: **WebGPU produced zero transcriptions in this
environment, for reasons that may be adapter-specific**.

## CSP findings

The headline. Under `prod` (`script-src 'self'`) Whisper cannot start:
`WebAssembly` compilation is blocked, so ort never initializes and the model
never loads. Probe record, verbatim:

> CompileError: WebAssembly.compile(): Compiling or instantiating WebAssembly
> module violates the following Content Security policy directive because
> 'unsafe-eval' is not an allowed source of script in the following Content
> Security Policy directive: "script-src 'self'".

Model-load failure, verbatim:

> no available backend found. ERR: [wasm] RuntimeError: Aborted(CompileError:
> WebAssembly.instantiate(): Compiling or instantiating WebAssembly module
> violates the following Content Security policy directive because
> 'unsafe-eval' is not an allowed source of script in the following Content
> Security Policy directive: "script-src 'self'".). Build with -sASSERTIONS
> for more info.

Same violation through the streaming path
(`WebAssembly.instantiateStreaming() … falling back to ArrayBuffer
instantiation` — the fallback is also rejected).

Findings:

1. **`prod` blocks Whisper entirely.** `wasmCompile` probe fails; model load
   fails; no transcription is possible. The unmodified WXT default CSP cannot
   ship STT.
2. **`relaxed` (`'wasm-unsafe-eval'`) fixes it completely.** Probe `ok`, model
   loads, all three clips transcribe. This is the whole change needed.
3. **`prod-workers` does not help.** Adding `worker-src 'self' blob:` changes
   nothing — the violation is a script-src (wasm-compile) question, not a
   worker question. The relaxed policy needs no worker-src change.
4. **WebGPU inherits the CSP problem.** The webgpu backend fails under `prod`
   with the identical WebAssembly violation — ort still compiles WASM in
   process regardless of `device: 'webgpu'`. `'wasm-unsafe-eval'` is a
   precondition for the WebGPU lane too.

Decision for Phase 2 (pending the manifest gate): add `'wasm-unsafe-eval'` to
`script-src` in the extension's `content_security_policy.extension_pages`.
That is the minimal change that makes the chosen STT path run. The store
review implication (why the policy is relaxed) belongs in the packaging gate.

## Bundle size and store implications

Measured assets (the extension would bundle all of these locally):

| asset | size |
|---|---|
| `Xenova/whisper-base` q8 model (dir) | 78 MB |
| — onnx decoder (quantized) | 52 MB |
| — onnx encoder (quantized) | 23 MB |
| — tokenizer/vocab/merges/config | ~4 MB |
| ort WASM (simd-threaded) + mjs | 11.8 MB |
| ort WebGPU jsep wasm + mjs | 23.7 MB |
| `transformers.web.min.js` | 422 KB |

WASM-only bundle ≈ 90 MB; with the WebGPU jsep wasm ≈ 115 MB. Zipped size
untested (quantized onnx compresses modestly), and the exact number is a
packaging-gate measurement — but even the unzipped WASM-only figure fits the
legacy 100 MB store band and the store's current limit. The model dominates;
any future size fight is about the model, not the runtime.

The benchmark served everything from a same-origin fixture approximating
`extension://`; nothing in the run depended on cross-origin fetches
(`blockedExternal = 0`), so in-package model serving is consistent with the
measured numbers.

## Gate verdict (plan-v2 #2)

- "Whisper WebGPU realtime on mid hardware": **not answered by this run** —
  no hardware adapter was available. The residual below requires a real,
  idle adapter.
- Whisper WASM realtime on mid hardware: **answered yes** — RTF 0.26–0.32 at
  single thread on a 2016-class CPU-bound path, plus word timestamps that
  pass the sanity checks. The lib-10 STT choice is implementable; the
  `'wasm-unsafe-eval'` CSP change is the price of admission.

## Residuals for real-Chrome verification

1. **Offscreen audio path** (plan-v3 gate a, still open): streamId →
   getUserMedia → AudioContext in the offscreen document, with the relaxed
   CSP applied. The benchmark proves transcription in a fixture page; it does
   not prove the offscreen capture wiring in real Chrome.
2. **Real extension page**: load the built extension and confirm the relaxed
   `extension_pages` policy passes the same `WebAssembly.compile` probe in
   Chrome proper (the fixture origin is an approximation).
3. **WebGPU on an idle adapter**: rerun the `webgpu` variants with an
   uncontended hardware adapter to close plan-v2 #2; the SwiftShader numeric
   errors are not evidence either way.
4. **Zipped store size** for the ~90 MB WASM-only bundle, at the packaging
   gate.

## Tooling notes

- `bun run scripts/bench-whisper.ts --download` fetches model + clips once;
  timed runs are fully local (route-blocked).
- `bun run scripts/bench-whisper.ts --variant=wasm:relaxed:none --out=…` runs
  one combo in its own process; the orchestrator form runs all combos
  sequentially with per-variant SIGKILL caps.
- The `@huggingface/transformers` devDependency is pinned alongside its
  node-only transitive deps via `package.json` overrides: `adm-zip 0.6.0`,
  `sharp 0.35.3`, `onnxruntime-web 1.23.0` (aislop findings on the versions
  transformers requests). `onnxruntime-node` is not used by the benchmark —
  the browser build runs under Playwright — but pruning it would drop the
  `dist` assets the benchmark serves, so pinning is the chosen resolution.
- `ffmpeg` (system binary) is used only by the `--download` step for FLAC→f32
  decoding and is allowlisted in `knip.json` (`ignoreBinaries`); timed runs
  never invoke it.

## WebGPU re-check on hardware (one-time, user machine)

The August run measured no real adapter: every WebGPU attempt — including
`gpu=hardware` — reported `adapter:google|swiftshader` (see
[WebGPU attempt](#webgpu-attempt)). The harness now ships the switches a
hardware attempt needs, so the plan-v2 #2 question can be closed with one run
on a box that has a reachable GPU.

### What changed in the harness

`launchArgs` in `scripts/bench-whisper-page.ts` appends four switches to the
`hardware` attempt (webgpu backend, `--gpu=hardware`):

- `--use-angle=vulkan` — pin the GPU process to the real Vulkan stack instead
  of falling back to software rendering
- `--ignore-gpu-blocklist` — keep the GTX 1070 off Chromium's blocklist
- `--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist` —
  grant the unsafe APIs (without which `adapter.info` is blanked and the
  probe cannot name the adapter) and unblock Dawn's own adapter blocklist
- `--disable-dawn-features=disallow_unsafe_apis` — cancel Dawn's adapter veto

The `swiftshader` variant is untouched (`--use-webgpu-adapter=swiftshader`
only) and stays the pure software control. No temp-edits are needed to run
this check — the flags ship in the harness.

### Runbook (user machine, once)

1. **Preflight.** The GPU must be idle and the driver must still support
   Pascal:
   - `nvidia-smi` — utilization near 0 %, driver < 590 (Pascal is dropped
     from driver 590; the check is invalid on 590+)
   - `ls /usr/share/vulkan/icd.d/ | grep -i nvidia` — the NVIDIA Vulkan ICD
     must be present. Without it the GPU process cannot reach the card and
     every WebGPU run silently lands on SwiftShader no matter the flags
     (this is exactly what the shared box does — see
     [This box's outcome](#this-boxs-outcome)).
2. **WASM baseline** (re-measured for a same-day comparison):
   `bun run scripts/bench-whisper.ts --variant=wasm:relaxed:none --clip=0 --out=results-hw.jsonl`
3. **Hardware WebGPU attempt**, headed (headless is not trustworthy for
   adapter selection):
   `bun run scripts/bench-whisper.ts --variant=webgpu:relaxed:hardware --clip=0 --headed --out=results-hw.jsonl`
4. **Mandatory adapter verification** — the gpu probe is the only proof the
   run measured hardware:
   `grep '"gpuAttempt":"hardware"' results-hw.jsonl | grep -o '"gpu":"[^"]*"'`
   Must print `adapter:nvidia|pascal` (case as reported).
   `adapter:google|swiftshader`, `adapter:GPUAdapter` (identity blanked) or
   `no-adapter` invalidates the run: re-check the Vulkan preflight and that
   `--headed` was used.

### Decision rule

WebGPU is worth pursuing only if **all** hold; otherwise close the question
(WASM already passes):

- median `rtf` (webgpu) ≤ 0.6 × median `rtf` (wasm) — 0.6 × of ~0.29 ≈ 0.17
- |median `wer` (webgpu) − median `wer` (wasm)| ≤ 2 (percentage points)
- 0 clip failures (`clipError` set / `rtf: null` on all clips)
- `modelLoadMs` (webgpu) ≤ 2 × `modelLoadMs` (wasm)

Realtime is **not** the discriminator: WASM at RTF 0.29 is already realtime.
The only reason to prefer WebGPU is a large decoder margin — longer clips or
lighter hardware — and that margin is what the 0.6 × rule tests.

### Pitfalls

- **Driver 590+ invalidates the check** — no Pascal support, so the result
  is "can't measure", not "WebGPU loses".
- **Missing NVIDIA Vulkan ICD is the silent-swiftshader trap**: all flags
  pass, the probe still says `google|swiftshader`. Preflight step 1 catches
  it.
- **fp16 errors on Pascal are a data point, not a bug**: Pascal has no
  `shaderFloat16` (fp16 compute), and ort's webgpu ep can require it for
  some kernels. An fp16-related error on the real adapter is evidence the
  GPU is too old for the fast path — record it and close the question.
- **Headless is not trustworthy**: the August run fell to SwiftShader
  headless; use `--headed`.
- **The probe, not the summary, decides**: the printed summary shows RTF
  numbers regardless of which adapter ran. Only the `gpu` field says what
  was measured.

### This box's outcome (2026-08-12)

Ran the swiftshader control and the hardware attempt (1 clip, smoke) after
the flag change, with the GPU idle (nvidia-smi: 0 %, driver 582.53):

| variant | probe gpu | model load | clip result |
|---|---|---|---|
| `webgpu:relaxed:swiftshader` | `adapter:google|swiftshader` | 2073 ms | error 157381320 (unchanged from August run) |
| `webgpu:relaxed:hardware` (headless) | `adapter:google|swiftshader` | 2768 ms | error 157381320 |
| `webgpu:relaxed:hardware` (headed) | `adapter:google|swiftshader` | 2061 ms | error 157381320 |

Captured browser cmdline during the run: all four switches plus
`--use-angle=vulkan` reach Chromium, and no `--use-angle=swiftshader-webgl`
is present — yet the adapter is still SwiftShader. Cause: this box has no
NVIDIA Vulkan ICD (`/usr/share/vulkan/icd.d/` holds only
asahi/gfxstream/intel/lvp/nouveau/radeon/virtio), so the GPU process cannot
enumerate the GTX 1070 for Vulkan and falls back to software rendering
regardless of flags. The harness behavior is verified — flags transmit, the
probe names the adapter, the swiftshader control is unchanged; the hardware
verdict needs the user machine, where the runbook above applies.

### Gate-3 note (manual-gates runbook)

`docs/manual-gates-runbook.md` (wt-tc lane) will reference this section for
its gate-3 WebGPU procedure; that runbook's merge is owned by the wt-tc lane.
