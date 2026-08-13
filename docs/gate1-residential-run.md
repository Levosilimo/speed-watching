# Gate 1 — timedtext re-run (one command)

Automates the WEB half of `docs/manual-gates-runbook.md` gate 1 — the
primary WEB caption path (the player's own signed `/api/timedtext` request)
— as a regression/periodic tool. This is not a first-time gate: the gate
itself PASSED on 2026-08-12 via the landmark re-run
(`docs/phase0-caption-wpm.md` §8, `scripts/sample-captions.ts`): 16/17 =
94.1% of ASR-bearing videos yielded WEB word timing **on this same box**
(WSL2 over a residential Windows 11 line — never a datacenter IP). The
phase-0 bare-`baseUrl` WEB failures were a missing player-signed POT
context, not IP class; this runner intercepts the player's own request and
sees the healthy path.

## Run

From the repo checkout **on the residential machine** (root of a checkout,
not inside this docs folder):

```bash
bun install --frozen-lockfile   # if node_modules is missing
bun run scripts/gate1-residential.ts
```

Flags:

| Flag | Meaning |
|---|---|
| `--limit N` | smoke run: sample the first N videos only |
| `--video=ID` | sample one video |
| `--headless` | override the default (headed). Runs in a plain browser context — the former persistent profile (`~/.speedwatcher-gate1`) made YouTube serve degraded no-word-timing ASR payloads to that session and is no longer used |

## What it does per video

1. Loads the watch page in the installed CfT Chromium (plain context,
   consent cookies pre-seeded), reads `ytInitialPlayerResponse` track
   metadata.
2. Toggles captions on and **re-picks the ASR track** from the CC settings
   menu — the default CC track is often a manual transcript without word
   timing, so `auto-generated/English` is chosen explicitly.
3. **Intercepts the player's own `/api/timedtext` response** via
   `page.on('response')` (no fresh `baseUrl` fetch — the player's URL is
   POT-signed and bound to the video; a script fetch is not representative).
   After the ASR re-pick it waits for a fresh capture that carries word
   timing: the first response to a re-issued request is often a degraded
   no-timing variant, with the full payload landing on a follow-up request.
4. Parses the payload with the production parser
   (`lib/captions.ts` `parseYouTubeJson3`) and records: word count,
   windows==segs parity (when the payload carries both layouts), cue count,
   languageCode, and a transcript sample.

## What it proves

- The POT-aware WEB caption path works from a residential IP — the request
  `entrypoints/content.ts` relies on.
- Word-level timing parsing on **real** payloads — until now only proven on
  the synthetic fixture (`tests/fixtures/synthetic/windows-format.json`).
- The ASR track re-pick survives the settings menu.

## Classification (runbook vocabulary)

| Class | Meaning | Verdict |
|---|---|---|
| `web-ok` | words > 0 AND cues > 0 from the intercepted payload | pass |
| `no-track` | no captionTracks or manual-only tracks | structural — excluded from the ASR denominator |
| `pot-fail` | no/empty timedtext, or a payload with no word-timing structures after the word-timed wait | request-stage/session degradation — fresh-session re-run, then the runbook escalation; a persistent-profile session can get degraded-only service (the 2026-08-12 smoke's false pot-fail) |
| `parse-fail` | timing structures present but words === 0 | **hard fail** — parser bug |

## Pass / fail

Exit code **0** when ≥ 90% of ASR-bearing videos yield word timing and there
is **zero** `parse-fail`; exit code **1** otherwise. The console table and
`scripts/data/gate1-residential/results.jsonl` stratify every non-passing
video (structural vs POT-access vs parser) with evidence.

## Status

- **2026-08-12 smoke run**: `iG9CE55wbtY` classified `pot-fail`
  (`no-word-timing-in-payload`, cues=298, `kind=asr`, POT-signed request).
  Root-caused on 2026-08-13: not IP class, not the video, not the parser —
  the runner used a persistent profile (`~/.speedwatcher-gate1`) whose
  session YouTube served degraded ASR payloads to (no word timing ever,
  even in a pristine copy of the profile), and it latched the first
  post-repick response, which is often the degraded variant before the
  word-timed follow-up request lands. Both defects were fixed in this
  script (plain context + word-timed wait with one playback nudge and a
  menu retry).
- **2026-08-13 regression re-run** on the landmark's web-ok set: 5/5
  `web-ok`, word/cue counts identical to the landmark
  (`iG9CE55wbtY` 2745/584, `Ks-_Mh1QhMc` 3297/535, `HtSuA80QTyo` 5907/933,
  `jGwO_UgTS7I` 10739/2083, `aircAruvnKk` 2867/500) — see
  `scripts/data/gate1-residential/results.jsonl`. The landmark harness
  (`scripts/sample-captions.ts`) re-ran the same five videos the same day
  with identical results, confirming the WEB path itself is healthy.

Full procedure, per-video assertions, pause-bias measurement, and the
escalation path: `docs/manual-gates-runbook.md`, gate 1.
