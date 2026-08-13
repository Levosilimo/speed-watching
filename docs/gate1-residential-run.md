# Gate 1 — Residential timedtext re-run (one command)

Automates the WEB half of `docs/manual-gates-runbook.md` gate 1: the primary
WEB caption path (the player's own signed `/api/timedtext` request) re-run
from a **residential IP**. The datacenter box proved the ANDROID path
(17/17) and the WEB path from an IP where POT was blocked; this run is the
last hard pre-submission gate that needs a non-datacenter network.

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
| `--headless` | override the headed default (persistent-context runs save state to `~/.speedwatcher-gate1` and reuse it next run) |

## What it does per video

1. Loads the watch page in the installed CfT Chromium (persistent context,
   consent cookies pre-seeded), reads `ytInitialPlayerResponse` track
   metadata.
2. Toggles captions on and **re-picks the ASR track** from the CC settings
   menu — the default CC track is often a manual transcript without word
   timing, so `auto-generated/English` is chosen explicitly.
3. **Intercepts the player's own `/api/timedtext` response** via
   `page.on('response')` (no fresh `baseUrl` fetch — the player's URL is
   POT-signed and bound to the video; a script fetch is not representative).
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
| `pot-fail` | no/empty timedtext, or a payload with no word-timing structures | POT/IP access — fresh-session re-run, then the runbook escalation |
| `parse-fail` | timing structures present but words === 0 | **hard fail** — parser bug |

## Pass / fail

Exit code **0** when ≥ 90% of ASR-bearing videos yield word timing and there
is **zero** `parse-fail`; exit code **1** otherwise. The console table and
`scripts/data/gate1-residential/results.jsonl` stratify every non-passing
video (structural vs POT-access vs parser) with evidence.

Expected on the datacenter box: `pot-fail`/`no-track` classifications and
exit 1 — POT is blocked there, which is exactly why this run exists.
Full procedure, per-video assertions, pause-bias measurement, and the
escalation path: `docs/manual-gates-runbook.md`, gate 1.
